// Agent Farm — Claude Code ajanlarını Stardew Valley tarzı bir çiftlikte canlı izleyen yerel sunucu.
// Sıfır bağımlılık. Yalnızca OKUR: ~/.claude/agents (roster) ve ~/.claude/projects (oturum/alt ajan kayıtları).
// Çalıştırma: node server.mjs  →  http://localhost:4747
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { extra } from "./lib/extra.mjs";
import { CFG } from "./lib/config.mjs";

const HOME = os.homedir();
const AGENTS_DIR = path.join(HOME, ".claude", "agents");
const PROJECTS_DIR = path.join(HOME, ".claude", "projects");
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
const PORT = Number(process.env.PORT) || 4747;
const LAN_MODE = Boolean(process.env.FARM_PIN) && (process.env.FARM_HOST || "127.0.0.1") !== "127.0.0.1";
// Varsayılan yalnızca bu bilgisayar. Telefondan (aynı Wi-Fi) izlemek için: FARM_HOST=0.0.0.0 FARM_PIN=1234 node server.mjs
const HOST = process.env.FARM_HOST || "127.0.0.1";
if (HOST !== "127.0.0.1" && !/^\d{6,}$|^.{8,}$/.test(process.env.FARM_PIN || "")) { console.error("FARM_HOST ayarlıyken en az 6 haneli FARM_PIN (ya da 8+ karakterli parola) zorunlu."); process.exit(1); }
const MEET_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "meetings");
const HANDOFF_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "handoff");
const MEMORY_PENDING = CFG.memoryFile;
// Gerçek kayıtlardan: "You've hit your session limit · resets 9:10am (Europe/Istanbul)", "Usage limit reached · continuing automatically at 8:40pm", HTTP 429 rate_limit
const LIMIT_RE = /(hit your [a-z ]{0,30}limit|usage limit reached|limit reached|error type rate_limit|HTTP 429)/i;
const SHIFTS_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "config", "shifts.json");
const WORKING_MS = 45_000; // son kayıt bu kadar yeniyse "çalışıyor"
const RECENT_MS = 30 * 60_000; // bu kadar yeniyse "yeni bitti / bekliyor"
const SCAN_WINDOW_MS = 24 * 3600_000; // bundan eski oturumlara hiç bakılmaz

// Bölüm: dosya adı ön ekinden. Küçük bölümler birleştirilir (çiftlikte ~12 tarla).
const DIVISION_OF = (slug) => {
  const p = slug.split("-")[0];
  if (["seo", "blog"].includes(p)) return "SEO & Blog";
  if (["game", "unreal", "unity", "godot", "roblox", "xr", "blender", "narrative", "level", "economy", "technical"].includes(p)) return "Oyun & XR";
  if (["paid"].includes(p)) return "Reklam";
  if (["project", "product", "agents", "studio", "sprint", "workflow", "senior"].includes(p)) return "Proje & Ürün";
  if (["support", "customer", "hospitality", "retail", "account", "hr", "legal", "compliance", "recruitment", "corporate", "change", "organizational"].includes(p)) return "Destek & İnsan";
  const map = { engineering: "Mühendislik", marketing: "Pazarlama", security: "Güvenlik", sales: "Satış", design: "Tasarım", testing: "Test", specialized: "Özel" };
  return map[p] ?? "Diğer";
};

function parseFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  const out = {};
  if (!m) return out;
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, "").trim();
  }
  return out;
}

function loadRoster() {
  let files = [];
  try { files = fs.readdirSync(AGENTS_DIR).filter((f) => f.endsWith(".md")); } catch { /* klasör yok */ }
  return files.map((f) => {
    const slug = f.replace(/\.md$/, "");
    let fm = {};
    try { fm = parseFrontmatter(fs.readFileSync(path.join(AGENTS_DIR, f), "utf8")); } catch { /* okunamadı */ }
    return {
      slug,
      name: fm.name || slug,
      description: (fm.description || "").slice(0, 220),
      color: /^#[0-9a-f]{6}$/i.test(fm.color || "") ? fm.color : "#e0a030",
      emoji: fm.emoji || "🌱",
      division: DIVISION_OF(slug),
    };
  }).sort((a, b) => a.division.localeCompare(b.division) || a.name.localeCompare(b.name));
}

