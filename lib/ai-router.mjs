// Only-Claude stays explicit; free work never spills into paid Claude calls.
export async function routeAI({ mode, freeFirst, noClaude, claudeReady, codexReady, claude, codex, free }) {
  if (mode === 'codex') return codex();
  if (!noClaude && mode === 'claude') return claudeReady ? claude() : { ok:false, text:'Claude limitte veya çevrimdışı (yalnızca Claude modu).' };
  const order = noClaude ? [free, ...(codexReady ? [codex] : [])]
    : freeFirst ? [free, ...(codexReady ? [codex] : []), ...(claudeReady ? [claude] : [])]
    : [...(claudeReady ? [claude] : []), ...(codexReady ? [codex] : []), free];
  let result = { ok:false, text:'Uygun sağlayıcı yok; görev kayıtlı.' };
  for (const run of order) { result = await run(); if (result.ok) return result; }
  return result;
}
