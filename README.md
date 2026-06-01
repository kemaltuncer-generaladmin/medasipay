# MedAsi Ödeme

`odeme.medasi.com.tr` için bağımsız kart, banka transferi ödeme ve sipariş takip ekranı.

Bu servis Qlinik, Praticase ve SourceBase/CardStation tarafından üretilen ödeme oturumlarını gösterir.
Kullanıcı ödeme sayfasına doğrudan girmez; ödeme talebi ilgili uygulamada oluşur,
uygulama tek kullanımlık token üretir ve kullanıcı ödeme ekranına yönlendirilir.

Kart ödemeleri Kuveyt Türk Sanal POS 3D Secure Model ile alınır. IBAN ile EFT/havale
akışı aynı ekranda eski dekont yükleme akışıyla çalışmaya devam eder.

## Sayfalar

- Ödeme: Qlinik, Praticase veya SourceBase tokenı ile açılır; kullanıcı IBAN veya kart ödeme yöntemini seçer.
- Sipariş takip: kullanıcı e-posta ve açıklama kodu ile sipariş durumunu kontrol eder.
- Token yoksa: doğrudan sipariş takip ekranı görünür; ödeme sekmesi yalnız tokenlı bağlantıda açılır.

## Yerel çalışma

Node servisi ile canlı API akışı yerelde çalıştırılabilir:

```sh
MEDASIPAY_API_KEY=dev-api-key \
MEDASIPAY_ADMIN_KEY=dev-admin-key \
MEDASIPAY_WEBHOOK_SECRET=dev-webhook-secret \
APP_URL=http://localhost:3000 \
node server.js
```

Statik demo tokenları da yerel önizleme için açıktır:

```sh
open "http://localhost:3000/?token=pay_qlinik_demo"
open "http://localhost:3000/?token=pay_praticase_demo"
open "http://localhost:3000/?page=track"
```

Docker ile:

```sh
docker compose up --build
```

Uygulama `http://localhost:3000/?token=pay_qlinik_demo` adresinden test edilir.
Sipariş takip demo için `http://localhost:3000/?page=track` açılır.

Demo takip bilgileri:

- Qlinik: `demo@qlinik.com` ve `QLN-8F3K2`
- Praticase: `demo@praticase.com` ve `PRC-92A7X`

Yerel önizlemede `amount`, `reference`, `iban` gibi query alanlarıyla hızlı test
yapılabilir. Üretimde tutar, IBAN ve ödeme kalemleri URL'den güvenilir kabul
edilmez; ekran tokenı `GET /api/checkout-sessions/:token` yanıtından doğrular.
`APP_ENV=production` iken `BANK_IBAN` zorunludur; gerçek IBAN girilmeden
checkout session oluşturulmaz.

## Coolify

Yeni bağımsız uygulama için önerilen ayarlar:

- Build type: Dockerfile
- Port: `3000`
- Domain: `odeme.medasi.com.tr`
- Healthcheck: `/health`
- Branch: `main`

## Canlı API

Qlinik ve Praticase backendleri checkout session oluştururken
`X-MedAsi-Api-Key` ile `MEDASIPAY_API_KEY` gönderir:

```http
POST /api/checkout-sessions
Content-Type: application/json
X-MedAsi-Api-Key: <MEDASIPAY_API_KEY>
```

Servis canlı olarak şu endpointleri sağlar:

- `POST /api/checkout-sessions`
- `GET /api/checkout-sessions/:token`
- `POST /api/orders/:id/receipt`
- `POST /api/orders/:id/card/initiate`
- `POST /api/kuveytpos/3d-callback/success`
- `POST /api/kuveytpos/3d-callback/fail`
- `POST /api/orders/track`
- `GET /api/admin/orders`
- `GET /api/admin/orders/:id`
- `GET /api/admin/orders/:id/receipt`
- `POST /api/admin/push-devices`
- `DELETE /api/admin/push-devices`
- `POST /api/admin/orders/:id/approve`
- `POST /api/admin/orders/:id/reject`
- `POST /api/admin/orders/:id/grant-entitlement`

