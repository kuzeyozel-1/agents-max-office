// Kişiye/şirkete özel her şey config/office.json'da (git'e girmez). Yoksa office.example.json kullanılır.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const expand = (p) => String(p || "").replace(/^~(?=$|\/)/, os.homedir());
// Değerler HTML/JS/kabuk bağlamlarına girdiği için yalnızca zararsız karakterler kalır.
const plain = (s, fb) => (String(s ?? "").replace(/[^\p{L}\p{N} .,&_()'-]/gu, "").trim().slice(0, 60) || fb);

function load() {
  const file = process.env.FARM_CONFIG || path.join(ROOT, "config", "office.json");
  const fallback = path.join(ROOT, "config", "office.example.json");
  let raw = {};
  for (const f of [file, fallback]) { try { raw = JSON.parse(fs.readFileSync(f, "utf8")); break; } catch { /* sıradaki */ } }
  const site = /^https?:\/\/[^\s"'<>]+$/.test(raw.siteUrl || "") ? raw.siteUrl.replace(/\/+$/, "") : "";
  return {
    company: plain(raw.company, "Ajansım"),
    owner: plain(raw.owner, "Yönetici"),
    assistant: plain(raw.assistant, "Asistan"),
    projectDir: expand(raw.projectDir) || os.homedir(),
    memoryFile: expand(raw.memoryFile),
    briefFiles: Array.isArray(raw.briefFiles) ? raw.briefFiles.map((f) => String(f).slice(0, 200)).slice(0, 8) : [],
    redLines: String(raw.redLines || "").slice(0, 600),
    siteUrl: site,
    probes: (Array.isArray(raw.probes) ? raw.probes : []).slice(0, 12).map((p) => ({ name: plain(p.name, "Sayfa"), path: String(p.path || "/").slice(0, 200), contains: p.contains ? String(p.contains).slice(0, 80) : undefined })),
  };
}
export const CFG = load();
