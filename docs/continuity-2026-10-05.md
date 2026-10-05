# 5 Ekim 2026 — Codex'ten sonraki Claude oturumuna

Kuzey'in isteği: ofis 7/24 görev üretsin, internet/Claude/ücretsiz API limitinde hafızasını kaybetmesin. Bu çalışma ofis deposunda yapıldı; müşteri siteleri yayınlanmadı.

## Yapılanlar
- Gece durması varsayılan olarak kaldırıldı; isteğe bağlı `quietHours` korunuyor.
- Ücretsiz görevlerin Claude limitine bağımlılığı kaldırıldı; uygun Groq/Gemini veya yerel sağlayıcı beklenir.
- API 429 sonrası diğer sağlayıcı denenir, cooldown diskte saklanır. Retry-After saniye/tarih desteklenir.
- Görev hataları artan aralıkla (30 saniye–30 dakika) tekrar denenir.
- İstanbul gün sınırı kullanılır; bitmemiş görevler yeni güne taşınır, eski gün arşivlenir.
- Başarılı API yanıtı önce görev kaydına yazılır; yeniden başlatmada aynı yanıtla çıktı kurtarılır.
- JSON ve çıktı yazımları geçici dosya + fsync + atomik rename kullanır.
- Sohbet soruları yanıt alınmadan kuyruktan çıkarılmaz; kuyruk düzenli yeniden denenir.
- Limit taraması tarayıcıdan bağımsız her 10 saniyede çalışır. `handoff/STATE.json` güncel durumu tutar.
- İlk başarısız bağlantı kontrolünde devir yazılır (kontrol aralığı 10 saniye, timeout 4 saniye). Kesin çevrimdışı durumu üç hata ile belirlenir.
- Periyodik devir notu ve Claude hafıza bağlantısı korunur; aynı neden için 10 dakika yazım sınırı vardır.
- Arayüz gerçek görev durumu, sağlayıcı bekleme ve tekrar deneme zamanını gösterir. Yapay 75 saniye çalışma süresi kaldırıldı.

## Kayıtların anlamı
- `data/workday.json`: yürütülebilir kuyruk, son yanıt, deneme sayısı, tekrar zamanı.
- `data/workday-history/`: önceki günler.
- `data/workday/`: taslak çıktılar.
- `data/provider-state.json`: sağlayıcı bekleme süreleri; anahtar içermez.
- `data/askqueue.json`: bekleyen sorular; `data/chat.json`: yanıtlar.
- `handoff/STATE.json`: güncel makine tarafından okunabilir özet.
- `handoff/LATEST.md`: okunabilir devir; eski hafıza açıkça tarihî etiketlenir.

## Sınırlar
Mac kapalı/uykudayken işlem yapılamaz. Prizde sleep=0, pilde sleep=1 gözlendi; güç ayarları değiştirilmedi. Yerel Ollama yapılandırmada kapalı. İnternetsiz üretim bu yüzden bekler; görevler silinmez. Uzak sunucuda tamamlanıp yanıtı diske ulaşmayan bir API çağrısı tekrar edebilir; tam olarak bir kez yürütme garantisi yoktur. Disk arızası için harici yedek gerekir. Ofis görev motoru taslak üretir; ayrı bir Claude terminalinin yürütme bağlamını veya kod yazma yetkisini devralmaz.

## Önceki notlardaki çelişkiler
Panel, 5 Ekim öncesindeki talepleri tarih kuralıyla test/demo sayıyor. Bugün listesindeki “10 talebi ara” maddesi bu sınıflandırmayla çelişiyor; ham kayıt sayısını gerçek fırsat sayısı sanma. KDV, GTM ve EN göçü için Vinci dosyalarında farklı tarihlerden kalan notlar var; değişiklikten önce ilgili gerçek kaynağı doğrula.

## Kuzey'in paylaştığı son Stage Medya konuşması
Kullanıcının aktardığı son durum: e195711 ile logo listesi de commit/push edilmiş; önceki “logos.ts boş” notu eskimiş olabilir. Diğer sayfaların tasarımı, bazı Instagram görselleri ve mobil/masaüstü kontrolü bekliyor. Bu çalışma Stage Medya commitlerini veya canlı sürümünü doğrulamadı. Başlamadan `../stage-medya/docs/devir-2026-10-05.md` ve gerçek Git durumunu oku. Ofis iyileştirmesini Stage Medya üzerinde çalışma/yayın yetkisi olarak yorumlama.

## Doğrulama
`node --test tests/*.test.mjs`: atomik kayıt, limitten bağımsız ücretsiz iş, hata/tekrar, gün değişimi, aktif görev koruması, kayıtlı yanıt kurtarma, 429 sağlayıcı geçişi/yeniden başlatma ve özel bağlamın uzak sağlayıcıya gitmemesi.

## Codex katkısı (aynı gün)
Claude ve ücretsiz sağlayıcı limitlerine Codex CLI desteği bağlandı. Bugün/Sohbet panellerinde durumu ve son katkısı görünür; çağrı sırasında ofiste Codex çalışanı da aktiftir. Mevcut ChatGPT oturumu kullanılır. Bağımsız masaüstü sohbetleri izlenmez. Sadece taslak/soru yanıtı; müşteri reposunda kod çalıştırma ve yayın yetkisi verilmedi. Toplantı scriptleri hâlâ Claude’a özgüdür.
