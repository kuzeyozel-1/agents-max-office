// Agent Farm ek modülleri: internet/site izleme, gündem akışı, bugün listesi, hedefler, LinkedIn, ajan aç-kapa,
// komut kutusu (asistan) ve günlük pazar radarı. Sıfır bağımlılık. Yazdığı yer: ./data, ./gundem (kendi klasörü) ve
// kullanıcı onayıyla ~/.claude/agents <-> agents-raf taşıma.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { CFG } from "./config.mjs";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "data");
const RADAR_DIR = path.join(ROOT, "gundem");
const HOME = os.homedir();
const AGENTS_DIR = path.join(HOME, ".claude", "agents");
const SHELF_DIR = path.join(HOME, ".claude", "agents-raf");
const MEMORY_PENDING = CFG.memoryFile;
const PROJECT_DIR = CFG.projectDir;
const SITE = CFG.siteUrl;
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(RADAR_DIR, { recursive: true });

const rj = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(DATA, f), "utf8")); } catch { return d; } };
const wj = (f, v) => fs.writeFileSync(path.join(DATA, f), JSON.stringify(v, null, 1));
const nowTR = () => new Date().toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" });
const env = () => ({ ...process.env, PATH: [path.join(HOME, ".local", "bin"), path.join(HOME, ".npm-global", "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", process.env.PATH || ""].join(":") });

// ---------- olaylar (sunucu tarafı, sayfa yenilense de kalır) ----------
let events = rj("events.json", []);
export function pushEvent(level, text) {
  events.unshift({ at: Date.now(), level, text });
  events = events.slice(0, 120);
  try { wj("events.json", events); } catch { /* disk dolu olabilir */ }
}

// ---------- güvenlik: yazma uçları için jeton + yerel Host ----------
const TOKEN = crypto.randomBytes(16).toString("hex");
const hostLocal = (req) => /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host || "");
const LAN = Boolean(process.env.FARM_PIN) && (process.env.FARM_HOST || "127.0.0.1") !== "127.0.0.1";
const cookieOf = (req, name) => (req.headers.cookie || "").split(/;\s*/).map((c) => c.split("=")).find(([k]) => k === name)?.[1];
// PIN'in kendisi ya da türevi çerezde durmaz: giriş başarılıysa rastgele, süreli bir oturum kimliği verilir.
const sessions = new Map(); // id -> bitiş zamanı
const attempts = new Map(); // ip -> { n, until }
const SESSION_MS = 12 * 3600e3, MAX_TRIES = 5, LOCK_MS = 15 * 60e3;
const sha = (v) => crypto.createHash("sha256").update(String(v)).digest();
const pinOk = (pin) => crypto.timingSafeEqual(sha(pin ?? ""), sha(process.env.FARM_PIN ?? ""));
const hasSession = (req) => { const id = cookieOf(req, "farm"); const exp = id && sessions.get(id); if (!exp) return false; if (exp < Date.now()) { sessions.delete(id); return false; } return true; };
const ipOf = (req) => req.socket.remoteAddress || "?";
setInterval(() => { const now = Date.now(); for (const [k, v] of sessions) if (v < now) sessions.delete(k); for (const [k, v] of attempts) if (v.until && v.until < now) attempts.delete(k); }, 60_000).unref();
function authed(req) { return (LAN || hostLocal(req)) && req.headers["x-farm-token"] === TOKEN; }

// ---------- internet izleme ----------
const net = { online: true, since: Date.now(), fails: 0, latencyMs: null, lastCheck: 0, outages: rj("outages.json", []), analysis: null };
async function checkNet() {
  let ok = false;
  try { const t = Date.now(); const r = await fetch("https://www.gstatic.com/generate_204", { signal: AbortSignal.timeout(4000), cache: "no-store" }); ok = r.status === 204 || r.ok; net.latencyMs = Date.now() - t; } catch { ok = false; }
  net.lastCheck = Date.now();
  if (ok) {
    net.fails = 0;
    if (!net.online) {
      const o = net.outages[0]; if (o && !o.end) o.end = Date.now();
      const mins = o ? Math.max(1, Math.round((o.end - o.start) / 60000)) : 0;
      net.online = true; net.since = Date.now();
      net.analysis = `Bağlantı geri geldi. Kesinti yaklaşık ${mins} dk sürdü; ofis uyanıyor.`;
      pushEvent("info", net.analysis); try { wj("outages.json", net.outages.slice(0, 20)); } catch { /* */ }
      healthTick(true); newsTick(true);
    }
  } else {
    net.fails++;
    if (net.online && net.fails >= 3) {
      net.online = false; net.since = Date.now(); net.outages.unshift({ start: Date.now(), end: null });
      net.analysis = "Bağlantı koptu: ofis uyku moduna geçti. Yerel işler (görev listesi, notlar) çalışır, ajanlar ve gündem bağlantı gelene kadar bekler.";
      pushEvent("warn", "İnternet bağlantısı koptu, ofis uykuya geçti");
    }
  }
}
setInterval(checkNet, 10_000); checkNet();

