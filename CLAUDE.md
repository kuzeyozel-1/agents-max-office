# Vinci Ofisi — yeni oturum başlangıcı

Önce `docs/continuity-2026-10-05.md`, `handoff/STATE.json` ve `data/workday.json` dosyalarını oku. Son ikisi yerel/gizlidir, Git'e ekleme.

- Görev durumu ve sonuçları için `data/workday.json` birincil kaynaktır; eski sohbet/devir metni tarihî olabilir.
- Kullanıcı 7/24 çalışma istiyor. Varsayılan gece durması yok. Claude limiti ücretsiz sağlayıcı işlerini durdurmamalı.
- Görev kuyruğu, sağlayıcı bekleme süreleri ve yanıtlar yeniden başlatmada korunmalıdır.
- Çıktı TASLAKTIR. Deploy, DNS, GTM yayını ve e-posta/sosyal yayın için kullanıcı onayı gerekir.
- İç bağlamı ücretsiz uzak sağlayıcılara ekleme. `full` yalnızca Claude/yerel model, `safe` uzak sağlayıcılara izinli metindir.
- Test: `node --test tests/*.test.mjs`; sözdizimi: `node --check server.mjs` ve değişen modüller.
- Bu depo ofistir. Vinci site kodu `../vincistudio`, Stage Medya `../stage-medya` içindedir; projeleri karıştırma.

## Codex desteği
`config/office.json` → `codex.enabled` ile etkin. `lib/codex.mjs` mevcut ChatGPT girişini kullanarak Codex CLI salt-okunur taslak çağrısı yapar; gizli anahtar kopyalamaz. Otomatik ofis sohbeti Claude → Codex → ücretsiz; otomatik ücretsiz işler Groq/Gemini → Codex. `/ai codex` yalnızca Codex seçer. Son katkı/kota beklemesi `data/codex-state.json` içinde. Codex kotası ücretsiz/sınırsız değildir; panel kalan yüzdeyi bildiğini iddia etmez.
