# Güvenlik

## Güvenlik açığı bildirimi
Lütfen açığı **herkese açık issue olarak açmayın**. GitHub'daki *Security → Report a vulnerability* (özel bildirim) bölümünü kullanın. Elimizden geldiğince hızlı yanıtlanır.

## Tehdit modeli
Bu araç tek kullanıcılı, yerel bir panodur; çok kullanıcılı bir servis **değildir**.
- **Korunan:** başka web sitelerinin (DNS rebinding, CSRF) ve aynı ağdaki yabancıların paneli okuması/yönetmesi; dosya sunumunda yol atlatma; PIN kaba kuvvet saldırısı.
- **Korunmayan:** bilgisayarınıza zaten erişimi olan bir yerel kullanıcı/zararlı yazılım (`~/.claude` altını doğrudan okuyabilir). Düz HTTP üzerinden ağ erişimi: trafik şifresizdir.

## Yapılan önlemler
Yalnızca `127.0.0.1` · yerel modda Host doğrulaması · oturum başına rastgele yazma jetonu · PIN'li ağ modunda rastgele oturum kimliği, sabit zamanlı karşılaştırma, 5 denemede 15 dk kilit · CSP, `X-Frame-Options: DENY`, `nosniff` · statik dosyalarda `path.resolve` + kök dizin sınırı, nokta-dosyaları engelli · harici RSS bağlantıları yalnızca `http(s)` · Claude çağrıları plan modu + salt-okunur araçlar + harcama tavanı · konfigürasyon değerleri kabuk/HTML bağlamına girmeden önce temizlenir.

## Yapay zekâ sağlayıcıları
Anahtarlar yalnızca `config/keys.env` veya ortam değişkeninden okunur; loglanmaz, API çıktısına girmez, repoya girmez (`.gitignore`). Uzak uçlar yalnızca `https` olabilir, `http` yalnızca bu bilgisayar (Ollama vb.) için kabul edilir; yönlendirme (redirect) takip edilmez. Uzak sağlayıcıya yalnızca herkese açık metin gönderilir. Kota/anahtar hatasında sağlayıcı geçici olarak devre dışı kalır (anahtar 6 saat, kota `Retry-After`).

## Sizden beklenenler
`config/office.json`, `config/keys.env`, `data/`, `handoff/`, `meetings/` ve `.env*` dosyalarını asla commit etmeyin (`.gitignore`'da). Paneli internete açmayın.
