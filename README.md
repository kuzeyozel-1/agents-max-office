# agents-max-office

**TR:** Claude Code ajanlarınızı 7/24 canlı izlediğiniz, piksel-ofis görünümlü yerel panel. Hangi ajan çalışıyor, hangi terminal bekliyor, Claude limiti doldu mu, internet gitti mi, bugün ne yapılacak — tek ekranda. Sıfır bağımlılık (yalnızca Node 20+).
**EN:** A local, pixel-office style dashboard for watching your Claude Code agents. Zero dependencies (Node 20+). Runs on `127.0.0.1` by default.

> Bağımsız bir topluluk projesidir; Anthropic ile bağlantısı yoktur.

## Ne yapar
- **Ofis görünümü:** `~/.claude/agents` altındaki ajanları departmanlara dizer; `~/.claude/projects` altındaki oturum kayıtlarından kimin çalıştığını/beklediğini gösterir.
- **Vardiya planı** (`config/shifts.json`), **bugün listesi**, **hedefler**, **gündem akışı** (RSS, `config/sources.json`), **site sağlık kontrolleri**.
- **Limit / internet farkındalığı:** Claude limit mesajı görülürse ya da internet 3 denemede gelmezse ofis "uyku moduna" geçer ve başka bir yapay zekâya yapıştırılabilecek bir **devir notu** (`handoff/LATEST.md`) yazar. *Limit algılama gerçek mesaj biçimlerine göre yazıldı ama canlı bir limit olayında henüz denenmedi.*
- **Ücretsiz/yerel yapay zekâ yedeği** (`lib/providers.mjs`): Claude limiti dolunca, hata verince ya da internet yokken (yerel modelle) sohbet ve günlük radar bu sağlayıcılara düşer. Groq, Gemini, OpenRouter ve yerel Ollama için örnek ayar hazır; OpenAI uyumlu her uç eklenebilir.
- **İnternet kesilince:** 3 denemede (≈30 sn) bağlantı gelmezse ofis uyur, gelen sorular kuyruğa alınır, bağlantı gelince yanıtlanıp sohbete düşer. 5 dakikadan uzun kesintide ve Claude limiti dolduğunda **devir notu + (ayarlıysa) Claude hafıza dosyası** otomatik yazılır.
- **Departman toplantısı** (`bin/farm-meeting`): salt-okunur (plan modu), harcama tavanlı.

## Kurulum
```bash
git clone https://github.com/kuzeyozel-1/agents-max-office && cd agents-max-office
cp config/office.example.json config/office.json   # şirket/yol bilgilerinizi yazın (git'e girmez)
node server.mjs                                     # http://localhost:4747
# Mac'te açılışta otomatik başlatmak için: launchd/install-launchd.sh
```

## Ücretsiz yapay zekâ sağlayıcıları
```bash
cp config/keys.env.example config/keys.env && chmod 600 config/keys.env   # anahtarları KENDİNİZ alıp yazın
node bin/farm-providers.mjs models Groq     # model kimliklerini doğrulayın (config/office.json → providers[].model)
node bin/farm-providers.mjs test            # her sağlayıcıya kısa deneme isteği
```
Sohbet kutusunda `/ai` durumu gösterir, `/ai oto|claude|ucretsiz` modu değiştirir. Ücretsiz katmanların limitleri ve veri politikaları sağlayıcıdan sağlayıcıya değişir ve değişebilir; kullanmadan önce kendi sayfalarından kontrol edin.

**Gizlilik kuralı:** Uzak (ücretsiz) sağlayıcıya yalnızca *herkese açık* içerik gider (gündem başlıkları ve sorunuzun kendisi). Bugün listesi, hedefler, LinkedIn sayıları, hafıza/devir notu gibi iç bağlam yalnızca Claude'a ve bu bilgisayardaki yerel modele gider. Bu yüzden `/sor` sorusuna müşteri verisi yazmayın: soru metni ücretsiz sağlayıcıya gidebilir. Yanıtın altında hangi sağlayıcıdan geldiği yazar.

## Maliyet uyarısı
Panel kendi başına ücretsizdir. **Yalnızca** sohbet kutusunda `/sor`, günlük pazar radarı ve departman toplantıları Claude'u çağırır (radar, ücretsiz sağlayıcı varsa önce onu dener); her çağrı en az yaklaşık 0,12–0,15 USD tutar (ölçüldü) ve harcama tavanlıdır. Radar varsayılan olarak kapalıdır.

## Güvenlik modeli (kısa)
Ayrıntı: [SECURITY.md](SECURITY.md).
- Varsayılan olarak yalnızca `127.0.0.1` dinler; yerel modda `localhost` dışındaki `Host` başlıkları reddedilir (DNS rebinding koruması).
- Yazma uçları oturum başına rastgele bir jeton ister; tarayıcı dışı/başka site istekleri 403 alır.
- Ağdan erişim (`FARM_HOST=0.0.0.0`) için **en az 6 haneli `FARM_PIN` zorunlu**; giriş rastgele oturum kimliğiyle yapılır, 5 yanlış denemede 15 dk kilitlenir. Trafik düz HTTP'dir — yalnızca güvendiğiniz bir ağda ya da HTTPS veren bir tünel (ör. Tailscale) arkasında kullanın, internete **açmayın**.
- Claude çağrıları `--permission-mode plan` ve yalnızca `Read,Grep,Glob` ile çalışır; dosya değiştiremez, komut çalıştıramaz.
- Panel `~/.claude` altını **okur** (oturum başlıkları, dosya yolları). Ekran görüntüsü paylaşırken bunu unutmayın.

## Yapılandırma
`config/office.json` (hepsi isteğe bağlı): `providers`, `memoryDir`, `company`, `owner`, `assistant`, `projectDir`, `memoryFile`, `briefFiles`, `redLines`, `siteUrl`, `probes`. Bkz. `config/office.example.json`.

## Görseller
`public/assets/` altındaki görseller **yapay zekâ ile üretilmiştir** (ChatGPT görsel üretimi) ve bu projenin MIT lisansı altında paylaşılır; kaynak bildirimi (C2PA) üst verisi temizlenmiştir.

## Lisans
MIT — bkz. [LICENSE](LICENSE).
