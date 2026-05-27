# MedAsi Ödeme

`odeme.medasi.com.tr` için bağımsız banka transferi ödeme ve sipariş takip ekranı.

Bu servis Qlinik ve Praticase tarafından üretilen ödeme oturumlarını gösterir.
Kullanıcı ödeme sayfasına doğrudan girmez; ödeme talebi ilgili uygulamada oluşur,
uygulama tek kullanımlık token üretir ve kullanıcı ödeme ekranına yönlendirilir.

Sanal POS veya kart ödeme akışları bu projeye dahil değildir.

## Sayfalar

- Ödeme: Qlinik veya Praticase tokenı ile açılır; IBAN, açıklama kodu, tutar ve dekont yükleme gösterir.
- Sipariş takip: kullanıcı e-posta ve açıklama kodu ile sipariş durumunu kontrol eder.
- Token yoksa: ödeme oturumu bulunamadı ekranı görünür.

## Yerel çalışma

Statik dosya olarak demo token ile açılabilir:

```sh
open "index.html?token=pay_qlinik_demo"
open "index.html?token=pay_praticase_demo"
open "index.html?page=track"
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

## Coolify

Yeni bağımsız uygulama için önerilen ayarlar:

- Build type: Dockerfile
- Port: `3000`
- Domain: `odeme.medasi.com.tr`
- Healthcheck: `/health`
- Branch: `main`

## Üretim sınırı

Ödeme servisi kendi deposu, kendi domaini ve kendi verisi ile bağımsız
kalmalıdır. Qlinik ve Praticase sadece checkout session oluşturur veya var olan
tokenı açar; sepet oluşturma ekranı ve public admin sekmesi bu projede bulunmaz.
Onay sonrası hak tanımı webhook ile ilgili ürüne bildirilir.

## Sonraki backend adımı

İlk API sınırı:

- `POST /api/checkout-sessions`
- `GET /api/checkout-sessions/:token`
- `POST /api/orders/:id/receipt`
- `POST /api/orders/track`
- `POST /api/admin/orders/:id/approve`
- `POST /api/admin/orders/:id/reject`
- `POST /api/admin/orders/:id/grant-entitlement`

Sanal POS geldiğinde aynı `orders` yapısı kullanılmalı; yalnız ödeme kanalı
`bank_transfer` yerine `card` olarak işlenmelidir.
