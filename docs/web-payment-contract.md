# MedAsi Payment Contract

Bu sözleşme Qlinik ve Praticase ödeme kanallarını kapsar. Sepet, tutar, hak ve
banka bilgisi ödeme servisinde oluşturulur; frontend tutarı belirleyen kaynak
değildir.

## Checkout session

Qlinik veya Praticase backend'i kendi içinde ödeme talebini oluşturur ve ödeme
servisine checkout session oluşturma isteği gönderir. Fiyat, IBAN ve hak bilgisi
istemciden alınmaz.

```json
{
  "channel": "android",
  "product": "qlinik",
  "accountId": "user_123",
  "customerEmail": "ogrenci@qlinik.com",
  "customerName": "Qlinik Kullanıcısı",
  "returnUrl": "https://qlinik.medasi.com.tr/",
  "webhookUrl": "https://qlinik.medasi.com.tr/functions/v1/qlinik",
  "items": [
    {
      "sku": "coin_50",
      "name": "50 MedAsi Coin",
      "quantity": 1,
      "unitPrice": 40,
      "priceCents": 4000,
      "currency": "TRY",
      "entitlementType": "coin",
      "entitlementQuantity": 50,
      "metadata": {
        "code": "coin_50",
        "coin_amount": 50,
        "question_amount": 0
      }
    }
  ],
  "metadata": {
    "source": "qlinik",
    "product": {
      "code": "coin_50",
      "name": "50 MedAsi Coin"
    }
  }
}
```

Yanıt:

```json
{
  "checkoutUrl": "https://odeme.medasi.com.tr/?token=pay_qln_8f3k2",
  "trackingUrl": "https://odeme.medasi.com.tr/?page=track",
  "token": "pay_qln_8f3k2",
  "reference": "QLN-8F3K2",
  "orderId": "ord_1001",
  "expiresAt": "2026-05-27T15:30:00+03:00"
}
```

## Checkout access

`odeme.medasi.com.tr` doğrudan açıldığında ödeme detayı göstermez. Ekran yalnız
geçerli ve süresi dolmamış checkout tokenı ile çalışır.

Ekran tokenı aldıktan sonra ödeme detayını servis tarafından dönen oturumdan
render eder:

```json
{
  "orderId": "ord_1001",
  "channel": "android",
  "product": "qlinik",
  "accountId": "user_123",
  "customerEmail": "ogrenci@qlinik.com",
  "customerName": "Qlinik Kullanıcısı",
  "reference": "QLN-8F3K2",
  "expiresAt": "2026-05-27T17:00:00+03:00",
  "bankAccount": {
    "holder": "MedAsi Teknoloji A.Ş.",
    "iban": "TR11 0006 2000 0000 0123 4567 89"
  },
  "items": [
    {
      "sku": "coin_50",
      "name": "50 MedAsi Coin",
      "quantity": 1,
      "unitPrice": 40,
      "priceCents": 4000,
      "currency": "TRY",
      "entitlementType": "coin",
      "entitlementQuantity": 50
    }
  ],
  "totalAmount": 40,
  "currency": "TRY",
  "status": "payment_pending"
}
```

## Order status

Durumlar:

- `payment_pending`
- `receipt_uploaded`
- `review`
- `approved`
- `entitled`
- `rejected`

## Receipt upload

Kullanıcı transferi yaptıktan sonra dekontu multipart form ile yükler.

```http
POST /api/orders/ord_1001/receipt
Content-Type: multipart/form-data
```

Alanlar:

- `receipt`: PDF, PNG veya JPG dekont dosyası
- `token`: checkout tokenı

## Order tracking

Sipariş takip sayfası e-posta ve açıklama kodu ile çalışır.

```http
POST /api/orders/track
Content-Type: application/json
```

```json
{
  "email": "muhasebe@klinik.com",
  "reference": "QLN-8F3K2"
}
```

Yanıt ödeme oturumundaki sipariş gövdesi ile aynı formatı kullanır ve `status`
alanını içerir.

## Admin review

Admin panel siparişleri, paket bilgisini ve dekontu admin API üzerinden alır.
Her istek `X-MedAsi-Admin-Key` veya `Authorization: Bearer <key>` ile
korunmalıdır.

```http
GET /api/admin/orders
GET /api/admin/orders/ord_1001
GET /api/admin/orders/ord_1001/receipt
```

`GET /api/admin/orders/:id/receipt` dekontu `inline` olarak döndürür; panel bu
yanıtı dosya önizleme veya indirme için kullanabilir.

## Entitlement webhook

Onay sonrası ödeme servisi ilgili ürüne imzalı webhook gönderir.

```json
{
  "action": "payment_entitlement_webhook",
  "event": "payment.entitlement_granted",
  "channel": "android",
  "product": "qlinik",
  "orderId": "ord_1001",
  "reference": "QLN-8F3K2",
  "accountId": "user_123",
  "customerEmail": "ogrenci@qlinik.com",
  "approvedAt": "2026-05-27T15:05:00+03:00",
  "items": [
    {
      "sku": "coin_50",
      "entitlementType": "coin",
      "entitlementQuantity": 50
    }
  ]
}
```

Webhook doğrulaması için `X-MedAsi-Signature: sha256=<hex>` zorunludur.