// Dosyanın sonundan okur (büyük kayıtlarda tümünü okumayalım).
function readTail(file, bytes = 96 * 1024) {
  try {
    const fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    return buf.toString("utf8").split("\n").slice(size > len ? 1 : 0);
  } catch { return []; }
}

function summarizeToolUse(block) {
  const i = block.input || {};
  const hint = i.command || i.file_path || i.pattern || i.description || i.url || i.query || i.skill || i.subagent_type || "";
  return { tool: block.name, hint: String(hint).replace(/\s+/g, " ").slice(0, 90) };
}

function analyzeTail(file) {
  let title = null, lastTool = null, lastText = null, lastTs = null, cwd = null, limited = false, limitText = null, lastAssistant = null;
  for (const line of readTail(file)) {
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === "custom-title" && o.customTitle) title = o.customTitle;
    if (o.timestamp) lastTs = o.timestamp;
    if (o.cwd) cwd = o.cwd;
    const content = o.message && Array.isArray(o.message.content) ? o.message.content : [];
    if (o.type === "assistant") {
      let hasTool = false;
      for (const b of content) {
        if (b.type === "tool_use") { lastTool = summarizeToolUse(b); hasTool = true; }
        else if (b.type === "text" && b.text) {
          lastText = b.text.replace(/\s+/g, " ").slice(0, 140);
          lastAssistant = b.text.replace(/\s+/g, " ").slice(0, 600);
          if (LIMIT_RE.test(b.text) && (o.isApiErrorMessage || b.text.length < 300)) { limited = true; limitText = b.text.replace(/\s+/g, " ").slice(0, 200); }
          else { limited = false; limitText = null; }
        }
      }
      if (hasTool) { limited = false; limitText = null; } // limit sonrası iş devam ettiyse temizle
    }
  }
  return { title, lastTool, lastText, lastTs, cwd, limited, limitText, lastAssistant };
}

function prettyProject(dirName) {
  const parts = dirName.replace(/^-Users-[^-]+-/, "").split("-").filter(Boolean);
  const tail = parts.slice(-2).join("/");
  return tail.length > 28 ? "…" + tail.slice(-27) : tail || dirName;
}

function scan(roster) {
  const now = Date.now();
  const byKey = new Map();
  for (const r of roster) { byKey.set(r.name.toLowerCase(), r.slug); byKey.set(r.slug.toLowerCase(), r.slug); }
  const sessions = [], subagents = [];
  let projects = [];
  try { projects = fs.readdirSync(PROJECTS_DIR); } catch { /* yok */ }
  for (const proj of projects) {
    const dir = path.join(PROJECTS_DIR, proj);
    let entries; try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const e of entries) {
      if (!e.endsWith(".jsonl")) continue;
      const file = path.join(dir, e);
      let st; try { st = fs.statSync(file); } catch { continue; }
      const age = now - st.mtimeMs;
      if (age > SCAN_WINDOW_MS) continue;
      const id = e.replace(/\.jsonl$/, "");
      const a = analyzeTail(file);
      sessions.push({
        id, project: prettyProject(proj), title: a.title || prettyProject(proj),
        state: age < WORKING_MS ? "working" : age < RECENT_MS ? "waiting" : "sleeping",
        ageSec: Math.round(age / 1000), lastTool: a.lastTool, lastText: a.lastText,
        cwd: a.cwd, limited: a.limited && age < 6 * 3600_000, limitText: a.limitText, lastAssistant: a.lastAssistant,
      });
      const subDir = path.join(dir, id, "subagents");
      let subs = []; try { subs = fs.readdirSync(subDir).filter((f) => f.endsWith(".meta.json")); } catch { /* alt ajan yok */ }
      for (const m of subs) {
        const base = m.replace(/\.meta\.json$/, "");
        const jf = path.join(subDir, base + ".jsonl");
        let jst; try { jst = fs.statSync(jf); } catch { continue; }
        const sage = now - jst.mtimeMs;
        if (sage > SCAN_WINDOW_MS) continue;
        let meta = {}; try { meta = JSON.parse(fs.readFileSync(path.join(subDir, m), "utf8")); } catch { /* bozuk */ }
        const type = meta.agentType || "general-purpose";
        const sa = sage < RECENT_MS ? analyzeTail(jf) : {};
        subagents.push({
          id: base, parent: id, agentType: type, slug: byKey.get(String(type).toLowerCase()) || null,
          description: meta.description || "", lastText: sa.lastText || null, state: sage < WORKING_MS ? "working" : sage < RECENT_MS ? "recent" : "done",
          ageSec: Math.round(sage / 1000), lastTool: sa.lastTool || null,
        });
      }
    }
  }
  sessions.sort((a, b) => a.ageSec - b.ageSec);
  subagents.sort((a, b) => a.ageSec - b.ageSec);
  return { sessions: sessions.slice(0, 40), subagents: subagents.slice(0, 120) };
}

