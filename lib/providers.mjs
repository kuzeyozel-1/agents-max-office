// Ücretsiz/yerel yapay zekâ sağlayıcıları (OpenAI uyumlu /chat/completions). Sıfır bağımlılık.
// Gizlilik kuralı: UZAK sağlayıcıya yalnızca `safe` metin gider (herkese açık içerik); iç bağlam (`full`) yalnızca
// Claude'a ve bu bilgisayardaki yerel modele (Ollama vb.) gider. `safe` yoksa uzak sağlayıcı hiç çağrılmaz.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CFG } from "./config.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// Anahtarlar config/keys.env'den (git'e girmez) ya da ortam değişkenlerinden okunur; hiçbir yere yazılmaz/loglanmaz.
function loadKeys() {
  const out = {};
  try {
    const mode = fs.statSync(path.join(ROOT, "config", "keys.env")).mode & 0o077;
    if (mode) console.warn("UYARI: config/keys.env başkaları tarafından okunabilir; `chmod 600 config/keys.env` çalıştırın.");
    for (const line of fs.readFileSync(path.join(ROOT, "config", "keys.env"), "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && !line.trim().startsWith("#")) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch { /* dosya yok */ }
  return out;
}
const fileKeys = loadKeys();
const keyOf = (p) => (p.keyEnv ? process.env[p.keyEnv] || fileKeys[p.keyEnv] || "" : "");

const state = new Map(); // name -> { cooldownUntil, err, lastOkAt, calls }
const st = (p) => { if (!state.has(p.name)) state.set(p.name, { cooldownUntil: 0, err: "", lastOkAt: 0, calls: 0 }); return state.get(p.name); };
const usable = (p) => p.enabled && (p.local || keyOf(p)) && st(p).cooldownUntil < Date.now();

export function status() {
  return CFG.providers.map((p) => {
    const s = st(p), hasKey = p.local || Boolean(keyOf(p));
    const label = !p.enabled ? "kapalı" : !hasKey ? "anahtar yok" : s.cooldownUntil > Date.now() ? "beklemede" : "hazır";
    return { name: p.name, model: p.model, local: p.local, state: label, err: s.err, lastOkAt: s.lastOkAt, calls: s.calls };
  });
}
export const anyRemoteReady = () => CFG.providers.some((p) => !p.local && usable(p));
export const anyLocalReady = () => CFG.providers.some((p) => p.local && usable(p));

async function call(p, text, { system, maxTokens }) {
  const s = st(p); s.calls++;
  const headers = { "content-type": "application/json" }; const key = keyOf(p); if (key) headers.authorization = "Bearer " + key;
  try {
    const r = await fetch(p.baseUrl + "/chat/completions", {
      method: "POST", headers, signal: AbortSignal.timeout(p.local ? 120_000 : 45_000), redirect: "error",
      body: JSON.stringify({ model: p.model, max_tokens: maxTokens, temperature: 0.3, messages: [...(system ? [{ role: "system", content: system }] : []), { role: "user", content: text }] }),
    });
    if (!r.ok) {
      const wait = r.status === 429 ? Math.min(3600, Number(r.headers.get("retry-after")) || 600) : r.status === 401 || r.status === 403 ? 6 * 3600 : 120;
      s.cooldownUntil = Date.now() + wait * 1000; s.err = r.status === 429 ? "kota doldu" : r.status === 401 || r.status === 403 ? "anahtar reddedildi" : "HTTP " + r.status;
      return { ok: false };
    }
    const j = await r.json(); const out = String(j?.choices?.[0]?.message?.content || "").trim();
    if (!out) { s.cooldownUntil = Date.now() + 120_000; s.err = "boş yanıt"; return { ok: false }; }
    s.err = ""; s.lastOkAt = Date.now(); return { ok: true, text: out.slice(0, 4000) };
  } catch (e) { s.cooldownUntil = Date.now() + 120_000; s.err = e?.name === "TimeoutError" ? "zaman aşımı" : "bağlantı yok"; return { ok: false }; }
}

// full: iç bağlamlı tam istem (yalnızca yerel/Claude). safe: uzağa gönderilebilir herkese açık sürüm (yoksa uzak çağrılmaz).
// onlyLocal: internet yokken yalnızca yerel model denenir.
export async function ask({ full, safe = null, system, maxTokens = 700, onlyLocal = false, only = null }) {
  for (const p of CFG.providers) {
    if (!usable(p) || (onlyLocal && !p.local) || (only && p.name !== only)) continue;
    const text = p.local ? full ?? safe : safe;
    if (!text) continue;
    const r = await call(p, text, { system, maxTokens });
    if (r.ok) return { ok: true, text: r.text, provider: p.name, local: p.local, cost: 0 };
  }
  return { ok: false, text: "Ücretsiz/yerel yapay zekâ sağlayıcısı yanıt vermedi." + (CFG.providers.length ? "" : " (office.json'da `providers` tanımlı değil)") };
}

// Komut satırı: kullanılabilir model kimlikleri.
export async function models(name) {
  const p = CFG.providers.find((x) => x.name.toLowerCase() === String(name).toLowerCase());
  if (!p) throw new Error("sağlayıcı bulunamadı");
  const headers = {}; const key = keyOf(p); if (key) headers.authorization = "Bearer " + key;
  const r = await fetch(p.baseUrl + "/models", { headers, signal: AbortSignal.timeout(20_000), redirect: "error" });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const j = await r.json(); return (j.data || j.models || []).map((m) => m.id || m.name).filter(Boolean);
}
