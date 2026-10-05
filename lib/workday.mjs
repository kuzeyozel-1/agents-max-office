// Günün iş planı: ajanlara (rol olarak) gerçek görevler verilir, ücretsiz/yerel sağlayıcılar yapar, çıktı TASLAK olarak saklanır.
// Hiçbir şey gönderilmez/yayınlanmaz. Görev metinleri herkese açık içerik olmalı (uzak sağlayıcıya gider).
import fs from "node:fs";
import { atomicWrite, localDay, retryDelay } from "./storage.mjs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLAN_FILE = path.join(ROOT, "config", "workday.local.json");
const GAP_MS = 20_000;

const ENGAGE = "ETKİLEŞİM ODAKLI yaz: ilk satır güçlü bir kanca; sonra 3 kısa madde; tek kelimeyle yanıtlanabilecek bir yorum sorusu; 'kaydet / bir arkadaşına gönder' çağrısı; en fazla 5 hashtag; Instagram için en çok 1200 karakter ve bağlantı için 'bio'daki link' de. Abartı, 'son fırsat', garanti, kanıtsız rakam YOK; yalnızca verilen bilgiyi kullan.";
const SOCIAL_PROMPT = (p) => `Vinci Studio (Türkiye'de küçük işletmelere web, QR menü, sosyal medya, reklam ve SEO hizmeti veren iki kişilik ajans) yeni bir ${p.kind === "defter" ? "Vinci Defteri notu" : "blog yazısı"} yayınladı.\nBaşlık: ${p.title}\nBağlantı: ${p.link}\n\nYAZININ METNİ (TEK BİLGİ KAYNAĞIN; metinde OLMAYAN hiçbir özellik, rakam, avantaj, sonuç yazma — örneğin metinde geçmeyen 'veri takibi', 'sipariş artışı', 'indirme süresi' gibi iddialar YASAK):\n${p.text || p.desc}\n\nŞunları üret (başlıklarla): 1) INSTAGRAM gönderi metni. 2) LINKEDIN gönderi metni (en çok 120 kelime, hashtag 3). 3) 3 adet INSTAGRAM HİKÂYE fikri (anket/soru kutusu/emoji kaydırıcı; metinleriyle). 4) 1 adet REELS fikri (20-30 sn, sahne sahne, ekran yazısı). 5) Afiş için 3 madde (her biri en çok 8 kelime) ve 1 soru cümlesi.\n${ENGAGE}`;
const VERIFY_PROMPT = (src, out) => `Bir yazıdan üretilen sosyal medya paketini denetle. Yalnızca YAZININ METNİNDE bulunmayan ya da metinle çelişen iddiaları, rakamları ve özellikleri madde madde listele (her madde: çıktıdaki ifade → neden desteksiz). Hepsi destekliyse yalnızca 'Desteksiz iddia bulunmadı.' yaz. Kısa tut.\n\nYAZININ METNİ:\n${src}\n\nÜRETİLEN PAKET:\n${out}`;
const DEFTER_PROMPT = (n) => `Aşağıdaki haber metninden Vinci Defteri (kısa gündem notları bölümü) için TÜRKÇE bir not taslağı yaz. Biçim: HTML (<p>, <ul><li>, <h2>), 150-220 kelime; bölümler: ne oldu (tarih ve kurum belirt), 3 maddelik öne çıkanlar, "Küçük bir işletme için ne anlama geliyor?" (dürüst, abartısız), 1 dikkat notu. KURAL: YALNIZCA metindeki bilgiyi kullan; rakam/tarih/isimleri metinden aynen al, metinde yoksa YAZMA; emin olmadığın bir şeyi yazma. En üstte tek satır "BAŞLIK:" (en çok 70 karakter) ve "ÖZET:" (en çok 155 karakter) ver. Sonda "KAYNAK: ${n.source} — ${n.link}".\n\nKAYNAK METNİ:\n${n.text}`;