// ---------- site sağlığı ----------
const PROBES = SITE ? CFG.probes.map((p) => ({ name: p.name, url: SITE + p.path, contains: p.contains })) : [];
const health = { checkedAt: 0, results: [] };
async function healthTick(force = false) {
  if (!net.online && !force) return;
  const results = await Promise.all(PROBES.map(async (p) => {
    const t = Date.now();
    try {
      const r = await fetch(p.url, { signal: AbortSignal.timeout(8000), cache: "no-store", redirect: "follow" });
      let ok = r.status === 200;
      if (ok && p.contains) ok = (await r.text()).includes(p.contains);
      return { name: p.name, ok, status: r.status, ms: Date.now() - t };
    } catch { return { name: p.name, ok: false, status: 0, ms: Date.now() - t }; }
  }));
  for (const r of results) {
    const prev = health.results.find((x) => x.name === r.name);
    if (prev && prev.ok !== r.ok) pushEvent(r.ok ? "info" : "alert", r.ok ? `Site: ${r.name} yeniden çalışıyor` : `⚠ Site: ${r.name} yanıt vermiyor (${r.status || "bağlantı yok"})`);
  }
  health.results = results; health.checkedAt = Date.now();
}
setInterval(() => healthTick(), 90_000); setTimeout(() => healthTick(), 4000);

// ---------- gündem (haber) akışı ----------
const SOURCES_FILE = path.join(ROOT, "config", "sources.json");
const DEFAULT_SOURCES = [
  { cat: "Türkiye", name: "Anadolu Ajansı", url: "https://www.aa.com.tr/tr/rss/default?cat=guncel" },
  { cat: "Türkiye", name: "BBC Türkçe", url: "https://feeds.bbci.co.uk/turkce/rss.xml" },
  { cat: "Türkiye", name: "TRT Haber", url: "https://www.trthaber.com/manset.rss" },
  { cat: "Teknoloji TR", name: "Webrazzi", url: "https://webrazzi.com/feed/" },
  { cat: "Teknoloji TR", name: "ShiftDelete", url: "https://shiftdelete.net/feed" },
  { cat: "Yazılım", name: "Hacker News", url: "https://hnrss.org/frontpage" },
  { cat: "Yazılım", name: "TechCrunch", url: "https://techcrunch.com/feed/" },
  { cat: "Pazarlama/SEO", name: "Search Engine Journal", url: "https://www.searchenginejournal.com/feed/" },
  { cat: "Pazarlama/SEO", name: "Google Search Central", url: "https://feeds.feedburner.com/blogspot/amDG" },
];
if (!fs.existsSync(SOURCES_FILE)) { fs.mkdirSync(path.dirname(SOURCES_FILE), { recursive: true }); fs.writeFileSync(SOURCES_FILE, JSON.stringify({ _not: "Gündem kaynakları (RSS/Atom). Ekleyip çıkarabilirsiniz; 30 dk'da bir yenilenir.", sources: DEFAULT_SOURCES }, null, 1)); }
const news = rj("news.json", { fetchedAt: 0, items: [], status: [] });
const decode = (s) => String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/\s+/g, " ").trim();
function parseFeed(xml, src) {
  const out = [];
  for (const m of xml.matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/g)) {
    const b = m[0];
    const title = decode((b.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1] || "");
    const link = decode((b.match(/<link[^>]*>([^<]+)<\/link>/) || [])[1] || (b.match(/<link[^>]*href="([^"]+)"/) || [])[1] || "");
    const date = (b.match(/<(?:pubDate|updated|published|dc:date)[^>]*>([^<]+)</) || [])[1];
    const ts = date ? Date.parse(date) : NaN;
    if (title && link) out.push({ cat: src.cat, source: src.name, title: title.slice(0, 200), link, ts: Number.isFinite(ts) ? ts : Date.now() });
  }
  return out.slice(0, 8);
}
async function newsTick(force = false) {
  if (!net.online && !force) return;
  let sources = DEFAULT_SOURCES; try { sources = JSON.parse(fs.readFileSync(SOURCES_FILE, "utf8")).sources || DEFAULT_SOURCES; } catch { /* varsayılan */ }
  const status = [], items = [];
  await Promise.all(sources.map(async (s) => {
    try {
      const r = await fetch(s.url, { signal: AbortSignal.timeout(10000), headers: { "user-agent": "Mozilla/5.0 AgentsMaxOffice/1.0", accept: "application/rss+xml, application/atom+xml, text/xml, */*" } });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const got = parseFeed(await r.text(), s); if (!got.length) throw new Error("boş");
      items.push(...got); status.push({ name: s.name, ok: true, n: got.length });
    } catch (e) { status.push({ name: s.name, ok: false, err: String(e.message).slice(0, 60) }); }
  }));
  if (items.length) { news.items = items.sort((a, b) => b.ts - a.ts); news.fetchedAt = Date.now(); }
  news.status = status;
  try { wj("news.json", news); } catch { /* */ }
}
setInterval(() => newsTick(), 30 * 60_000); setTimeout(() => newsTick(), 6000);

