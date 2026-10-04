#!/usr/bin/env node
// Kullanım:  bin/farm-providers.mjs list            → tanımlı sağlayıcılar ve durumları (anahtar GÖSTERİLMEZ)
//            bin/farm-providers.mjs test            → her sağlayıcıya kısa bir deneme isteği atar
//            bin/farm-providers.mjs models <ad>     → o sağlayıcıda kullanılabilir model kimlikleri (office.json'daki `model` için)
import { CFG } from "../lib/config.mjs";
import { ask, models, status } from "../lib/providers.mjs";
const [cmd, arg] = process.argv.slice(2);
if (!CFG.providers.length) { console.log("office.json içinde `providers` yok. config/office.example.json'a bakın."); process.exit(1); }
if (cmd === "models") { try { const m = await models(arg || ""); console.log(m.slice(0, 60).join("\n") + (m.length > 60 ? `\n… (+${m.length - 60})` : "")); } catch (e) { console.error("Hata:", e.message); process.exit(1); } }
else if (cmd === "test") {
  for (const p of CFG.providers) {
    const r = await ask({ safe: "Yalnızca tek kelime yaz: merhaba", full: "Yalnızca tek kelime yaz: merhaba", maxTokens: 300, only: p.name });
    const s = status().find((x) => x.name === p.name);
    console.log(`${p.name.padEnd(14)} ${r.ok ? "OK  → " + r.text.slice(0, 40).replace(/\n/g, " ") : "ATLANDI/HATA → " + (s?.err || s?.state)}`);
  }
} else { for (const s of status()) console.log(`${s.name.padEnd(14)} ${s.model.padEnd(34)} ${s.local ? "yerel " : "uzak  "} ${s.state}${s.err ? " (" + s.err + ")" : ""}`); }