export function createWorkday({ think, pushEvent, isOnline, isLimited, rj, wj, dataDir, rosterSlugs, sources = {}, autoStart = true, canRun = isOnline, planFile = PLAN_FILE }) {
  const outDir = path.join(dataDir, "workday"); fs.mkdirSync(outDir, { recursive: true });
  const today = localDay;
  let state = rj("workday.json", { date: "", tasks: [] });
  let busy = false, nextAt = 0;
  const save = () => { wj("workday.json", state); };

  function readPlan() { try { return JSON.parse(fs.readFileSync(planFile, "utf8")); } catch { return {}; } }
  const mk = (t, salt = "") => ({ id: crypto.createHash("sha1").update(t.slug + t.title + salt).digest("hex").slice(0, 8), slug: t.slug, title: t.title, prompt: t.prompt, status: "planned", via: "", startedAt: 0, finishedAt: 0, error: "" });
  function loadPlan() {
    const raw = readPlan();
    const known = new Set(rosterSlugs());
    return (Array.isArray(raw.tasks) ? raw.tasks : []).slice(0, 20).flatMap((t) => {
      const slug = String(t.slug || ""), prompt = String(t.prompt || "").slice(0, 2500), title = String(t.title || "").slice(0, 120);
      if (!/^[a-z0-9-]+$/.test(slug) || !known.has(slug) || !prompt || !title) return [];
      return [{ id: crypto.createHash("sha1").update(slug + title).digest("hex").slice(0, 8), slug, title, prompt, status: "planned", via: "", startedAt: 0, finishedAt: 0, error: "" }];
    });
  }
  function ensureToday(force = false) {
    if (!force && state.date === today()) return;
    if (busy) return;
    if (state.date) wj(`workday-history/${state.date}.json`, state);
    const carry = state.tasks.filter(t => t.status !== "done").map(t => ({ ...t, status: "planned", outputDate: t.outputDate || state.date }));
    const ids = new Set(carry.map(t => t.id));
    state = { date: today(), tasks: [...carry, ...loadPlan().filter(t => !ids.has(t.id))], poolIdx: state.poolIdx || 0, extra: 0 }; save();
    if (state.tasks.length) pushEvent("info", `Günün iş planı yüklendi (${state.tasks.length} görev)`);
  }

  async function run(task) {
    busy = true; task.outputDate ||= state.date; task.attempts = (task.attempts || 0) + 1; task.status = "working"; task.startedAt = Date.now(); task.error = ""; save();
    pushEvent("info", `${task.slug} göreve başladı: ${task.title}`);
    const r = task.result || await think(task.prompt, { safe: task.prompt, prefer: "free", noClaude: true, only: task.only || null, system: "Türkçe yaz. Taslak üret: net, kısa, abartısız, kanıtsız rakam uydurma. Bilmediğin şeyi bilmediğini söyle." });
    if (r.ok) { task.result = r; save(); }
    if (r.ok) atomicWrite(path.join(outDir, `${task.outputDate}-${task.id}.md`), `# ${task.title}\n\n_Taslak — ${r.via || "?"} · ${new Date().toLocaleString("tr-TR")}. Hiçbir yere gönderilmedi/yayınlanmadı._\n\n${r.text}\n`);
    if (r.ok && task.verify) { // ikinci model, çıktıyı yazı metniyle karşılaştırır ve desteksiz iddiaları ekler
      const other = /Groq/.test(r.via || "") ? "Gemini" : "Groq";
      const v = await think(VERIFY_PROMPT(task.verify, r.text), { safe: VERIFY_PROMPT(task.verify, r.text), prefer: "free", noClaude: true, only: other });
      try { fs.appendFileSync(path.join(outDir, `${task.outputDate}-${task.id}.md`), `\n\n---\n## ⚠ Doğrulama notu (${v.via || other}) — yayınlamadan önce okuyun\n${v.ok ? v.text : "Doğrulama yapılamadı; çıktıyı yazıyla elle karşılaştırın."}\n`); } catch { /* */ }
    }
    task.finishedAt = Date.now(); task.status = r.ok ? "done" : "planned";
    task.retryAt = r.ok ? 0 : Date.now() + retryDelay(task.attempts);
    task.via = r.via || ""; task.error = r.ok ? "" : String(r.text || "").slice(0, 120);
    save(); busy = false; nextAt = Date.now() + GAP_MS;
    pushEvent(r.ok ? "info" : "warn", r.ok ? `${task.slug} görevi bitti (${task.via})` : `${task.slug} bekliyor; tekrar denenecek: ${task.error}`);
  }
  // Plan bitip ofis boşta kalırsa (siz yanıt vermeseniz de) havuzdan yeni görev çek: günde en çok 24 ek görev.
  function topUp() {
    if (busy || state.tasks.some((t) => t.status === "planned" || t.status === "working")) return;
    const last = Math.max(0, ...state.tasks.map((t) => t.finishedAt || 0));
    if (Date.now() - last < 8 * 60_000 || (state.extra ?? 0) >= 24) return;
    const raw = readPlan(), pool = (Array.isArray(raw.pool) ? raw.pool : []).slice(0, 60), known = new Set(rosterSlugs());
    if (!pool.length) return;
    for (let k = 0; k < pool.length; k++) {
      const t = pool[(state.poolIdx = ((state.poolIdx ?? 0) + 1) % pool.length)];
      if (!t || !known.has(t.slug) || !/^[a-z0-9-]+$/.test(t.slug)) continue;
      const task = mk({ slug: t.slug, title: String(t.title).slice(0, 120), prompt: String(t.prompt).slice(0, 3000) }, state.date + ":" + state.extra);
      state.tasks.push(task); state.extra = (state.extra ?? 0) + 1; save();
      pushEvent("info", `Ofis boşta: havuzdan yeni görev eklendi (${t.title})`); return;
    }
  }
  // Üreticiler (yalnızca herkese açık içerikten): yeni yayınlanan blog/Defter yazısı -> sosyal paket; gündem haberi -> Defter taslağı.
  let lastGen = 0, genBusy = false;
  async function generate() {
    if (genBusy || Date.now() - lastGen < 20 * 60_000 || !isOnline() || state.date !== today()) return;
    genBusy = true; lastGen = Date.now();
    try {
      const known = new Set(rosterSlugs());
      const add = (slug, title, prompt, only, verify) => { if (!known.has(slug)) return; const t = mk({ slug, title: title.slice(0, 120), prompt: prompt.slice(0, 11000) }, state.date + ":" + title); t.only = only || null; t.verify = verify || null; if (state.tasks.some((x) => x.id === t.id)) return; state.tasks.push(t); save(); };
      for (const p of (await sources.newPosts?.()) || []) {
        add("marketing-instagram-curator", `Sosyal paket: ${p.title}`, SOCIAL_PROMPT(p), "Groq", p.text || p.desc);
        pushEvent("info", `Yeni ${p.kind === "defter" ? "Defter notu" : "blog yazısı"} bulundu, sosyal paket görevi eklendi: ${p.title}`);
      }
      for (const n of (await sources.newsPicks?.()) || []) {
        add("marketing-content-creator", `Defter taslağı: ${n.title}`, DEFTER_PROMPT(n), "Gemini");
        pushEvent("info", `Gündemden Defter taslağı görevi eklendi: ${n.title.slice(0, 60)}`);
      }
    } catch (e) { pushEvent("warn", "Üretici hata: " + String(e?.message || e).slice(0, 80)); } finally { genBusy = false; }
  }
  // Varsayılan 7/24; yalnızca açık quietHours tercihi gece bekletir.
  // data/no-quiet dosyası varsa sessiz saat yoktur (kullanıcı "ofis sürekli çalışsın" derse; silince geri gelir).
  const quiet = () => { if (!readPlan().quietHours || fs.existsSync(path.join(ROOT, "data", "no-quiet"))) return false; const d = new Date(), h = d.getHours() + d.getMinutes() / 60; return h >= 0.5 && h < 7.5; };
  function tick() {
    ensureToday();
    if (quiet()) return;
    generate();
    topUp();
    if (busy || Date.now() < nextAt || !canRun()) return;
    const t = state.tasks.find((x) => (x.status === "planned" && (!x.retryAt || x.retryAt <= Date.now())) || (x.status === "working" && !busy));
    if (t) run(t).catch(() => { t.status = "planned"; t.error = "Görev tamamlanamadı; tekrar denenecek"; t.retryAt = Date.now() + retryDelay(t.attempts); busy = false; save(); });
  }
  if (autoStart) { setInterval(tick, 10_000); setTimeout(tick, 6000); }
  // Yeniden başlatmada yarım kalan "working" görevler planlı sayılır.
  for (const t of state.tasks) if (["working", "failed"].includes(t.status)) t.status = "planned";
  save();

  return {
    tick,
    fragment: () => ({ date: state.date, busy, tasks: state.tasks.map(({ id, slug, title, status, via, startedAt, finishedAt, error, attempts, retryAt }) => ({ id, slug, title, status, via, startedAt, finishedAt, error, attempts, retryAt })) }),
    // Ofis arayüzünde "çalışıyor/molada" görünmeleri için sanal alt-ajan kayıtları.
    virtualSubs: () => state.tasks.flatMap((t) => t.status === "working" ? [{ id: "wd-" + t.id, slug: t.slug, agentType: "workday", state: "working", description: t.title, lastTool: { tool: "Write" }, lastText: "", ageSec: 0 }]
      : t.status === "done" && Date.now() - t.finishedAt < 5 * 60_000 ? [{ id: "wd-" + t.id, slug: t.slug, agentType: "workday", state: "recent", description: t.title, lastTool: { tool: "Write" }, lastText: "", ageSec: 60 }] : []),
    // Bugünün biten çıktıları: menüde tek tıkla kopyalanır (üst bilgi satırları ayıklanır).
    copyItems: () => state.tasks.filter((t) => t.status === "done").map((t) => { let text = ""; try { text = fs.readFileSync(path.join(outDir, `${t.outputDate || state.date}-${t.id}.md`), "utf8").replace(/^#.*\n\n_Taslak[^\n]*\n\n/, ""); } catch { /* yok */ } return { id: "wd-" + t.id, title: t.title, text }; }).filter((x) => x.text),
    output: (id) => { if (!/^[\w-]+$/.test(id)) return ""; try { return fs.readFileSync(path.join(outDir, `${state.tasks.find(t => t.id === id)?.outputDate || state.date}-${id}.md`), "utf8"); } catch { return ""; } },
    restart: () => { if (busy) return; ensureToday(true); nextAt = 0; },
  };
}