// Şu an mesaide olan ajanlar (yerel saate göre). Dosya yoksa/bozuksa kimse "mesaide" sayılmaz.
function dutyNow(roster) {
  let cfg; try { cfg = JSON.parse(fs.readFileSync(SHIFTS_FILE, "utf8")); } catch { return { shifts: [], onDuty: [] }; }
  const d = new Date();
  const day = d.getDay() === 0 ? 7 : d.getDay();
  const mins = d.getHours() * 60 + d.getMinutes();
  const toMin = (hhmm) => { const [h, m] = String(hhmm).split(":").map(Number); return h * 60 + (m || 0); };
  const active = (cfg.shifts || []).filter((s) => (s.days || [1, 2, 3, 4, 5, 6, 7]).includes(day) && mins >= toMin(s.from) && mins < toMin(s.to));
  const names = new Set();
  for (const s of active) for (const w of s.who || []) names.add(String(w).toLowerCase());
  const onDuty = roster.filter((r) => names.has(r.division.toLowerCase()) || names.has(r.name.toLowerCase()) || names.has(r.slug.toLowerCase())).map((r) => r.slug);
  return { shifts: active.map((s) => ({ name: s.name, from: s.from, to: s.to })), onDuty };
}

// "resets 9:10am (Europe/Istanbul)" → bir sonraki o saat (makine saat dilimi İstanbul varsayılır)
function parseReset(text) {
  const m = String(text || "").match(/(?:resets?|automatically at)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
  if (!m) return null;
  let h = Number(m[1]) % 12; if (m[3].toLowerCase() === "pm") h += 12;
  const d = new Date(); d.setHours(h, Number(m[2] || 0), 0, 0);
  if (d.getTime() < Date.now()) d.setDate(d.getDate() + 1);
  return d.toISOString();
}
function detectLimit(sessions) {
  const hit = sessions.filter((s) => s.limited).sort((a, b) => a.ageSec - b.ageSec)[0];
  if (!hit) return null;
  return { text: hit.limitText, session: hit.title, resetsAt: parseReset(hit.limitText), key: hit.id + ":" + Math.floor(hit.ageSec / 600) };
}
function git(cwd, args) { try { return execFileSync("git", args, { cwd, timeout: 4000, encoding: "utf8" }).trim(); } catch { return ""; } }

function writeHandoff(reason, state) {
  fs.mkdirSync(HANDOFF_DIR, { recursive: true });
  const now = new Date();
  const stamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const sessions = (state.sessions || []).filter((s) => s.state !== "sleeping" || s.limited).slice(0, 8);
  const subs = (state.subagents || []).filter((s) => s.state !== "done").slice(0, 12);
  let pending = ""; try { pending = fs.readFileSync(MEMORY_PENDING, "utf8").replace(/^---[\s\S]*?---\n/, ""); } catch { /* yok */ }
  const dirs = [...new Set(sessions.map((s) => s.cwd).filter(Boolean))];
  const md = [
    `# Devir notu — ${now.toLocaleString("tr-TR")}`,
    ``,
    `**Neden yazıldı:** ${reason}`,
    state.limit ? `**Claude limiti:** ${state.limit.text || "limit doldu"}${state.limit.resetsAt ? ` (sıfırlanma: ${new Date(state.limit.resetsAt).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" })})` : ""}` : "",
    ``,
    `## Başka bir yapay zekaya yapıştırılacak komut`,
    "```",
    `Sen ${CFG.company} için çalışan proje asistanısın. Türkçe yaz. Önce şu dosyaları OKU, varsayım üretme:`,
    ...CFG.briefFiles.map((f) => `- ${f}`),
    ...(CFG.redLines ? [`- Kırmızı çizgiler: ${CFG.redLines}`] : []),
    `- Bu devir notunun tamamı (aşağıda)`,
    `Sonra aşağıdaki "Açık işler"den kaldığı yerden devam et. Üretimi etkileyen adımlarda (deploy, DNS, GTM yayınlama, e-posta gönderimi) yapmadan önce kullanıcıya sor.`,
    "```",
    ``,
    `## Açık işler (Claude hafızasından)`,
    pending.trim() || "_hafıza dosyası okunamadı_",
    ``,
    `## Terminaller (son durum)`,
    ...sessions.map((s) => `- **${s.title}** — ${s.project} · ${s.state}${s.limited ? " · LİMİT" : ""}\n  - son araç: ${s.lastTool ? s.lastTool.tool + " " + s.lastTool.hint : "—"}\n  - son söz: ${s.lastAssistant || s.lastText || "—"}`),
    ``,
    `## Çalışan / yeni biten alt ajanlar`,
    ...(subs.length ? subs.map((s) => `- ${s.agentType} — ${s.description || "(görev açıklaması yok)"} · ${s.state}`) : ["- (yok)"]),
    ``,
    `## Git durumu`,
    ...dirs.map((d) => `### ${d}\n\`\`\`\n${git(d, ["status", "--short"]).split("\n").slice(0, 15).join("\n") || "(temiz)"}\n\n${git(d, ["log", "--oneline", "-5"])}\n\`\`\``),
    ``,
  ].filter((x) => x !== undefined).join("\n");
  const file = path.join(HANDOFF_DIR, `HANDOFF-${stamp}.md`);
  fs.writeFileSync(file, md);
  fs.writeFileSync(path.join(HANDOFF_DIR, "LATEST.md"), md);
  return { file, latest: path.join(HANDOFF_DIR, "LATEST.md"), at: now.toISOString() };
}
let lastLimitKey = null, lastHandoff = null;
// Devir notu + (ayarlıysa) Claude hafıza dizinine tek bir "devir" hafıza dosyası. Aynı sebep 10 dk içinde tekrar yazılmaz.
const noteAt = new Map();
function writeNote(reason) {
  const k = reason.slice(0, 20), now = Date.now();
  if (now - (noteAt.get(k) || 0) < 600_000) return; noteAt.set(k, now);
  try { lastHandoff = writeHandoff(reason, lastState); } catch (e) { console.error("devir notu yazılamadı:", e.message); }
  try { writeMemory(reason, lastState); } catch (e) { console.error("hafıza yazılamadı:", e.message); }
}
function writeMemory(reason, st) {
  if (!CFG.memoryDir) return;
  fs.mkdirSync(CFG.memoryDir, { recursive: true });
  const open = (st.today || []).filter((i) => !i.done).slice(0, 10).map((i) => `- ${i.text}`);
  const terms = (st.sessions || []).filter((s) => s.state !== "sleeping").slice(0, 8).map((s) => `- ${s.title} (${s.project}) · ${s.state}`);
  const body = ["---", "name: agent-farm-devir", "description: Ofis panelinin otomatik yazdığı son devir notu (limit/internet kesintisi)", "metadata:", "  type: project", "---", "",
    `Son olay: **${reason}** — ${new Date().toLocaleString("tr-TR")}`,
    st.limit ? `Claude limiti: ${st.limit.text || "doldu"}${st.limit.resetsAt ? ` (sıfırlanma ${new Date(st.limit.resetsAt).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" })})` : ""}` : "Claude limiti: algılanmadı",
    `İnternet: ${st.net?.online === false ? "KOPUK" : "var"}`, "",
    "**Bugün listesinde açık işler:**", ...(open.length ? open : ["- (yok)"]), "",
    "**Açık terminaller:**", ...(terms.length ? terms : ["- (yok)"]), "",
    `**How to apply:** yeni oturumda önce \`${path.join(HANDOFF_DIR, "LATEST.md")}\` dosyasını oku, kaldığın yerden devam et. Bu dosya otomatik üzerine yazılır; kalıcı bilgiyi buraya koyma.`, ""].join("\n");
  fs.writeFileSync(path.join(CFG.memoryDir, "project_agent_farm_devir.md"), body);
  const idx = path.join(CFG.memoryDir, "MEMORY.md"), line = "- [Ofis devir notu (otomatik)](project_agent_farm_devir.md) — limit/internet kesintisinde ofis panelinin yazdığı son durum";
  let cur = ""; try { cur = fs.readFileSync(idx, "utf8"); } catch { /* yok */ }
  if (!cur.includes("project_agent_farm_devir.md")) fs.appendFileSync(idx, (cur && !cur.endsWith("\n") ? "\n" : "") + line + "\n");
}

let rosterCache = { at: 0, data: [] };
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png" };

function meetFiles() {
  try {
    return fs.readdirSync(MEET_DIR).filter((f) => f.endsWith(".md")).map((f) => {
      const st = fs.statSync(path.join(MEET_DIR, f));
      const head = fs.readFileSync(path.join(MEET_DIR, f), "utf8").split("\n").find((l) => l.startsWith("# ")) || f;
      return { file: f, title: head.replace(/^#\s*/, ""), mtime: st.mtimeMs };
    }).sort((x, y) => y.mtime - x.mtime).slice(0, 30);
  } catch { return []; }
}
function shelfList() {
  const dir = path.join(HOME, ".claude", "agents-raf");
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith(".md") && !/readme/i.test(f)).map((f) => {
      const slug = f.replace(/\.md$/, ""); let fm = {};
      try { fm = parseFrontmatter(fs.readFileSync(path.join(dir, f), "utf8")); } catch { /* */ }
      return { slug, name: fm.name || slug, division: DIVISION_OF(slug), emoji: fm.emoji || "📦" };
    });
  } catch { return []; }
}
let lastState = { sessions: [], subagents: [], limit: null };
const farmCtx = {
  roster: () => { if (Date.now() - rosterCache.at > 60_000) rosterCache = { at: Date.now(), data: loadRoster() }; return rosterCache.data; },
  state: () => lastState, meetFiles, shelfList, invalidate: () => { rosterCache.at = 0; },
};
extra.init({ limitActive: () => Boolean(lastState.limit), state: () => lastState, meetFiles, writeNote });

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  // Güvenlik başlıkları: çerçeveleme, MIME sezgisi ve dış kaynak yükleme kapalı.
  res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("X-Frame-Options", "DENY"); res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  // Yerel modda yalnızca localhost Host'u kabul edilir: DNS rebinding ile tarayıcıdan veri okunamaz.
  if (!LAN_MODE && !/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(req.headers.host || "")) { res.writeHead(403); return res.end(); }
  if (extra.gate(req, res, url)) return;
  if (await extra.handle(req, res, url, farmCtx)) return;
  if (url.pathname === "/api/state") {
    if (Date.now() - rosterCache.at > 60_000) rosterCache = { at: Date.now(), data: loadRoster() };
    const st = { now: Date.now(), roster: rosterCache.data, ...dutyNow(rosterCache.data), ...scan(rosterCache.data) };
    try { st.shelved = fs.readdirSync(path.join(HOME, ".claude", "agents-raf")).filter((f) => f.endsWith(".md") && !/readme/i.test(f)).length; } catch { st.shelved = 0; }
    st.limit = detectLimit(st.sessions);
    // Limit YENİ görüldüyse devir notunu bir kez otomatik yaz
    if (st.limit && st.limit.key !== lastLimitKey) { lastLimitKey = st.limit.key; try { writeNote("Claude limiti algılandı"); } catch (e) { console.error("devir notu yazılamadı", e.message); } }
    if (!st.limit) lastLimitKey = null;
    st.handoff = lastHandoff;
    lastState = st;
    Object.assign(st, extra.stateFragment(st, meetFiles));
    // oturum gövdelerini küçült (devir notu için gerekenler API'de gereksiz)
    st.sessions = st.sessions.map(({ lastAssistant, ...r }) => r);
    const body = JSON.stringify(st);
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    return res.end(body);
  }
  const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host || "");
  if (url.pathname === "/api/handoff" && req.method === "POST") {
    if (!local) { res.writeHead(403); return res.end(); }
    if (Date.now() - rosterCache.at > 60_000) rosterCache = { at: Date.now(), data: loadRoster() };
    const st = { roster: rosterCache.data, ...scan(rosterCache.data) };
    st.limit = detectLimit(st.sessions);
    try { lastHandoff = writeHandoff("elle istendi", st); res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify(lastHandoff)); }
    catch (e) { res.writeHead(500); return res.end(String(e.message)); }
  }
  if (url.pathname === "/api/handoff/latest") {
    try { const text = fs.readFileSync(path.join(HANDOFF_DIR, "LATEST.md"), "utf8"); res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ text })); }
    catch { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ text: "" })); }
  }
  const MEET_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "meetings");
  if (url.pathname === "/api/meetings") {
    let list = [];
    try {
      list = fs.readdirSync(MEET_DIR).filter((f) => f.endsWith(".md")).map((f) => {
        const st = fs.statSync(path.join(MEET_DIR, f));
        const head = fs.readFileSync(path.join(MEET_DIR, f), "utf8").split("\n").find((l) => l.startsWith("# ")) || f;
        return { file: f, title: head.replace(/^#\s*/, ""), mtime: st.mtimeMs };
      }).sort((x, y) => y.mtime - x.mtime).slice(0, 30);
    } catch { /* klasör boş */ }
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    return res.end(JSON.stringify(list));
  }
  if (url.pathname.startsWith("/api/meetings/")) {
    const f = path.basename(decodeURIComponent(url.pathname.slice("/api/meetings/".length)));
    if (!/^[\w.-]+\.md$/.test(f)) { res.writeHead(400); return res.end(); }
    try { const text = fs.readFileSync(path.join(MEET_DIR, f), "utf8"); res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ text })); }
    catch { res.writeHead(404); return res.end(); }
  }
  let rel; try { rel = decodeURIComponent(url.pathname); } catch { res.writeHead(400); return res.end(); }
  if (rel.includes("\0")) { res.writeHead(400); return res.end(); }
  const file = path.resolve(PUBLIC_DIR, "." + path.posix.normalize("/" + (rel === "/" ? "index.html" : rel)));
  if (!file.startsWith(PUBLIC_DIR + path.sep) || path.basename(file).startsWith(".")) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end("yok"); }
    if (path.basename(file) === "index.html") data = Buffer.from(data.toString("utf8").replace(/__COMPANY__/g, CFG.company).replace(/__OWNER__/g, CFG.owner).replace(/__ASSISTANT__/g, CFG.assistant));
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
}).listen(PORT, HOST, () => console.log(`Agent Farm hazır → http://localhost:${PORT}${HOST !== "127.0.0.1" ? " (ağda, PIN korumalı)" : ""}`));
