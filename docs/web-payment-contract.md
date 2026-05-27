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
  "channel": "web",
  "product": "qlinik",
  "accountId": "clinic_123",
  "customerName": "Özel Klinik",
  "returnUrl": "https://qlinik.medasi.com.tr/account/billing",
  "items": [
    {
      "sku": "doctor_monthly",
      "name": "Doktor paketi",
      "quantity": 1,
      "unitPrice": 1490,
      "entitlementType": "license",
      "entitlementQuantity": 1
    }
  ]
}
```

Yanıt:

```json
{
  "checkoutUrl": "https://odeme.medasi.com.tr/?token=pay_qln_8f3k2",
  "token": "pay_qln_8f3k2",
  "reference": "QLN-8F3K2",
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
  "channel": "web",
  "product": "Qlinik",
  "accountId": "clinic_123",
  "customerEmail": "muhasebe@klinik.com",
  "customerName": "Özel Klinik",
  "reference": "QLN-8F3K2",
  "expiresAt": "2026-05-27T17:00:00+03:00",
  "bankAccount": {
    "holder": "MedAsi Teknoloji A.Ş.",
    "iban": "TR11 0006 2000 0000 0123 4567 89"
  },
  "items": [
    {
      "sku": "doctor_monthly",
      "name": "Doktor paketi",
      "quantity": 1,
      "unitPrice": 1490,
      "entitlementType": "license",
      "entitlementQuantity": 1
    }
  ],
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

## Entitlement webhook

Onay sonrası ödeme servisi ilgili ürüne imzalı webhook gönderir.

```json
{
  "event": "payment.entitlement_granted",
  "channel": "web",
  "product": "qlinik",
  "orderId": "ord_1001",
  "reference": "QLN-8F3K2",
  "accountId": "clinic_123",
  "items": [
    {
      "sku": "doctor_monthly",
      "entitlementType": "license",
      "entitlementQuantity": 1
    }
  ]
}
```

Webhook doğrulaması için `X-MedAsi-Signature` zorunlu olmalıdır.