Kart ödeme başlatma endpointi kullanıcıdan kart ve 3D Secure 2.x için gerekli
fatura/telefon alanlarını alır, Kuveyt Türk `ThreeDModelPayGate` yanıtını
tarayıcıya iletir. Banka `OkUrl` dönüşünde MD değerini gönderdiğinde servis
`ThreeDModelProvisionGate` ile provizyon alır; `ResponseCode=00` dönerse sipariş
kart kanalıyla onaylanır ve entitlement webhook otomatik denenir.
Ödeme formu kart numarasını, son kullanma tarihini veya CVV / CVC değerini
saklamaz. Kart üzerindeki ad, telefon ve fatura adresi gibi hassas olmayan
alanlar sonraki ödemeleri kolaylaştırmak için yalnız kullanıcının tarayıcısında
hatırlanır.

Kuveyt Türk canlı Sanal POS IP beyaz listesi için ödeme sunucusunun dışarıya
çıkan sabit IPv4 adresi kullanılmalıdır. Cloudflare DNS adresleri bu amaçla
kullanılmaz.

Admin endpointleri `MEDASIPAY_ADMIN_KEY` ile korunur. Admin panel sipariş
listesini, paket bilgisini, müşteri e-postasını, açıklama kodunu ve dekontu bu
endpointlerden okuyabilir. Sipariş onaylandığında servis `MEDASIPAY_WEBHOOK_SECRET`
ile imzalı entitlement webhook gönderir.

Admin panel uygulaması APNs cihaz tokenını `POST /api/admin/push-devices`
ile kaydeder. Dekont yüklendiğinde ödeme servisi kayıtlı iOS admin cihazlarına
sesli push bildirimi gönderir. APNs için `APNS_TEAM_ID`, `APNS_KEY_ID`,
`APNS_BUNDLE_ID` ve `APNS_AUTH_KEY_PATH` veya `APNS_AUTH_KEY` tanımlanmalıdır.
`APNS_CRITICAL_ALERTS=true` yalnız Apple Critical Alerts entitlement varsa
kullanılmalıdır; aksi halde servis normal sesli ve time-sensitive bildirim
gönderir.

Canlı ortamda hak tanımı yalnız ürünün beklenen webhook hedefiyle eşleşen
checkout oturumlarına yapılır (`QLINIK_PAYMENT_WEBHOOK_URL`,
`PRATICASE_PAYMENT_WEBHOOK_URL` ve `SOURCEBASE_PAYMENT_WEBHOOK_URL`). Banka transferinde admin onayı ve hak tanımı
için dekont yüklenmiş olmalıdır; servis dekontu 3 MB boyut sınırı yanında
PDF/PNG/JPEG dosya imzasından da doğrular ve süresi dolmuş ödeme oturumuna yükleme
kabul etmez. Kart ödemesinde Kuveyt Türk provizyonu başarılıysa dekont aranmaz.
Admin onayı onaylayan kullanıcıyı, zamanı ve hak tanımı denemelerini kaydeder;
yeniden hak tanımı denemeleri paket süresini ilk onay anına sabit tutar.
Aynı kullanıcı ve uygulama için açık bir abonelik ödeme oturumu varken yeni
bir oturum üretmek yerine mevcut ödeme bağlantısı döndürülür.

## Üretim sınırı

Ödeme servisi kendi deposu, kendi domaini ve kendi verisi ile bağımsız
kalmalıdır. Qlinik, Praticase ve SourceBase yalnız checkout session oluşturur veya var olan
tokenı açar; sepet oluşturma ekranı bu projede bulunmaz. Onay sonrası hak tanımı
webhook ile ilgili ürüne bildirilir.

Ödeme kanalı aynı `orders` yapısında `paymentMethod` ile izlenir:
`bank_transfer` dekontlu eski akış, `card` Kuveyt Türk Sanal POS akışıdır.