// ---------- bugün yapacaklarım, hedefler, LinkedIn ----------
let today = rj("today.json", { items: [] });
const saveToday = () => wj("today.json", today);
const DEFAULT_GOALS = [
  { id: "revenue", title: "Aylık gelir hedefi (₺)", target: null, current: 0, unit: "₺", note: "Hedefi belirleyin; gider tabanı ≈ ₺2.100–2.300/ay" },
  { id: "customers", title: "Kazanılan müşteri (bu ay)", target: 1, current: 0, unit: "müşteri", note: "İlk kazanılan müşteri" },
  { id: "leads", title: "Gelen talep (bu ay)", target: 10, current: 0, unit: "talep", note: "Site formları + LinkedIn + telefon" },
  { id: "linkedin", title: "LinkedIn gönderisi (bu hafta)", target: 3, current: 0, unit: "gönderi", note: "" },
];
let goals = rj("goals.json", DEFAULT_GOALS);
let linkedin = rj("linkedin.json", { url: "", followers: null, impressions7d: null, posts7d: null, updatedAt: null });
let overrides = rj("overrides.json", {});
let settings = rj("settings.json", { radar: { enabled: false, time: "08:30", lastRun: "" } });

function suggestions(meetFiles) {
  const out = [];
  try {
    const mem = fs.readFileSync(MEMORY_PENDING, "utf8");
    const open = mem.split("**Hâlâ AÇIK:**")[1] || "";
    for (const m of open.matchAll(/^- (?:\*\*)?([^\n]{12,160})/gm)) out.push({ text: m[1].replace(/\*\*|`|\[\[|\]\]/g, "").trim(), source: "açık işler" });
  } catch { /* hafıza yok */ }
  try {
    const f = meetFiles()[0]; if (f) {
      const body = fs.readFileSync(path.join(ROOT, "meetings", f.file), "utf8");
      const dec = body.split(/istenen kararlar/i)[1] || "";
      for (const m of dec.matchAll(/^\s*\d+\.\s+([^\n]{10,200})/gm)) out.push({ text: "Karar: " + m[1].trim(), source: f.title });
    }
  } catch { /* toplantı yok */ }
  try {
    const q = JSON.parse(fs.readFileSync(path.join(ROOT, "visual", "queue.json"), "utf8")), inbox = fs.readdirSync(path.join(ROOT, "visual", "inbox")).filter((n) => /\.(png|jpe?g|webp)$/i.test(n));
    if (inbox.length) out.push({ text: `Görsel inbox'ında ${inbox.length} dosya var: "görseller geldi" deyin`, source: "görsel hattı" });
    else if (q.length) out.push({ text: `ChatGPT'de ${q.length} kapak üretin (visual/QUEUE.md)`, source: "görsel hattı" });
  } catch { /* yok */ }
  if (!linkedin.updatedAt || Date.now() - new Date(linkedin.updatedAt) > 7 * 86400e3) out.push({ text: "LinkedIn haftalık metriklerini güncelleyin ve bu hafta 3 gönderi planlayın", source: "LinkedIn" });
  const have = new Set(today.items.map((i) => i.text));
  return out.filter((s) => !have.has(s.text)).slice(0, 8);
}
const addToday = (text, source = "elle") => { const it = { id: crypto.randomBytes(4).toString("hex"), text: String(text).slice(0, 240), done: false, source, createdAt: Date.now() }; today.items.unshift(it); saveToday(); return it; };

// ---------- Asistan özeti (LLM'siz) ----------
function briefing(st, meetFiles) {
  const h = new Date().getHours();
  const hi = h < 6 ? "İyi geceler" : h < 12 ? "Günaydın" : h < 18 ? "İyi günler" : "İyi akşamlar";
  const lines = [`${hi} ${CFG.owner}.`];
  const working = (st.subagents || []).filter((s) => s.state === "working").length;
  let mood = "calm";
  if (st.limit) { lines.push("Claude limiti dolu, ofis dinleniyor."); mood = "sleep"; }
  else if (!net.online) { lines.push("İnternet yok, uykudayız; bağlantı gelince devam."); mood = "sleep"; }
  else if (working) { lines.push(`${working} ajan şu an çalışıyor.`); mood = "busy"; }
  else lines.push("Ofis sakin.");
  const bad = health.results.filter((r) => !r.ok);
  if (health.results.length) { if (bad.length) { lines.push(`⚠ Site: ${bad.map((b) => b.name).join(", ")} erişilemiyor.`); mood = "alert"; } else lines.push(`Site sağlıklı (${health.results.length}/${health.results.length}).`); }
  const open = today.items.filter((i) => !i.done);
  lines.push(open.length ? `Bugün ${open.length} açık işin var${open[0] ? ": " + open[0].text.slice(0, 60) : ""}.` : "Bugünün listesi boş, öneriler var mı bak.");
  const g = goals.find((x) => x.id === "customers"); if (g && g.target) lines.push(`Kazanılan müşteri: ${g.current}/${g.target}.`);
  return { lines, mood, text: lines.join(" ") };
}

// ---------- komutlar ----------
function norm(s) { return String(s).toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/ı/g, "i").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim(); }
function findAgents(q, roster) {
  const n = norm(q); if (!n) return [];
  const exact = roster.filter((r) => r.slug === q.trim() || norm(r.name) === n); if (exact.length) return exact;
  return roster.filter((r) => norm(r.name).includes(n) || r.slug.includes(n.replace(/ /g, "-")));
}
const safeName = (s) => String(s).replace(/[^\p{L}\p{N} &._()-]/gu, "");
function launchTerminal(agent) {
  const cmd = `cd '${PROJECT_DIR.replace(/'/g, "")}' && claude --agent "${safeName(agent.name)}" -n "${safeName(agent.name)}"`;
  spawn("osascript", ["-e", `tell application "Terminal" to do script "${cmd.replace(/"/g, '\\"')}"`, "-e", 'tell application "Terminal" to activate'], { stdio: "ignore", detached: true }).unref();
}
function startMeeting(dept) {
  spawn(path.join(ROOT, "bin", "farm-meeting"), [dept], { cwd: ROOT, env: { ...env(), BUDGET: "1" }, stdio: "ignore", detached: true }).unref();
}
function shelve(slug, on) {
  if (!/^[a-z0-9-]+$/.test(slug)) throw new Error("geçersiz ajan");
  const from = path.join(on ? AGENTS_DIR : SHELF_DIR, slug + ".md"), to = path.join(on ? SHELF_DIR : AGENTS_DIR, slug + ".md");
  if (!fs.existsSync(from)) throw new Error("dosya bulunamadı");
  fs.mkdirSync(path.dirname(to), { recursive: true }); fs.renameSync(from, to);
}
// Sabit yük (sistem istemi + araç listesi) nedeniyle en küçük çağrı bile ≈0,12–0,15 USD tutar (ölçüldü); tavanlar buna göre.
// Nötr klasörde (ROOT) çalışır: proje CLAUDE.md'si ve 224 ajanlık liste yüklenmez. Gerçek maliyet data/costs.json'a yazılır.
let costs = rj("costs.json", {});
const dayKey = () => new Date().toISOString().slice(0, 10);
function addCost(usd) { if (!usd) return; costs[dayKey()] = Math.round(((costs[dayKey()] || 0) + usd) * 1000) / 1000; try { wj("costs.json", costs); } catch { /* */ } }
function runClaude(prompt, { budget = "0.5", name = `${CFG.assistant} (ofis)`, timeout = 170_000, cwd = ROOT, model = "sonnet" } = {}) {
  return new Promise((resolve) => {
    const bin = fs.existsSync(path.join(HOME, ".local", "bin", "claude")) ? path.join(HOME, ".local", "bin", "claude") : "claude";
    const p = spawn(bin, ["-p", prompt, "-n", name, "--model", model, "--output-format", "json", "--no-session-persistence", "--permission-mode", "plan", "--allowedTools", "Read,Grep,Glob", "--strict-mcp-config", "--disable-slash-commands", "--max-budget-usd", budget], { cwd, env: env() });
    let out = "", err = ""; const t = setTimeout(() => { p.kill("SIGTERM"); resolve({ ok: false, text: "Zaman aşımı (sorgu çok uzun sürdü).", cost: 0 }); }, timeout);
    p.stdout.on("data", (d) => { out += d; }); p.stderr.on("data", (d) => { err += d; });
    p.on("close", () => {
      clearTimeout(t);
      try { const d = JSON.parse(out); addCost(d.total_cost_usd); resolve({ ok: !d.is_error && Boolean(d.result), text: String(d.result || d.error || "Yanıt alınamadı").trim().slice(0, 4000), cost: d.total_cost_usd || 0 }); }
      catch { resolve({ ok: false, text: (out.trim() || err.trim() || "Yanıt alınamadı").slice(0, 600), cost: 0 }); }
    });
    p.on("error", (e) => { clearTimeout(t); resolve({ ok: false, text: "claude çalıştırılamadı: " + e.message, cost: 0 }); });
  });
}
function marsContext(st, meetFiles) {
  const b = briefing(st, meetFiles);
  return [`ÖZET: ${b.text}`, `BUGÜN: ${today.items.filter((i) => !i.done).map((i) => "- " + i.text).join("\n") || "(boş)"}`,
    `HEDEFLER: ${goals.map((g) => `${g.title}: ${g.current}/${g.target ?? "?"}`).join("; ")}`,
    `LINKEDIN: ${JSON.stringify(linkedin)}`,
    `SON OLAYLAR: ${events.slice(0, 8).map((e) => e.text).join(" | ")}`,
    `GÜNDEM BAŞLIKLARI: ${news.items.slice(0, 12).map((n) => `[${n.cat}] ${n.title}`).join(" | ")}`].join("\n");
}
let pending = null;
async function chat(text, confirm, ctx) {
  const t = String(text || "").trim(); const roster = ctx.roster();
  const log = (reply) => { const c = rj("chat.json", []); c.push({ at: Date.now(), q: t, a: reply }); wj("chat.json", c.slice(-60)); return { reply }; };
  if (!t) return { reply: "Bir komut yazın. /yardim" };
  if (/^\/onay$/i.test(t) && pending && pending.expires > Date.now()) { const p = pending; pending = null; return log(await p.run()); }
  const [cmd, ...rest] = t.split(/\s+/); const arg = rest.join(" ").trim();
  const need = (desc, run) => { if (confirm) return run().then(log); pending = { expires: Date.now() + 60_000, run }; return { reply: `Onay gerekli: ${desc}\nOnaylamak için /onay yazın (60 sn).` }; };
  switch (cmd.toLowerCase()) {
    case "/yardim": case "/yardım": return { reply: [
      "/durum — Asistanın özeti", "/gorev <metin> — Bugün listesine ekle", "/mola <ajan> · /mesai <ajan> · /normal <ajan> — ajanı molaya al / mesaiye al / sıfırla",
      "/rafa <ajan> · /geri <ajan> — ajanı kapat (rafa) / geri getir (onay ister)", "/ac <ajan> — ajanı ayrı Terminal'de aç (onay ister)", "/toplanti <departman> — departman toplantısı başlat (≈1 USD tavan, onay ister)",
      "/radar ac|kapat — günlük pazar radarı", "/sor <soru> — asistana sor (Claude kullanır, ≈0,15–0,30 USD)", "/onay — bekleyen işlemi onayla" ].join("\n") };
    case "/durum": return log(briefing(ctx.state(), ctx.meetFiles).text);
    case "/gorev": case "/görev": if (!arg) return { reply: "Kullanım: /gorev <metin>" }; addToday(arg, "sohbet"); return log("Eklendi: " + arg);
    case "/mola": case "/mesai": case "/normal": {
      const a = findAgents(arg, roster); if (a.length !== 1) return { reply: a.length ? "Birden çok eşleşme: " + a.slice(0, 5).map((x) => x.name).join(", ") : "Ajan bulunamadı." };
      if (cmd === "/normal") delete overrides[a[0].slug]; else overrides[a[0].slug] = { mode: cmd === "/mola" ? "break" : "duty", at: Date.now() };
      wj("overrides.json", overrides); pushEvent("info", `${a[0].name}: ${cmd === "/normal" ? "normale döndü" : cmd === "/mola" ? "molaya alındı" : "mesaiye alındı"}`);
      return log(`${a[0].name} ${cmd === "/normal" ? "normale döndü" : cmd === "/mola" ? "molada" : "mesaide"}.`);
    }
    case "/rafa": case "/geri": {
      const on = cmd === "/rafa"; const pool = on ? roster : ctx.shelfList();
      const a = (on ? findAgents(arg, pool) : ctx.shelfList().filter((r) => norm(r.name).includes(norm(arg)) || r.slug.includes(norm(arg).replace(/ /g, "-"))));
      if (a.length !== 1) return { reply: a.length ? "Birden çok eşleşme: " + a.slice(0, 5).map((x) => x.name).join(", ") : "Ajan bulunamadı." };
      return need(`${a[0].name} ${on ? "rafa kaldırılacak (Claude'da artık kullanılamaz)" : "geri getirilecek"}`, async () => { try { shelve(a[0].slug, on); ctx.invalidate(); pushEvent("info", `${a[0].name} ${on ? "rafa kaldırıldı" : "geri getirildi"}`); return `${a[0].name} ${on ? "rafa kaldırıldı" : "geri getirildi"}.`; } catch (e) { return "Yapılamadı: " + e.message; } });
    }
    case "/ac": case "/aç": {
      const a = findAgents(arg, roster); if (a.length !== 1) return { reply: a.length ? "Birden çok eşleşme: " + a.slice(0, 5).map((x) => x.name).join(", ") : "Ajan bulunamadı." };
      return need(`${a[0].name} için yeni Terminal penceresi açılacak`, async () => { launchTerminal(a[0]); pushEvent("info", `${a[0].name} Terminal'de açıldı`); return `${a[0].name} Terminal'de açıldı.`; });
    }
    case "/toplanti": case "/toplantı": {
      const divs = [...new Set(roster.map((r) => r.division))]; const d = divs.find((x) => norm(x) === norm(arg)) || divs.find((x) => norm(x).includes(norm(arg)));
      if (!d) return { reply: "Departman bulunamadı. Seçenekler: " + divs.join(", ") };
      return need(`${d} toplantısı başlayacak (salt okunur, ≈1 USD tavan)`, async () => { startMeeting(d); pushEvent("info", `${d} toplantısı başladı`); return `${d} toplantısı başladı; not birkaç dakikada "Toplantılar"da görünür.`; });
    }
    case "/radar": { const on = /^(ac|aç|on|acik|açık)/i.test(arg); settings.radar.enabled = on; wj("settings.json", settings); return log(`Günlük pazar radarı ${on ? "AÇIK" : "KAPALI"} (${settings.radar.time}).`); }
    case "/sor": {
      if (!arg) return { reply: "Kullanım: /sor <soru>" };
      if (!net.online) return { reply: "İnternet yok; Asistana soramam." };
      const r = await runClaude(`Sen ${CFG.assistant}'sın: ${CFG.company} için çalışan ofis yöneticisi ve ana ajansın. Türkçe, kısa ve net yanıtla (en fazla 120 kelime). Dosya değiştirme, komut çalıştırma; yalnızca bilgi ver.\n\nBAĞLAM:\n${marsContext(ctx.state(), ctx.meetFiles)}\n\nSORU: ${arg}`, { budget: "0.5" });
      return log(r.text + (r.cost ? `\n\n— maliyet ≈ $${r.cost.toFixed(2)}` : ""));
    }
    default: return { reply: "Komutu tanımadım. /yardim yazın." };
  }
}

// ---------- günlük pazar radarı (Türkiye + yurt dışı gündemi, ajansa fırsat/risk) ----------
let radarBusy = false;
async function radarRun(manual = false) {
  if (radarBusy || !net.online || !news.items.length) return { ok: false, text: !net.online ? "İnternet yok" : "Gündem verisi henüz yok" };
  radarBusy = true;
  try {
    const heads = news.items.slice(0, 40).map((n) => `[${n.cat}/${n.source}] ${n.title}`).join("\n");
    const r = await runClaude(`Sen ${CFG.company} için çalışan pazarlama müdürüsün; Türkiye ve yurt dışı pazarına, yazılım ve dijital pazarlama gündemine hakimsin. Türkçe yaz. Aşağıdaki GÜNCEL BAŞLIKLARDAN yalnızca gerçekten ilgili olanları kullan, uydurma bilgi ekleme (başlıkta olmayan rakam/iddia yazma).\nBağlam: iki kişilik Türk dijital ajans (web sitesi, QR menü, SEO, sosyal medya, reklam); alıcılar çoğunlukla küçük işletme sahipleri. Kırmızı çizgiler: abartılı vaat yok, "Vaka Çalışması" deme.\n\nÇıktı (Markdown, '# Pazar radarı — ${new Date().toLocaleDateString("tr-TR")}' başlığıyla, en fazla 350 kelime):\n1. Türkiye gündeminden ajansı ilgilendiren 3 madde (neden önemli, ne yapmalı).\n2. Yurt dışı / yazılım / SEO gündeminden 3 madde (aynı şekilde).\n3. Bugün LinkedIn'de paylaşılabilecek 2 gönderi fikri (konu + açı, 1-2 cümle).\n4. Satış için 1 fırsat veya risk.\n\nBAŞLIKLAR:\n${heads}`, { budget: "0.8", name: "Pazar radarı" });
    if (r.ok) {
      const day = new Date().toISOString().slice(0, 10); fs.writeFileSync(path.join(RADAR_DIR, `${day}.md`), r.text);
      for (const m of r.text.matchAll(/LinkedIn[\s\S]*?\n((?:\s*[-*\d].*\n?){1,3})/gi)) { const first = (m[1].split("\n").find((l) => l.trim()) || "").replace(/^[\s\-*\d.]+/, "").trim(); if (first) addToday("LinkedIn: " + first.slice(0, 160), "pazar radarı"); }
      pushEvent("info", "Pazar radarı hazır"); settings.radar.lastRun = day; wj("settings.json", settings);
    } else pushEvent("warn", "Pazar radarı çalışmadı: " + r.text.slice(0, 80));
    return r;
  } finally { radarBusy = false; }
}
setInterval(() => {
  const r = settings.radar; if (!r.enabled) return;
  const d = new Date(), hhmm = d.toTimeString().slice(0, 5), day = d.toISOString().slice(0, 10);
  if (r.lastRun !== day && hhmm >= r.time && !extraCtx?.limitActive?.()) radarRun();
}, 60_000);

// ---------- HTTP ----------
let extraCtx = null;
const send = (res, code, body) => { res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((resolve) => { let b = ""; req.on("data", (c) => { b += c; if (b.length > 100_000) req.destroy(); }); req.on("end", () => { try { resolve(JSON.parse(b || "{}")); } catch { resolve({}); } }); });

export const extra = {
  init(ctx) { extraCtx = ctx; },
  // LAN modunda PIN kapısı; yerel modda boş geçer.
  gate(req, res, url) {
    if (!LAN) return false;
    if (hasSession(req)) return false;
    if (url.pathname === "/auth" && req.method === "POST") {
      const ip = ipOf(req), st = attempts.get(ip) || { n: 0, until: 0 };
      if (st.until > Date.now()) { res.writeHead(429, { "Content-Type": "text/plain; charset=utf-8", "Retry-After": "900" }); res.end("Çok fazla deneme. 15 dakika sonra tekrar deneyin."); return true; }
      let b = ""; req.on("data", (c) => { b += c; if (b.length > 1000) req.destroy(); });
      req.on("end", () => {
        const pin = new URLSearchParams(b).get("pin");
        if (pinOk(pin)) {
          attempts.delete(ip);
          const id = crypto.randomBytes(32).toString("hex"); sessions.set(id, Date.now() + SESSION_MS);
          res.writeHead(302, { "Set-Cookie": `farm=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}`, Location: "/" }); res.end();
        } else {
          st.n++; if (st.n >= MAX_TRIES) { st.until = Date.now() + LOCK_MS; st.n = 0; } attempts.set(ip, st);
          res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" }); res.end("Yanlış PIN. <a href='/'>Geri</a>");
        }
      }); return true;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><body style="background:#14100c;color:#f3e7cf;font:16px monospace;display:grid;place-items:center;height:100vh"><form method=post action=/auth><h2 style="color:#f5a623">VİNCİ OFİSİ</h2><input name=pin type=password inputmode=numeric placeholder=PIN autofocus style="font-size:20px;padding:8px"> <button style="font-size:20px;padding:8px">Gir</button></form>`);
    return true;
  },
  stateFragment(st, meetFiles) {
    const sug = suggestions(meetFiles);
    return {
      net: { online: net.online, since: net.since, latencyMs: net.latencyMs, analysis: net.analysis, outages: net.outages.slice(0, 5) },
      health, news: { items: news.items.slice(0, 60), fetchedAt: news.fetchedAt, status: news.status },
      today: today.items, suggestions: sug, goals, linkedin, overrides, events: events.slice(0, 40),
      costToday: costs[dayKey()] || 0, briefing: briefing(st, meetFiles), radar: { enabled: settings.radar.enabled, time: settings.radar.time, lastRun: settings.radar.lastRun, busy: radarBusy },
    };
  },
  async handle(req, res, url, ctx) {
    const p = url.pathname;
    if (p === "/api/token") { if (!LAN && !hostLocal(req)) { res.writeHead(403); return res.end(), true; } send(res, 200, { token: TOKEN }); return true; }
    if (!p.startsWith("/api/") || req.method !== "POST") {
      if (p === "/api/radar/latest") { let text = ""; try { const f = fs.readdirSync(RADAR_DIR).filter((n) => n.endsWith(".md")).sort().pop(); if (f) text = fs.readFileSync(path.join(RADAR_DIR, f), "utf8"); } catch { /* yok */ } send(res, 200, { text }); return true; }
      if (p === "/api/shelf") { send(res, 200, ctx.shelfList()); return true; }
      if (p === "/api/chat/log") { send(res, 200, rj("chat.json", []).slice(-30)); return true; }
      return false;
    }
    if (!authed(req)) { send(res, 403, { error: "yetkisiz (jeton)" }); return true; }
    const body = await readBody(req);
    if (p === "/api/today") {
      if (body.op === "add" && body.text) addToday(body.text, body.source || "elle");
      else if (body.op === "toggle") { const i = today.items.find((x) => x.id === body.id); if (i) { i.done = !i.done; saveToday(); } }
      else if (body.op === "delete") { today.items = today.items.filter((x) => x.id !== body.id); saveToday(); }
      else if (body.op === "clearDone") { today.items = today.items.filter((x) => !x.done); saveToday(); }
      send(res, 200, { items: today.items }); return true;
    }
    if (p === "/api/goals") { if (Array.isArray(body.goals)) { goals = body.goals.slice(0, 12).map((g) => ({ id: String(g.id || crypto.randomBytes(3).toString("hex")), title: String(g.title || "").slice(0, 80), target: g.target === null || g.target === "" ? null : Number(g.target), current: Number(g.current) || 0, unit: String(g.unit || "").slice(0, 16), note: String(g.note || "").slice(0, 120) })); wj("goals.json", goals); } send(res, 200, { goals }); return true; }
    if (p === "/api/linkedin") { const n = (v) => (v === null || v === "" || v === undefined ? null : Number(v)); linkedin = { url: String(body.url || "").slice(0, 200), followers: n(body.followers), impressions7d: n(body.impressions7d), posts7d: n(body.posts7d), updatedAt: new Date().toISOString() }; wj("linkedin.json", linkedin); send(res, 200, linkedin); return true; }
    if (p === "/api/chat") { send(res, 200, await chat(body.text, body.confirm === true, ctx)); return true; }
    if (p === "/api/radar/run") { radarRun(true); send(res, 200, { started: true }); return true; }
    send(res, 404, { error: "yok" }); return true;
  },
};
