const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const http2 = require("node:http2");
const http = require("node:http");
const path = require("node:path");

const port = Number(process.env.PORT || 3000);
const configuredAppUrl = String(process.env.APP_URL || "").trim();
const appUrl = trimTrailingSlash(configuredAppUrl || `http://localhost:${port}`);
const dataDir = process.env.DATA_DIR || path.join(__dirname, "data");
const receiptDir = path.join(dataDir, "receipts");
const ordersFile = path.join(dataDir, "orders.json");
const devicesFile = path.join(dataDir, "admin-devices.json");
const publicDir = __dirname;
const maxJsonBytes = 128 * 1024;
const maxReceiptBytes = Number(process.env.MAX_RECEIPT_BYTES || 3 * 1024 * 1024);
const maxCardFormBytes = 64 * 1024;
const maxKuveytCallbackBytes = 512 * 1024;
const defaultBankAccount = {
  holder: "MedAsi Teknoloji A.Ş.",
  iban: "TR11 0006 2000 0000 0123 4567 89",
};
const kuveytPosEndpoints = {
  testPayGate:
    "https://boatest.kuveytturk.com.tr/boa.virtualpos.services/Home/ThreeDModelPayGate",
  testProvisionGate:
    "https://boatest.kuveytturk.com.tr/boa.virtualpos.services/Home/ThreeDModelProvisionGate",
  productionPayGate:
    "https://sanalpos.kuveytturk.com.tr/ServiceGateWay/Home/ThreeDModelPayGate",
  productionProvisionGate:
    "https://sanalpos.kuveytturk.com.tr/ServiceGateWay/Home/ThreeDModelProvisionGate",
};
const kuveytSandboxCardFixture = {
  cardNumber: "5188961939192544",
  month: "06",
  year: "25",
  cvv: "929",
};
const defaultPaymentWebhookUrls = {
  qlinik: "https://qlinik.medasi.com.tr/functions/v1/qlinik",
  praticase: "https://qlinik.medasi.com.tr/functions/v1/praticase-storekit-verify",
  sourcebase: "https://medasi.com.tr/functions/v1/sourcebase",
};
let storeMutationQueue = Promise.resolve();
let deviceMutationQueue = Promise.resolve();
let cachedApnsJwt = null;

const server = http.createServer(async (request, response) => {
  try {
    await route(request, response);
  } catch (error) {
    sendError(response, error);
  }
});

server.listen(port, async () => {
  await ensureDataDirs();
  console.log(`MedAsi Pay listening on ${port}`);
  if (
    isLocalBaseUrl(appUrl) &&
    (process.env.APP_ENV === "production" || kuveytPosMode() === "production")
  ) {
    console.warn(
      "APP_URL is local while Kuveyt POS is production. Callbacks will use the request host when possible.",
    );
  }
});

async function route(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  const pathname = decodeURIComponent(url.pathname);
  const method = request.method || "GET";

  if (method === "GET" && pathname === "/health") {
    sendText(response, 200, "ok\n", "text/plain; charset=utf-8");
    return;
  }

  if (pathname === "/api/support") {
    await routeSupport(request, response, method);
    return;
  }

  if (method === "POST" && pathname === "/api/checkout-sessions") {
    requireServiceKey(request);
    const order = await createOrder(await readJson(request));
    sendJson(response, 201, checkoutResponse(order));
    return;
  }

  const cardInitiateMatch = pathname.match(/^\/api\/orders\/([^/]+)\/card\/initiate$/);
  if (method === "POST" && cardInitiateMatch) {
    const result = await initiateCardPayment(
      cardInitiateMatch[1],
      await readFormUrlEncoded(request, maxCardFormBytes),
      request,
    ).catch((error) => ({ error }));
    if (result.error) {
      sendHtml(
        response,
        result.error.statusCode || 500,
        renderCardResultPage(
          "Kart ödemesi başlatılamadı",
          result.error.statusCode === 500
            ? "Sanal POS isteği şu anda tamamlanamadı. Lütfen tekrar deneyin veya IBAN ile devam edin."
            : result.error.message,
        ),
      );
      return;
    }
    sendHtml(response, 200, result.html);
    return;
  }

  if (
    pathname === "/api/kuveytpos/3d-callback/success" ||
    pathname === "/api/kuveytpos/3d-callback/fail"
  ) {
    if (method !== "POST") {
      redirect(response, checkoutResultUrl(null, "failed", "Kart doğrulama dönüşü eksik."));
      return;
    }
    await handleKuveytPosCallback(
      request,
      response,
      pathname.endsWith("/success"),
    );
    return;
  }

  const checkoutMatch = pathname.match(/^\/api\/checkout-sessions\/([^/]+)$/);
  if (method === "GET" && checkoutMatch) {
    const order = await findOrderByToken(checkoutMatch[1]);
    if (!order || isExpired(order)) {
      sendJson(response, 404, { error: "Ödeme oturumu bulunamadı." });
      return;
    }
    sendJson(response, 200, publicOrder(order));
    return;
  }

  const receiptMatch = pathname.match(/^\/api\/orders\/([^/]+)\/receipt$/);
  if (method === "POST" && receiptMatch) {
    const multipart = await readMultipart(request);
    const token = stringValue(multipart.fields.token || url.searchParams.get("token"));
    if (!token) throw httpError(400, "Ödeme tokenı eksik.");
    if (!multipart.file) throw httpError(400, "Dekont dosyası eksik.");
    const updated = await updateOrder(receiptMatch[1], (order) => {
      if (order.token !== token) throw httpError(403, "Ödeme tokenı eşleşmedi.");
      if (isExpired(order)) throw httpError(410, "Ödeme oturumunun süresi doldu.");
      if (isTerminalStatus(order.status)) {
        throw httpError(409, "Bu sipariş artık dekont kabul etmiyor.");
      }
      return saveReceipt(order, multipart.file);
    });
    notifyReceiptUploaded(updated).catch((error) => {
      console.error("Receipt push notification failed", error);
    });
    sendJson(response, 200, publicOrder(updated));
    return;
  }

  if (method === "POST" && pathname === "/api/orders/track") {
    const body = await readJson(request);
    const email = normalizeEmail(body.email);
    const reference = normalizeReference(body.reference);
    if (!email || !reference) {
      sendJson(response, 400, { error: "E-posta ve açıklama kodu zorunlu." });
      return;
    }
    const store = await readStore();
    const order = store.orders.find((item) =>
      normalizeEmail(item.customerEmail) === email &&
      normalizeReference(item.reference) === reference
    );
    if (!order) {
      sendJson(response, 404, { error: "Sipariş bulunamadı." });
      return;
    }
    sendJson(response, 200, publicOrder(order));
    return;
  }

  if (pathname.startsWith("/api/admin/")) {
    await routeAdmin(request, response, method, pathname, url);
    return;
  }

  if (method === "GET" || method === "HEAD") {
    await serveStatic(pathname, response, method === "HEAD");
    return;
  }

  sendJson(response, 405, { error: "Method not allowed" });
}

async function routeAdmin(request, response, method, pathname, url) {
  requireAdminKey(request);

  if (method === "POST" && pathname === "/api/admin/push-devices") {
    const device = await registerPushDevice(await readJson(request));
    sendJson(response, 200, { device });
    return;
  }

  if (method === "DELETE" && pathname === "/api/admin/push-devices") {
    const body = await readJson(request);
    await deletePushDevice(requiredDeviceToken(body.deviceToken));
    sendJson(response, 200, { ok: true });
    return;
  }

  if (method === "GET" && pathname === "/api/admin/orders") {
    const status = stringValue(url.searchParams.get("status"));
    const store = await readStore();
    const orders = store.orders
      .filter((order) => !status || order.status === status)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .map(adminOrder);
    sendJson(response, 200, { orders });
    return;
  }

  const orderMatch = pathname.match(/^\/api\/admin\/orders\/([^/]+)$/);
  if (method === "GET" && orderMatch) {
    const order = await findOrder(orderMatch[1]);
    if (!order) {
      sendJson(response, 404, { error: "Sipariş bulunamadı." });
      return;
    }
    sendJson(response, 200, { order: adminOrder(order) });
    return;
  }

  const receiptMatch = pathname.match(/^\/api\/admin\/orders\/([^/]+)\/receipt$/);
  if (method === "GET" && receiptMatch) {
    const order = await findOrder(receiptMatch[1]);
    if (!order?.receipt?.storagePath) {
      sendJson(response, 404, { error: "Dekont bulunamadı." });
      return;
    }
    const filePath = path.resolve(order.receipt.storagePath);
    if (!filePath.startsWith(`${path.resolve(receiptDir)}${path.sep}`)) {
      sendJson(response, 403, { error: "Dekont yolu geçersiz." });
      return;
    }
    const file = await fs.readFile(filePath);
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": order.receipt.mimeType,
      "Content-Security-Policy": "sandbox",
      "Content-Disposition":
        `inline; filename="${safeHeaderFilename(order.receipt.originalName)}"`,
      "X-Content-Type-Options": "nosniff",
    });
    response.end(file);
    return;
  }

  const approveMatch = pathname.match(/^\/api\/admin\/orders\/([^/]+)\/approve$/);
  if (method === "POST" && approveMatch) {
    const updated = await approveOrder(approveMatch[1], await readJson(request));
    sendJson(response, 200, { order: adminOrder(updated) });
    return;
  }

  const rejectMatch = pathname.match(/^\/api\/admin\/orders\/([^/]+)\/reject$/);
  if (method === "POST" && rejectMatch) {
    const body = await readJson(request);
    const reason = stringValue(body.reason).slice(0, 500);
    const updated = await updateOrder(rejectMatch[1], (order) => {
      if (order.status === "entitled" || order.status === "approved") {
        throw httpError(409, "Onaylanmış sipariş reddedilemez.");
      }
      if (order.status === "rejected") return order;
      return {
        ...order,
        status: "rejected",
        rejectionReason: reason,
        rejectedBy: stringValue(body.adminActor) || "admin",
        rejectedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    });
    sendJson(response, 200, { order: adminOrder(updated) });
    return;
  }

  const grantMatch = pathname.match(
    /^\/api\/admin\/orders\/([^/]+)\/grant-entitlement$/,
  );
  if (method === "POST" && grantMatch) {
    const updated = await grantEntitlement(grantMatch[1], await readJson(request));
    sendJson(response, 200, { order: adminOrder(updated) });
    return;
  }

  sendJson(response, 404, { error: "Admin endpoint bulunamadı." });
}

const supportRateState = new Map();
const SUPPORT_RATE_WINDOW_MS = 10 * 60 * 1000;
const SUPPORT_RATE_LIMIT = 5;

function supportCorsAllowed() {
  const raw = stringValue(process.env.SUPPORT_CORS_ORIGINS) ||
    "https://odeme.medasi.com.tr,https://indir.medasi.com.tr";
  return raw.split(",").map((value) => value.trim()).filter(Boolean);
}

function supportCorsHeaders(request) {
  const origin = stringValue(request.headers.origin);
  if (!origin) return {};
  const allowed = supportCorsAllowed();
  if (!allowed.includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "600",
    "Vary": "Origin",
  };
}

function clientIp(request) {
  const forwarded = String(request.headers["x-forwarded-for"] || "")
    .split(",")[0]
    .trim();
  return forwarded || request.socket?.remoteAddress || "unknown";
}

function checkSupportRateLimit(ip) {
  const now = Date.now();
  const state = supportRateState.get(ip);
  if (!state || state.resetAt < now) {
    supportRateState.set(ip, { count: 1, resetAt: now + SUPPORT_RATE_WINDOW_MS });
    return true;
  }
  if (state.count >= SUPPORT_RATE_LIMIT) return false;
  state.count += 1;
  return true;
}

async function routeSupport(request, response, method) {
  const headers = supportCorsHeaders(request);
  if (method === "OPTIONS") {
    response.writeHead(204, headers);
    response.end();
    return;
  }
  if (method !== "POST") {
    sendJson(response, 405, { error: "Method not allowed" }, headers);
    return;
  }

  try {
    const ip = clientIp(request);
    if (!checkSupportRateLimit(ip)) {
      sendJson(response, 429, {
        error: "Çok fazla istek. Lütfen birkaç dakika sonra tekrar deneyin.",
      }, headers);
      return;
    }

    const body = await readJson(request);

    if (stringValue(body.website)) {
      sendJson(response, 200, { ok: true }, headers);
      return;
    }

    const name = stringValue(body.name).slice(0, 200);
    const email = normalizeEmail(stringValue(body.email)).slice(0, 320);
    const subject = stringValue(body.subject).slice(0, 200);
    const message = stringValue(body.message).slice(0, 5000);
    const source = enumValue(body.source, ["odeme", "indir"], "odeme");

    if (!name) throw httpError(400, "Ad zorunlu.");
    if (!isValidSupportEmail(email)) throw httpError(400, "Geçerli bir e-posta girin.");
    if (message.length < 10) throw httpError(400, "Mesaj en az 10 karakter olmalı.");

    const apiKey = stringValue(process.env.RESEND_API_KEY);
    if (!apiKey) throw httpError(503, "Destek servisi şu an yapılandırılmamış.");

    const supportTo = stringValue(process.env.SUPPORT_EMAIL) || "destek@medasi.com.tr";
    const supportFrom = stringValue(process.env.SUPPORT_FROM_EMAIL) ||
      "MedAsi Destek <destek@medasi.com.tr>";
    const sourceLabel = source === "indir" ? "MedAsi İndirme" : "MedAsi Ödeme";
    const subjectLine = subject
      ? `[${sourceLabel}] ${subject}`
      : `[${sourceLabel}] Yeni destek talebi`;

    await sendResendEmail(apiKey, {
      from: supportFrom,
      to: supportTo,
      replyTo: email,
      subject: subjectLine,
      html: renderSupportEmailHtml({ name, email, subject, message, source: sourceLabel, ip }),
      text: renderSupportEmailText({ name, email, subject, message, source: sourceLabel }),
    });

    sendJson(response, 200, { ok: true }, headers);
  } catch (error) {
    const status = error.statusCode || 500;
    const message = status === 500 ? "Beklenmeyen destek servisi hatası." : error.message;
    if (status === 500) console.error(error);
    sendJson(response, status, { error: message }, headers);
  }
}

function isValidSupportEmail(value) {
  if (!value || value.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function escapeHtmlValue(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  })[char]);
}

function renderSupportEmailHtml({ name, email, subject, message, source, ip }) {
  const esc = escapeHtmlValue;
  const subjectRow = subject
    ? `<tr><td style="padding:6px 12px;color:#64748b;">Konu</td><td style="padding:6px 12px;"><strong>${esc(subject)}</strong></td></tr>`
    : "";
  return `<div style="font-family:-apple-system,Inter,Arial,sans-serif;max-width:600px;margin:0 auto;color:#0f172a;">
  <h2 style="color:#0f766e;margin:0 0 8px;">Yeni destek talebi</h2>
  <p style="color:#64748b;margin:0 0 16px;">${esc(source)}</p>
  <table style="border-collapse:collapse;width:100%;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;">
    <tr><td style="padding:8px 12px;color:#64748b;">Ad</td><td style="padding:8px 12px;"><strong>${esc(name)}</strong></td></tr>
    <tr><td style="padding:8px 12px;color:#64748b;">E-posta</td><td style="padding:8px 12px;"><a href="mailto:${esc(email)}" style="color:#0f766e;">${esc(email)}</a></td></tr>
    ${subjectRow}
  </table>
  <h3 style="margin:20px 0 8px;">Mesaj</h3>
  <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;padding:16px;white-space:pre-wrap;">${esc(message)}</div>
  <p style="color:#94a3b8;font-size:12px;margin-top:20px;">Kaynak: ${esc(source)} · IP: ${esc(ip)}</p>
</div>`;
}

function renderSupportEmailText({ name, email, subject, message, source }) {
  const subjectLine = subject ? `Konu: ${subject}\n` : "";
  return `Yeni destek talebi (${source})\n\nAd: ${name}\nE-posta: ${email}\n${subjectLine}\nMesaj:\n${message}\n`;
}

async function sendResendEmail(apiKey, payload) {
  const requestBody = {
    from: payload.from,
    to: Array.isArray(payload.to) ? payload.to : [payload.to],
    subject: payload.subject,
    html: payload.html,
    text: payload.text,
  };
  if (payload.replyTo) requestBody.reply_to = payload.replyTo;

  let response;
  try {
    response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });
  } catch (error) {
    console.error("Resend network error:", error);
    throw httpError(502, "Destek sağlayıcısına ulaşılamadı.");
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    console.error("Resend error:", response.status, errorText.slice(0, 500));
    throw httpError(502, "Mesaj iletilemedi. Lütfen daha sonra tekrar deneyin.");
  }
  return response.json().catch(() => ({}));
}

async function createOrder(input) {
  const product = enumValue(input.product, ["qlinik", "praticase", "sourcebase"], "qlinik");
  const channel = enumValue(input.channel, ["web", "android"], "web");
  const accountId = requiredString(input.accountId, "accountId");
  const customerEmail = requiredString(input.customerEmail, "customerEmail");
  const customerName = stringValue(input.customerName) || customerEmail;
  const items = normalizeItems(input.items);
  if (!items.length) throw httpError(400, "En az bir ödeme kalemi gerekli.");

  const now = new Date();
  const expiresAt = input.expiresAt
    ? new Date(String(input.expiresAt))
    : new Date(now.getTime() + 30 * 60 * 1000);
  if (Number.isNaN(expiresAt.getTime())) {
    throw httpError(400, "Geçerlilik tarihi hatalı.");
  }
  if (expiresAt <= now || expiresAt.getTime() > now.getTime() + 24 * 3600 * 1000) {
    throw httpError(400, "Ödeme oturumu geçerlilik süresi uygun değil.");
  }

  const paymentBankAccount = bankAccount();
  const returnUrl = optionalUrl(input.returnUrl);
  const webhookUrl = paymentWebhookUrl(input.webhookUrl, product);
  return mutateStore(async (store) => {
    const subscriptionSkus = items
      .filter((item) => item.entitlementType === "subscription")
      .map((item) => item.sku);
    const existingOrder = subscriptionSkus.length
      ? store.orders.find((order) =>
        order.product === product &&
        order.accountId === accountId &&
        ["payment_pending", "receipt_uploaded", "approved"].includes(order.status) &&
        !isExpired(order) &&
        order.items.some((item) =>
          item.entitlementType === "subscription" &&
          subscriptionSkus.includes(item.sku)
        )
      )
      : null;
    if (existingOrder) return existingOrder;

    const token = uniqueValue(store.orders, "token", () =>
      `pay_${productPrefix(product).toLowerCase()}_${randomCode(16).toLowerCase()}`
    );
    const reference = uniqueValue(store.orders, "reference", () =>
      `${productPrefix(product)}-${randomCode(6)}`
    );
    const order = {
      id: uniqueValue(store.orders, "id", () => `ord_${randomCode(18).toLowerCase()}`),
      token,
      reference,
      status: "payment_pending",
      product,
      channel,
      accountId,
      customerName,
      customerEmail,
      returnUrl,
      webhookUrl,
      paymentMethod: "bank_transfer",
      bankAccount: paymentBankAccount,
      items,
      totalAmount: totalAmount(items),
      currency: input.currency || items[0]?.currency || "TRY",
      metadata: objectValue(input.metadata),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };
    store.orders.push(order);
    return order;
  });
}

function bankAccount() {
  const holder = stringValue(process.env.BANK_ACCOUNT_NAME) ||
    defaultBankAccount.holder;
  const iban = stringValue(process.env.BANK_IBAN);
  if (process.env.APP_ENV === "production") {
    if (!iban || iban === defaultBankAccount.iban) {
      throw httpError(503, "Canlı banka IBAN bilgisi yapılandırılmamış.");
    }
  }
  return {
    holder,
    iban: iban || defaultBankAccount.iban,
  };
}

function normalizeItems(items) {
  if (!Array.isArray(items)) return [];
  return items.map((item) => {
    const source = objectValue(item);
    const quantity = numberValue(source.quantity) || 1;
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 100) {
      throw httpError(400, "Paket adedi geçersiz.");
    }
    const priceCents = numberValue(source.priceCents);
    if (priceCents !== null &&
      (!Number.isSafeInteger(priceCents) || priceCents <= 0)) {
      throw httpError(400, "Paket tutarı geçersiz.");
    }
    const unitPrice = priceCents !== null
      ? priceCents / 100
      : numberValue(source.unitPrice ?? source.price ?? source.amount) || 0;
    if (!Number.isSafeInteger(Math.round(unitPrice * 100)) || unitPrice <= 0) {
      throw httpError(400, "Paket tutarı geçersiz.");
    }
    return {
      sku: requiredString(source.sku || source.code, "item.sku"),
      name: requiredString(source.name, "item.name"),
      quantity,
      unitPrice,
      priceCents: priceCents ?? Math.round(unitPrice * 100),
      currency: stringValue(source.currency) || "TRY",
      entitlementType:
        stringValue(source.entitlementType || source.entitlement_type) ||
        "one_time",
      entitlementQuantity:
        numberValue(source.entitlementQuantity ?? source.entitlement_quantity) ?? 1,
      unit: stringValue(source.unit) || "adet",
      metadata: objectValue(source.metadata),
    };
  });
}

function checkoutResponse(order) {
  return {
    checkoutUrl: `${appUrl}/?token=${encodeURIComponent(order.token)}`,
    trackingUrl: `${appUrl}/?page=track`,
    token: order.token,
    reference: order.reference,
    orderId: order.id,
    expiresAt: order.expiresAt,
  };
}

function publicOrder(order) {
  return {
    orderId: order.id,
    token: order.token,
    channel: order.channel,
    product: order.product,
    accountId: order.accountId,
    customerName: order.customerName,
    customerEmail: order.customerEmail,
    reference: order.reference,
    expiresAt: order.expiresAt,
    bankAccount: order.bankAccount,
    items: order.items,
    totalAmount: order.totalAmount,
    currency: order.currency,
    status: order.status,
    paymentMethod: order.paymentMethod || "bank_transfer",
    paymentOptions: {
      bankTransfer: true,
      card: kuveytPosConfigured(),
      cardTestMode: kuveytPosConfigured() && kuveytPosMode() === "test",
    },
    cardPayment: publicCardPayment(order.cardPayment),
    receipt: order.receipt
      ? {
        originalName: order.receipt.originalName,
        mimeType: order.receipt.mimeType,
        size: order.receipt.size,
        uploadedAt: order.receipt.uploadedAt,
      }
      : null,
  };
}

function adminOrder(order) {
  return {
    ...publicOrder(order),
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    returnUrl: order.returnUrl,
    webhookUrl: order.webhookUrl,
    metadata: order.metadata,
    rejectionReason: order.rejectionReason || "",
    rejectedBy: order.rejectedBy || "",
    rejectedAt: order.rejectedAt || "",
    approvedBy: order.approvedBy || "",
    approvedAt: order.approvedAt || "",
    approvalNote: order.approvalNote || "",
    lastWebhookError: order.lastWebhookError || "",
    lastWebhookAttemptAt: order.lastWebhookAttemptAt || "",
    lastWebhookAttemptedBy: order.lastWebhookAttemptedBy || "",
    webhookGrantedAt: order.webhookGrantedAt || "",
    receipt: order.receipt
      ? {
        originalName: order.receipt.originalName,
        mimeType: order.receipt.mimeType,
        size: order.receipt.size,
        uploadedAt: order.receipt.uploadedAt,
        receiptUrl: `/api/admin/orders/${encodeURIComponent(order.id)}/receipt`,
      }
      : null,
  };
}

function publicCardPayment(cardPayment) {
  if (!cardPayment) return null;
  return {
    status: cardPayment.status || "",
    merchantOrderId: cardPayment.merchantOrderId || "",
    maskedCard: cardPayment.maskedCard || "",
    cardHolderName: cardPayment.cardHolderName || "",
    bankOrderId: cardPayment.bankOrderId || "",
    provisionNumber: cardPayment.provisionNumber || "",
    rrn: cardPayment.rrn || "",
    stan: cardPayment.stan || "",
    responseCode: cardPayment.responseCode || "",
    responseMessage: cardPayment.responseMessage || "",
    transactionTime: cardPayment.transactionTime || "",
    initiatedAt: cardPayment.initiatedAt || "",
    authorizedAt: cardPayment.authorizedAt || "",
    failedAt: cardPayment.failedAt || "",
  };
}

function kuveytPosConfigured() {
  return !kuveytPosConfigurationError();
}

function kuveytPosUserName() {
  return stringValue(
    process.env.KUVEYT_POS_USER_NAME ||
      process.env.KUVEYT_POS_USERNAME,
  );
}

function kuveytPosMode() {
  const mode = stringValue(process.env.KUVEYT_POS_ENV).toLowerCase();
  if (["production", "prod", "live"].includes(mode)) return "production";
  if (["test", "sandbox"].includes(mode)) return "test";
  return process.env.APP_ENV === "production" ? "production" : "test";
}

function kuveytPosConfigurationError() {
  const customerId = stringValue(process.env.KUVEYT_POS_CUSTOMER_ID);
  const merchantId = stringValue(process.env.KUVEYT_POS_MERCHANT_ID);
  const userName = kuveytPosUserName();
  const password = stringValue(process.env.KUVEYT_POS_PASSWORD);
  if (!customerId || !merchantId || !userName || !password) {
    return "Kuveyt Türk sanal POS bilgileri yapılandırılmamış.";
  }
  if (!/^\d+$/.test(customerId) || !/^\d+$/.test(merchantId)) {
    return "Kuveyt Türk sanal POS müşteri veya mağaza numarası geçersiz.";
  }
  return "";
}

function kuveytPosConfig() {
  const customerId = stringValue(process.env.KUVEYT_POS_CUSTOMER_ID);
  const merchantId = stringValue(process.env.KUVEYT_POS_MERCHANT_ID);
  const userName = kuveytPosUserName();
  const password = stringValue(process.env.KUVEYT_POS_PASSWORD);
  const configurationError = kuveytPosConfigurationError();
  if (configurationError) throw httpError(503, configurationError);

  const mode = kuveytPosMode();
  return {
    mode,
    customerId,
    merchantId,
    userName,
    password,
    hashedPassword: sha1Base64(password, "utf8"),
    currencyCode: stringValue(process.env.KUVEYT_POS_CURRENCY_CODE) || "0949",
    installmentCount: stringValue(process.env.KUVEYT_POS_INSTALLMENT_COUNT) || "0",
    payGateApiVersion: stringValue(process.env.KUVEYT_POS_PAY_GATE_API_VERSION) ||
      "TDV2.0.0",
    provisionGateApiVersion: stringValue(process.env.KUVEYT_POS_PROVISION_GATE_API_VERSION) ||
      "TDV2.0.0",
    payGateUrl: stringValue(process.env.KUVEYT_POS_PAY_GATE_URL) ||
      (mode === "production"
        ? kuveytPosEndpoints.productionPayGate
        : kuveytPosEndpoints.testPayGate),
    provisionGateUrl: stringValue(process.env.KUVEYT_POS_PROVISION_GATE_URL) ||
      (mode === "production"
        ? kuveytPosEndpoints.productionProvisionGate
        : kuveytPosEndpoints.testProvisionGate),
  };
}

async function initiateCardPayment(orderId, fields, request) {
  const config = kuveytPosConfig();
  const card = normalizeCardForm(fields);
  const token = stringValue(fields.token);
  const now = new Date().toISOString();
  let orderForBank;

  const order = await updateOrder(orderId, (item) => {
    if (item.token !== token) throw httpError(403, "Ödeme tokenı eşleşmedi.");
    if (isExpired(item)) throw httpError(410, "Ödeme oturumunun süresi doldu.");
    if (item.status !== "payment_pending") {
      throw httpError(409, "Bu sipariş için kart ödemesi başlatılamaz.");
    }
    const merchantOrderId = nextKuveytMerchantOrderId(item);
    const amount = kuveytAmount(item);
    orderForBank = {
      ...item,
      paymentMethod: "card",
      cardPayment: {
        ...(item.cardPayment || {}),
        status: "authentication_started",
        merchantOrderId,
        amount,
        currencyCode: config.currencyCode,
        installmentCount: config.installmentCount,
        maskedCard: maskCardNumber(card.cardNumber),
        cardHolderName: card.cardHolderName,
        responseCode: "",
        responseMessage: "",
        initiatedAt: now,
        updatedAt: now,
      },
    };
    return {
      ...orderForBank,
      updatedAt: now,
    };
  });

  const okUrl = kuveytCallbackUrl("success", request);
  const failUrl = kuveytCallbackUrl("fail", request);
  const cardForBank = {
    ...card,
    email: normalizeCardCustomerEmail((orderForBank || order).customerEmail),
  };
  const xml = kuveytPaymentXml(
    config,
    orderForBank || order,
    cardForBank,
    okUrl,
    failUrl,
    clientIp(request),
  );

  try {
    const html = await postKuveytXml(config.payGateUrl, xml);
    await updateOrder(order.id, (item) => ({
      ...item,
      cardPayment: {
        ...(item.cardPayment || {}),
        status: "authentication_redirected",
        payGateRespondedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      updatedAt: new Date().toISOString(),
    }));
    return { html };
  } catch (error) {
    await updateCardPaymentFailure(
      order.id,
      "authentication_start_failed",
      null,
      "Kart doğrulama başlatılamadı.",
    );
    throw error.statusCode ? error : httpError(502, "Kuveyt Türk sanal POS servisine ulaşılamadı.");
  }
}

async function handleKuveytPosCallback(request, response, successRoute) {
  const fields = await readKuveytCallbackForm(request, maxKuveytCallbackBytes);
  console.info("Kuveyt authentication callback received", {
    authenticationResponse: kuveytOpaqueValueStats(fields.AuthenticationResponse),
  });
  const xml = decodeAuthenticationResponse(fields.AuthenticationResponse);
  const payload = parseKuveytResponse(xml);
  const merchantOrderId = payload.MerchantOrderId;
  const order = merchantOrderId
    ? await findOrderByMerchantOrderId(merchantOrderId)
    : null;

  if (!order) {
    sendHtml(
      response,
      404,
      renderCardResultPage(
        "Kart doğrulama sonucu eşleştirilemedi",
        "Banka dönüşündeki sipariş bilgisi ödeme oturumuyla eşleşmedi. Lütfen destek ile iletişime geçin.",
      ),
    );
    return;
  }

  const failureMessage = userCardFailureMessage(payload.ResponseMessage,
    "Kart doğrulaması tamamlanamadı. Dilerseniz tekrar deneyebilir veya IBAN ile devam edebilirsiniz.",
  );

  if (!successRoute || payload.ResponseCode !== "00" || !payload.MD) {
    await updateCardPaymentFailure(order.id, "authentication_failed", payload, failureMessage);
    redirect(response, checkoutResultUrl(order, "failed", failureMessage));
    return;
  }

  let config;
  try {
    config = kuveytPosConfig();
  } catch (error) {
    await updateCardPaymentFailure(order.id, "configuration_missing", payload, error.message);
    redirect(response, checkoutResultUrl(order, "failed", error.message));
    return;
  }

  if (!verifyKuveytResponseHash(payload, config, false)) {
    const message = "Banka doğrulama imzası eşleşmedi.";
    await updateCardPaymentFailure(order.id, "authentication_hash_failed", payload, message);
    redirect(response, checkoutResultUrl(order, "failed", message));
    return;
  }

  let provision;
  try {
    provision = await provisionCardPayment(order, payload, config);
  } catch (error) {
    const message = userCardFailureMessage(
      error.message,
      error.statusCode === 502
        ? "Kart doğrulandı, ancak bankadan ödeme onayı alınamadı. Lütfen birkaç dakika sonra tekrar deneyin."
        : "Kart doğrulandı, ancak ödeme tamamlanamadı. Lütfen tekrar deneyin veya destek ekibimizle iletişime geçin.",
    );
    await updateCardPaymentFailure(order.id, "provision_failed", payload, message);
    redirect(response, checkoutResultUrl(order, "failed", message));
    return;
  }

  if (!provision.ok) {
    const message = userCardFailureMessage(
      provision.payload.ResponseMessage,
      "Banka ödeme onayı vermedi. Kartınızdan tahsilat görünmüyorsa tekrar deneyebilir veya IBAN ile devam edebilirsiniz.",
    );
    await updateCardPaymentFailure(order.id, "provision_declined", provision.payload, message);
    redirect(response, checkoutResultUrl(order, "failed", message));
    return;
  }

  const authorized = await markCardPaymentAuthorized(order.id, payload, provision.payload);
  redirect(response, checkoutResultUrl(authorized, "success", "Kart ödemeniz başarıyla alındı."));
}

async function provisionCardPayment(order, authPayload, config) {
  const freshOrder = await findOrder(order.id);
  if (!freshOrder) throw httpError(404, "Sipariş bulunamadı.");
  const storedMerchantOrderId =
    freshOrder.cardPayment?.merchantOrderId || kuveytMerchantOrderId(freshOrder);
  const storedAmount = freshOrder.cardPayment?.amount || kuveytAmount(freshOrder);
  if (
    authPayload.MerchantOrderId !== storedMerchantOrderId ||
    !kuveytAmountsEqual(authPayload.Amount, storedAmount)
  ) {
    console.warn("Kuveyt authentication metadata mismatch", {
      merchantOrderId: authPayload.MerchantOrderId,
      storedMerchantOrderId,
      amount: authPayload.Amount,
      storedAmount,
    });
    throw httpError(400, "Banka doğrulama bilgileri siparişle eşleşmedi.");
  }
  console.info("Kuveyt authentication metadata accepted", {
    merchantOrderId: authPayload.MerchantOrderId,
    amount: authPayload.Amount,
    md: kuveytOpaqueValueStats(authPayload.MD),
  });
  const xml = kuveytProvisionXml(
    config,
    authPayload.MerchantOrderId,
    authPayload.Amount,
    authPayload.MD,
  );
  const text = await postKuveytXml(config.provisionGateUrl, xml);
  const payload = parseKuveytResponse(text);
  const hashOk = verifyKuveytResponseHash(payload, config, Boolean(payload.RRN));
  if (payload.ResponseCode && payload.ResponseCode !== "00") {
    console.warn("Kuveyt provision declined", kuveytResponseLogFields(payload));
  }
  if (payload.ResponseCode === "00" && !hashOk) {
    console.warn("Kuveyt provision approved but response hash did not verify", {
      merchantOrderId: payload.MerchantOrderId,
      orderId: payload.OrderId,
      rrn: payload.RRN,
    });
  }
  return {
    ok: payload.ResponseCode === "00",
    payload: {
      ...payload,
      hashVerified: hashOk,
    },
  };
}

async function markCardPaymentAuthorized(orderId, authPayload, provisionPayload) {
  const now = new Date().toISOString();
  const approved = await updateOrder(orderId, (order) => ({
    ...order,
    status: "approved",
    paymentMethod: "card",
    approvedAt: order.approvedAt || now,
    approvedBy: "kuveytpos",
    approvalNote: "Kuveyt Türk sanal POS otorizasyonu alındı.",
    cardPayment: {
      ...(order.cardPayment || {}),
      status: "authorized",
      authenticationResponseCode: authPayload.ResponseCode || "",
      authenticationResponseMessage: authPayload.ResponseMessage || "",
      mdReceived: Boolean(authPayload.MD),
      bankOrderId: provisionPayload.OrderId || authPayload.OrderId || "",
      provisionNumber: provisionPayload.ProvisionNumber || "",
      rrn: provisionPayload.RRN || "",
      stan: provisionPayload.Stan || "",
      responseCode: provisionPayload.ResponseCode || "",
      responseMessage: provisionPayload.ResponseMessage || "",
      transactionTime: provisionPayload.TransactionTime || "",
      hashVerified: provisionPayload.hashVerified !== false,
      authorizedAt: now,
      updatedAt: now,
    },
    updatedAt: now,
  }));
  return attemptGrantEntitlement(orderId, {
    adminActor: "kuveytpos",
    adminNote: "Kuveyt Türk sanal POS kart ödemesi",
  }).then((granted) => granted || approved);
}

async function attemptGrantEntitlement(orderId, body) {
  try {
    return await grantEntitlement(orderId, body);
  } catch (error) {
    console.error("Card entitlement grant failed", error);
    return updateOrder(orderId, (order) => ({
      ...order,
      lastWebhookError: `card_grant_failed:${String(error.message || error).slice(0, 240)}`,
      lastWebhookAttemptAt: new Date().toISOString(),
      lastWebhookAttemptedBy: body.adminActor || "kuveytpos",
      updatedAt: new Date().toISOString(),
    }));
  }
}

async function updateCardPaymentFailure(orderId, status, payload, message) {
  return updateOrder(orderId, (order) => ({
    ...order,
    cardPayment: {
      ...(order.cardPayment || {}),
      status,
      bankOrderId: payload?.OrderId || order.cardPayment?.bankOrderId || "",
      responseCode: payload?.ResponseCode || "",
      responseMessage: message || payload?.ResponseMessage || "",
      rrn: payload?.RRN || order.cardPayment?.rrn || "",
      stan: payload?.Stan || order.cardPayment?.stan || "",
      failedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    updatedAt: new Date().toISOString(),
  }));
}

function isAuthorizedCardOrder(order) {
  return order.paymentMethod === "card" &&
    order.cardPayment?.status === "authorized";
}

function normalizeCardForm(fields) {
  const cardHolderName = requiredString(fields.cardHolderName, "Kart sahibi")
    .replace(/\s+/g, " ")
    .slice(0, 45);
  if (
    cardHolderName.length < 2 ||
    !/^[\p{L} .'-]+$/u.test(cardHolderName) ||
    cardHolderName.replace(/[^\p{L}]/gu, "").length < 2
  ) {
    throw httpError(400, "Kart üzerindeki ad soyadı kontrol edin.");
  }

  const cardNumber = stringValue(fields.cardNumber).replace(/\D/g, "");
  if (!/^\d{13,19}$/.test(cardNumber) || !passesLuhnCheck(cardNumber)) {
    throw httpError(400, "Kart numarası geçersiz.");
  }

  const month = normalizeExpiryMonth(fields.cardExpireDateMonth);
  const year = normalizeExpiryYear(fields.cardExpireDateYear);
  const cvv = stringValue(fields.cardCVV2).replace(/\D/g, "");
  if (!/^\d{3}$/.test(cvv)) throw httpError(400, "CVV / CVC geçersiz.");
  assertFutureCardExpiry(month, year, cardNumber, cvv);

  const countryCode = "90";
  let subscriber = stringValue(fields.cardPhone).replace(/\D/g, "");
  if (subscriber.startsWith(countryCode)) subscriber = subscriber.slice(countryCode.length);
  subscriber = subscriber.replace(/^0+/, "");
  if (!/^5\d{9}$/.test(subscriber)) {
    throw httpError(400, "Telefon numarası geçersiz.");
  }

  const billAddrCity = requiredString(fields.billAddrCity, "Fatura ili").slice(0, 50);
  if (!/^[\p{L} .'-]{2,50}$/u.test(billAddrCity)) {
    throw httpError(400, "Fatura ili geçersiz.");
  }
  const billAddrState = stringValue(fields.billAddrState).replace(/\D/g, "").padStart(2, "0");
  if (!/^\d{2}$/.test(billAddrState)) throw httpError(400, "Fatura ili kodu geçersiz.");

  const billAddrLine1 = requiredString(fields.billAddrLine1, "Fatura adresi")
    .replace(/\s+/g, " ")
    .slice(0, 150);
  if (billAddrLine1.length < 10 || !/\p{L}/u.test(billAddrLine1)) {
    throw httpError(400, "Fatura adresini kontrol edin.");
  }

  const billAddrPostCode = stringValue(fields.billAddrPostCode).replace(/\D/g, "");
  if (!/^\d{5}$/.test(billAddrPostCode) || !billAddrPostCode.startsWith(billAddrState)) {
    throw httpError(400, "Posta kodu seçilen il ile eşleşmiyor.");
  }

  return {
    cardHolderName,
    cardNumber,
    cardExpireDateMonth: month,
    cardExpireDateYear: year,
    cardCVV2: cvv,
    cardType: normalizeCardType(fields.cardType, cardNumber),
    phoneCountryCode: countryCode.slice(0, 3),
    phoneSubscriber: subscriber,
    billAddrCity,
    billAddrCountry: "792",
    billAddrLine1,
    billAddrPostCode,
    billAddrState,
  };
}

function normalizeExpiryMonth(value) {
  const digits = stringValue(value).replace(/\D/g, "").padStart(2, "0").slice(-2);
  const month = Number(digits);
  if (month < 1 || month > 12) throw httpError(400, "Kart son kullanım ayı geçersiz.");
  return digits;
}

function normalizeExpiryYear(value) {
  const digits = stringValue(value).replace(/\D/g, "");
  const year = digits.length === 4 ? digits.slice(2) : digits;
  if (!/^\d{2}$/.test(year)) throw httpError(400, "Kart son kullanım yılı geçersiz.");
  return year;
}

function assertFutureCardExpiry(month, year, cardNumber, cvv) {
  // Kuveyt Türk keeps this fixed card credential active in its sandbox even
  // after the printed expiry date. Production cards still use the strict check.
  if (isKuveytSandboxCardFixture(cardNumber, month, year, cvv)) return;
  const now = new Date();
  const expiryYear = 2000 + Number(year);
  if (
    expiryYear < now.getFullYear() ||
    (expiryYear === now.getFullYear() && Number(month) < now.getMonth() + 1)
  ) {
    throw httpError(400, "Kartın son kullanma tarihi geçmiş.");
  }
}

function isKuveytSandboxCardFixture(cardNumber, month, year, cvv) {
  return kuveytPosMode() === "test" &&
    cardNumber === kuveytSandboxCardFixture.cardNumber &&
    month === kuveytSandboxCardFixture.month &&
    year === kuveytSandboxCardFixture.year &&
    cvv === kuveytSandboxCardFixture.cvv;
}

function normalizeCardCustomerEmail(value) {
  const email = normalizeEmail(value);
  if (!isValidSupportEmail(email)) {
    throw httpError(400, "Siparişteki e-posta adresi kart ödemesi için geçersiz.");
  }
  return email;
}

function passesLuhnCheck(value) {
  let sum = 0;
  let shouldDouble = false;
  for (let index = value.length - 1; index >= 0; index -= 1) {
    let digit = Number(value[index]);
    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    shouldDouble = !shouldDouble;
  }
  return sum % 10 === 0;
}

function normalizeCardType(value, cardNumber) {
  const raw = stringValue(value).toLowerCase();
  if (raw === "troy") return "TROY";
  if (raw === "mastercard" || raw === "master card") return "MasterCard";
  if (raw === "visa") return "VISA";
  if (/^9792/.test(cardNumber)) return "TROY";
  if (/^4/.test(cardNumber)) return "VISA";
  if (/^(5[1-5]\d{2}|2(?:2(?:2[1-9]|[3-9]\d)|[3-6]\d{2}|7(?:[01]\d|20)))/.test(cardNumber)) {
    return "MasterCard";
  }
  throw httpError(400, "Desteklenmeyen kart türü.");
}

function kuveytMerchantOrderId(order) {
  return String(order.id || order.reference || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
}

function nextKuveytMerchantOrderId(order) {
  const base = kuveytMerchantOrderId(order).slice(0, 46) || randomCode(12).toLowerCase();
  return `${base}-${Date.now().toString(36)}-${randomCode(6).toLowerCase()}`.slice(0, 64);
}

function kuveytAmount(order) {
  const amount = Math.round((numberValue(order.totalAmount) || 0) * 100);
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw httpError(400, "Kart ödeme tutarı geçersiz.");
  }
  return String(amount);
}

function kuveytCallbackUrl(result, request) {
  return `${publicAppUrl(request)}/api/kuveytpos/3d-callback/${result}`;
}

function publicAppUrl(request) {
  if (!isLocalBaseUrl(appUrl)) return appUrl;
  return publicRequestOrigin(request) || appUrl;
}

function publicRequestOrigin(request) {
  if (!request) return "";
  const host = firstHeaderValue(request.headers["x-forwarded-host"]) ||
    firstHeaderValue(request.headers.host);
  if (!host) return "";
  const protocol = requestProtocol(request);
  try {
    const url = new URL(`${protocol}://${host}`);
    if (isLocalHostname(url.hostname)) return "";
    return trimTrailingSlash(url.origin);
  } catch {
    return "";
  }
}

function requestProtocol(request) {
  const forwardedProto = firstHeaderValue(request.headers["x-forwarded-proto"]);
  if (forwardedProto === "http" || forwardedProto === "https") {
    return forwardedProto;
  }
  const forwardedSsl = firstHeaderValue(request.headers["x-forwarded-ssl"]);
  if (forwardedSsl.toLowerCase() === "on") return "https";
  if (process.env.APP_ENV === "production" || kuveytPosMode() === "production") {
    return "https";
  }
  return request.socket?.encrypted ? "https" : "http";
}

function firstHeaderValue(value) {
  if (Array.isArray(value)) return firstHeaderValue(value[0]);
  return String(value || "").split(",")[0].trim();
}

function isLocalBaseUrl(value) {
  try {
    return isLocalHostname(new URL(value).hostname);
  } catch {
    return true;
  }
}

function isLocalHostname(value) {
  const hostname = String(value || "").toLowerCase();
  return hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]" ||
    hostname.endsWith(".localhost");
}

function kuveytPaymentXml(config, order, card, okUrl, failUrl, ip) {
  const amount = order.cardPayment?.amount || kuveytAmount(order);
  const merchantOrderId = order.cardPayment?.merchantOrderId || kuveytMerchantOrderId(order);
  const hashData = kuveytHash(
    config.merchantId +
      merchantOrderId +
      amount +
      okUrl +
      failUrl +
      config.userName +
      config.hashedPassword,
  );
  const clientIpValue = normalizeClientIp(ip);

  return `<KuveytTurkVPosMessage xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
<APIVersion>${escapeXml(config.payGateApiVersion)}</APIVersion>
<OkUrl>${escapeXml(okUrl)}</OkUrl>
<FailUrl>${escapeXml(failUrl)}</FailUrl>
<HashData>${escapeXml(hashData)}</HashData>
<MerchantId>${escapeXml(config.merchantId)}</MerchantId>
<CustomerId>${escapeXml(config.customerId)}</CustomerId>
<DeviceData>
<DeviceChannel>02</DeviceChannel>
<ClientIP>${escapeXml(clientIpValue)}</ClientIP>
</DeviceData>
<CardHolderData>
<BillAddrCity>${escapeXml(card.billAddrCity)}</BillAddrCity>
<BillAddrCountry>${escapeXml(card.billAddrCountry)}</BillAddrCountry>
<BillAddrLine1>${escapeXml(card.billAddrLine1)}</BillAddrLine1>
<BillAddrPostCode>${escapeXml(card.billAddrPostCode)}</BillAddrPostCode>
<BillAddrState>${escapeXml(card.billAddrState)}</BillAddrState>
<Email>${escapeXml(card.email)}</Email>
<MobilePhone>
<Cc>${escapeXml(card.phoneCountryCode)}</Cc>
<Subscriber>${escapeXml(card.phoneSubscriber)}</Subscriber>
</MobilePhone>
</CardHolderData>
<UserName>${escapeXml(config.userName)}</UserName>
<CardNumber>${escapeXml(card.cardNumber)}</CardNumber>
<CardExpireDateYear>${escapeXml(card.cardExpireDateYear)}</CardExpireDateYear>
<CardExpireDateMonth>${escapeXml(card.cardExpireDateMonth)}</CardExpireDateMonth>
<CardCVV2>${escapeXml(card.cardCVV2)}</CardCVV2>
<CardHolderName>${escapeXml(card.cardHolderName)}</CardHolderName>
<CardType>${escapeXml(card.cardType)}</CardType>
<BatchID>0</BatchID>
<TransactionType>Sale</TransactionType>
<InstallmentCount>${escapeXml(config.installmentCount)}</InstallmentCount>
<Amount>${escapeXml(amount)}</Amount>
<DisplayAmount>${escapeXml(amount)}</DisplayAmount>
<CurrencyCode>${escapeXml(config.currencyCode)}</CurrencyCode>
<MerchantOrderId>${escapeXml(merchantOrderId)}</MerchantOrderId>
<TransactionSecurity>3</TransactionSecurity>
</KuveytTurkVPosMessage>`;
}

function kuveytProvisionXml(config, merchantOrderId, amount, md) {
  const hashData = kuveytHash(
    config.merchantId +
      merchantOrderId +
      amount +
      config.userName +
      config.hashedPassword,
  );
  return `<KuveytTurkVPosMessage xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
<APIVersion>${escapeXml(config.provisionGateApiVersion)}</APIVersion>
<HashData>${escapeXml(hashData)}</HashData>
<MerchantId>${escapeXml(config.merchantId)}</MerchantId>
<CustomerId>${escapeXml(config.customerId)}</CustomerId>
<UserName>${escapeXml(config.userName)}</UserName>
<TransactionType>Sale</TransactionType>
<InstallmentCount>${escapeXml(config.installmentCount)}</InstallmentCount>
<CurrencyCode>${escapeXml(config.currencyCode)}</CurrencyCode>
<Amount>${escapeXml(amount)}</Amount>
<MerchantOrderId>${escapeXml(merchantOrderId)}</MerchantOrderId>
<TransactionSecurity>3</TransactionSecurity>
<KuveytTurkVPosAdditionalData>
<AdditionalData>
<Key>MD</Key>
<Data>${escapeXml(md)}</Data>
</AdditionalData>
</KuveytTurkVPosAdditionalData>
</KuveytTurkVPosMessage>`;
}

async function postKuveytXml(url, xml) {
  const timeoutMs = Number(process.env.KUVEYT_POS_TIMEOUT_MS || 60 * 1000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Accept: "text/html, application/xml, text/xml, */*",
        "Content-Type": "application/xml; charset=utf-8",
      },
      body: xml,
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      console.error("Kuveyt POS HTTP error", {
        url,
        statusCode: response.status,
        response: text.slice(0, 500),
      });
      throw httpError(502, "Kuveyt Türk sanal POS servisi isteği reddetti.");
    }
    return text;
  } catch (error) {
    if (error.statusCode) throw error;
    throw httpError(502, "Kuveyt Türk sanal POS servisine ulaşılamadı.");
  } finally {
    clearTimeout(timer);
  }
}

function decodeAuthenticationResponse(value) {
  const raw = stringValue(value);
  if (!raw) throw httpError(400, "Banka dönüş mesajı eksik.");
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function parseKuveytResponse(xml) {
  const text = stringValue(xml);
  if (!text) throw httpError(400, "Banka dönüş XML'i eksik.");
  return {
    OrderId: xmlTagValue(text, "OrderId"),
    MerchantOrderId: xmlTagValue(text, "MerchantOrderId"),
    Amount: xmlTagValue(text, "Amount"),
    ProvisionNumber: xmlTagValue(text, "ProvisionNumber"),
    RRN: xmlTagValue(text, "RRN"),
    Stan: xmlTagValue(text, "Stan"),
    ResponseCode: xmlTagValue(text, "ResponseCode"),
    ResponseMessage: xmlTagValue(text, "ResponseMessage"),
    HashData: xmlTagValue(text, "HashData"),
    MD: xmlTagValue(text, "MD"),
    TransactionTime: xmlTagValue(text, "TransactionTime"),
    ReferenceId: xmlTagValue(text, "ReferenceId"),
    BusinessKey: xmlTagValue(text, "BusinessKey"),
  };
}

function xmlTagValue(xml, tag) {
  const match = String(xml).match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? decodeXmlEntities(match[1].trim()) : "";
}

function kuveytAmountsEqual(left, right) {
  const a = stringValue(left);
  const b = stringValue(right);
  if (!a || !b) return false;
  if (!/^\d+(?:[.,]\d+)?$/.test(a) || !/^\d+(?:[.,]\d+)?$/.test(b)) {
    return a === b;
  }
  return Number(a.replace(",", ".")) === Number(b.replace(",", "."));
}

function verifyKuveytResponseHash(payload, config, includeRrn) {
  if (!payload.HashData) return true;
  const parts = includeRrn
    ? [
      payload.MerchantOrderId,
      payload.RRN,
      payload.ResponseCode,
      payload.OrderId,
      config.hashedPassword,
    ]
    : [
      payload.MerchantOrderId,
      payload.ResponseCode,
      payload.OrderId,
      config.hashedPassword,
    ];
  const expected = kuveytHash(parts.join(""));
  return safeEqualText(payload.HashData, expected);
}

function sha1Base64(value, encoding) {
  return crypto.createHash("sha1")
    .update(Buffer.from(String(value), encoding))
    .digest("base64");
}

function kuveytHash(value) {
  return sha1Base64(value, "latin1");
}

function safeEqualText(left, right) {
  const a = Buffer.from(String(left || "").trim());
  const b = Buffer.from(String(right || "").trim());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function escapeXml(value) {
  return String(value ?? "").replace(/[<>&'"]/g, (char) => ({
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    "'": "&apos;",
    '"': "&quot;",
  })[char]);
}

function decodeXmlEntities(value) {
  return String(value || "").replace(/&(lt|gt|amp|apos|quot);/g, (entity, name) => ({
    lt: "<",
    gt: ">",
    amp: "&",
    apos: "'",
    quot: '"',
  })[name] || entity);
}

function maskCardNumber(cardNumber) {
  const digits = String(cardNumber || "").replace(/\D/g, "");
  if (digits.length < 10) return "";
  return `${digits.slice(0, 6)}******${digits.slice(-4)}`;
}

function normalizeClientIp(value) {
  const ip = stringValue(value).replace(/^::ffff:/, "");
  const parts = ip.split(".");
  if (
    parts.length === 4 &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  ) {
    return parts.map(Number).join(".");
  }
  return "127.0.0.1";
}

async function findOrderByMerchantOrderId(merchantOrderId) {
  const normalized = stringValue(merchantOrderId);
  const store = await readStore();
  return store.orders.find((order) =>
    order.cardPayment?.merchantOrderId === normalized ||
      kuveytMerchantOrderId(order) === normalized ||
      order.id === normalized
  ) || null;
}

function checkoutResultUrl(order, result, message) {
  const url = new URL("/", appUrl);
  if (order?.token) {
    url.searchParams.set("token", order.token);
  } else {
    url.searchParams.set("page", "track");
  }
  url.searchParams.set("cardResult", result);
  if (message) url.searchParams.set("cardMessage", String(message).slice(0, 180));
  return url.toString();
}

function userCardFailureMessage(bankMessage, fallback) {
  const raw = stringValue(bankMessage).trim();
  if (!raw) return fallback;
  const normalized = raw
    .replace(/\+/g, " ")
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("tr-TR");

  if (normalized.includes("md") && (
    normalized.includes("uyumsuz") ||
    normalized.includes("hatal") ||
    normalized.includes("geçersiz") ||
    normalized.includes("gecersiz")
  )) {
    return "3D Secure doğrulaması bankadan geldi, ancak ödeme onayı tamamlanamadı. Kartınızdan tahsilat görünmüyorsa tekrar deneyebilir veya IBAN ile devam edebilirsiniz.";
  }

  if (normalized.includes("hash") || normalized.includes("imza")) {
    return "Banka dönüşü güvenlik kontrolünden geçemedi. Kartınızdan tahsilat görünmüyorsa tekrar deneyebilir veya destek ekibimizle iletişime geçebilirsiniz.";
  }

  if (
    normalized.includes("red") ||
    normalized.includes("decline") ||
    normalized.includes("limit") ||
    normalized.includes("yetersiz")
  ) {
    return "Banka bu kartlı ödemeye onay vermedi. Kart limitinizi veya banka kısıtlarını kontrol edip tekrar deneyebilirsiniz.";
  }

  if (
    normalized.includes("timeout") ||
    normalized.includes("zaman") ||
    normalized.includes("ulaş") ||
    normalized.includes("ulas")
  ) {
    return "Banka yanıtı zamanında alınamadı. Kartınızdan tahsilat görünmüyorsa birkaç dakika sonra tekrar deneyebilirsiniz.";
  }

  return raw.length > 140 ? fallback : raw;
}

function kuveytResponseLogFields(payload) {
  return {
    merchantOrderId: payload.MerchantOrderId || "",
    orderId: payload.OrderId || "",
    responseCode: payload.ResponseCode || "",
    responseMessage: payload.ResponseMessage || "",
    rrn: payload.RRN || "",
    stan: payload.Stan || "",
  };
}

function kuveytOpaqueValueStats(value) {
  const text = String(value || "");
  return {
    length: text.length,
    plus: (text.match(/\+/g) || []).length,
    spaces: (text.match(/ /g) || []).length,
    percentEscapes: (text.match(/%[0-9a-f]{2}/gi) || []).length,
    slashes: (text.match(/\//g) || []).length,
    equals: (text.match(/=/g) || []).length,
  };
}

function renderCardResultPage(title, message) {
  return `<!doctype html>
<html lang="tr">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtmlValue(title)}</title>
    <style>
      body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;background:#f4f6fb;color:#0f172a;margin:0;min-height:100vh;display:grid;place-items:center;padding:24px}
      main{background:#fff;border:1px solid #e2e6ee;border-radius:14px;box-shadow:0 18px 38px -16px rgba(15,23,42,.18);max-width:520px;padding:28px}
      h1{font-size:24px;margin:0 0 10px}p{color:#475569;line-height:1.55}a{color:#0f766e;font-weight:700}
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtmlValue(title)}</h1>
      <p>${escapeHtmlValue(message)}</p>
      <a href="${escapeHtmlValue(appUrl)}">Ödeme ekranına dön</a>
    </main>
  </body>
</html>`;
}

async function saveReceipt(order, file) {
  await ensureDataDirs();
  const extension = extensionFor(file);
  const fileName = `${order.id}-${Date.now()}${extension}`;
  const storagePath = path.join(receiptDir, fileName);
  await fs.writeFile(storagePath, file.buffer);
  return {
    ...order,
    status: "receipt_uploaded",
    paymentMethod: "bank_transfer",
    receipt: {
      originalName: file.filename || `dekont${extension}`,
      mimeType: file.mimeType,
      size: file.buffer.length,
      uploadedAt: new Date().toISOString(),
      storagePath,
    },
    updatedAt: new Date().toISOString(),
  };
}

async function approveOrder(orderId, body) {
  const approved = await updateOrder(orderId, (order) => {
    if (!order.receipt) throw httpError(409, "Dekont yüklenmeden sipariş onaylanamaz.");
    if (order.status === "rejected") throw httpError(409, "Reddedilmiş sipariş onaylanamaz.");
    if (order.status === "entitled") return order;
    if (order.status === "approved") {
      throw httpError(409, "Onaylanmış sipariş için hak tanımını yeniden dene.");
    }
    const approvedAt = new Date().toISOString();
    return {
      ...order,
      status: "approved",
      approvedAt,
      approvedBy: stringValue(body.adminActor) || "admin",
      approvalNote: stringValue(body.adminNote).slice(0, 500),
      updatedAt: approvedAt,
    };
  });
  if (approved.status === "entitled") return approved;
  if (body.skipGrant === true) return approved;
  return grantEntitlement(orderId, body);
}

async function grantEntitlement(orderId, body) {
  const order = await findOrder(orderId);
  if (!order) throw httpError(404, "Sipariş bulunamadı.");
  if (order.status === "entitled") return order;
  if (!order.receipt && !isAuthorizedCardOrder(order)) {
    throw httpError(409, "Ödeme alınmadan hak tanımlanamaz.");
  }
  if (order.status !== "approved") {
    throw httpError(409, "Hak tanımından önce sipariş onaylanmalı.");
  }
  if (!order.webhookUrl) {
    return updateOrder(orderId, (item) => ({
      ...item,
      status: "approved",
      lastWebhookError: "webhook_url_missing",
      lastWebhookAttemptAt: new Date().toISOString(),
      lastWebhookAttemptedBy: stringValue(body.adminActor) || item.approvedBy || "admin",
      updatedAt: new Date().toISOString(),
    }));
  }

  const secret = process.env.MEDASIPAY_WEBHOOK_SECRET ||
    process.env.WEBHOOK_SIGNING_SECRET;
  if (!secret) throw httpError(503, "Webhook imza anahtarı yapılandırılmamış.");

  const approvedAt = order.approvedAt || new Date().toISOString();
  const payload = {
    action: "payment_entitlement_webhook",
    event: "payment.entitlement_granted",
    channel: order.channel,
    product: order.product,
    orderId: order.id,
    reference: order.reference,
    accountId: order.accountId,
    customerEmail: order.customerEmail,
    approvedAt,
    adminNote: stringValue(body.adminNote),
    items: order.items,
    metadata: order.metadata,
  };
  const raw = JSON.stringify(payload);
  const response = await fetch(order.webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-MedAsi-Signature": signPayload(raw, secret),
    },
    body: raw,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    return updateOrder(orderId, (item) => ({
      ...item,
      status: "approved",
      lastWebhookError: `webhook_${response.status}:${text.slice(0, 300)}`,
      lastWebhookAttemptAt: new Date().toISOString(),
      lastWebhookAttemptedBy: stringValue(body.adminActor) || item.approvedBy || "admin",
      updatedAt: new Date().toISOString(),
    }));
  }

  return updateOrder(orderId, (item) => ({
    ...item,
    status: "entitled",
    lastWebhookError: "",
    webhookGrantedAt: new Date().toISOString(),
    lastWebhookAttemptAt: new Date().toISOString(),
    lastWebhookAttemptedBy: stringValue(body.adminActor) || item.approvedBy || "admin",
    updatedAt: new Date().toISOString(),
  }));
}

async function findOrder(orderId) {
  const store = await readStore();
  return store.orders.find((order) => order.id === orderId) || null;
}

async function findOrderByToken(token) {
  const store = await readStore();
  return store.orders.find((order) => order.token === token) || null;
}

async function updateOrder(orderId, updater) {
  return mutateStore(async (store) => {
    const index = store.orders.findIndex((order) => order.id === orderId);
    if (index < 0) throw httpError(404, "Sipariş bulunamadı.");
    const updated = await updater(store.orders[index]);
    store.orders[index] = updated;
    return updated;
  });
}

async function mutateStore(mutation) {
  const operation = storeMutationQueue.then(async () => {
    const store = await readStore();
    const result = await mutation(store);
    await writeStore(store);
    return result;
  });
  storeMutationQueue = operation.catch(() => {});
  return operation;
}

async function readStore() {
  await ensureDataDirs();
  try {
    const content = await fs.readFile(ordersFile, "utf8");
    const parsed = JSON.parse(content);
    return { orders: Array.isArray(parsed.orders) ? parsed.orders : [] };
  } catch (error) {
    if (error.code === "ENOENT") return { orders: [] };
    throw error;
  }
}

async function writeStore(store) {
  await ensureDataDirs();
  const tmp = `${ordersFile}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(store, null, 2));
  await fs.rename(tmp, ordersFile);
}

async function readDeviceStore() {
  await ensureDataDirs();
  try {
    const content = await fs.readFile(devicesFile, "utf8");
    const parsed = JSON.parse(content);
    return { devices: Array.isArray(parsed.devices) ? parsed.devices : [] };
  } catch (error) {
    if (error.code === "ENOENT") return { devices: [] };
    throw error;
  }
}

async function writeDeviceStore(store) {
  await ensureDataDirs();
  const tmp = `${devicesFile}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(store, null, 2));
  await fs.rename(tmp, devicesFile);
}

async function mutateDeviceStore(mutation) {
  const operation = deviceMutationQueue.then(async () => {
    const store = await readDeviceStore();
    const result = await mutation(store);
    await writeDeviceStore(store);
    return result;
  });
  deviceMutationQueue = operation.catch(() => {});
  return operation;
}

async function registerPushDevice(input) {
  const token = requiredDeviceToken(input.deviceToken);
  const now = new Date().toISOString();
  const platform = stringValue(input.platform) || "ios";
  const environment = enumValue(input.environment, ["sandbox", "production"], apnsEnvironment());
  const appVersion = stringValue(input.appVersion);
  const bundleId = stringValue(input.bundleId) ||
    process.env.APNS_BUNDLE_ID ||
    "com.medasi.adminpanel";

  return mutateDeviceStore((store) => {
    const existing = store.devices.find((device) => device.deviceToken === token);
    const device = {
      deviceToken: token,
      platform,
      environment,
      bundleId,
      appVersion,
      enabled: true,
      registeredAt: existing?.registeredAt || now,
      lastSeenAt: now,
    };
    if (existing) {
      Object.assign(existing, device);
      return existing;
    }
    store.devices.push(device);
    return device;
  });
}

async function deletePushDevice(token) {
  return mutateDeviceStore((store) => {
    store.devices = store.devices.filter((device) => device.deviceToken !== token);
    return true;
  });
}

async function notifyReceiptUploaded(order) {
  const config = await apnsConfig();
  if (!config) return;

  const store = await readDeviceStore();
  const devices = store.devices.filter((device) =>
    device.enabled !== false &&
    device.platform === "ios" &&
    (!device.environment || device.environment === config.environment)
  );
  if (!devices.length) return;

  const payload = receiptPushPayload(order);
  const results = await Promise.allSettled(
    devices.map((device) => sendApnsNotification(config, device, payload)),
  );
  for (let index = 0; index < results.length; index++) {
    const result = results[index];
    if (
      result.status === "fulfilled" &&
      ["BadDeviceToken", "Unregistered", "DeviceTokenNotForTopic"].includes(result.value.reason)
    ) {
      await deletePushDevice(devices[index].deviceToken);
    } else if (result.status === "rejected") {
      console.error("APNs send failed", result.reason);
    }
  }
}

function receiptPushPayload(order) {
  const product = String(order.product || "MedAsi").toUpperCase();
  const amount = formatPushMoney(order.totalAmount, order.currency);
  const body = [
    order.customerName || order.customerEmail || "Yeni müşteri",
    order.reference,
    amount,
  ].filter(Boolean).join(" | ");
  const sound = process.env.APNS_CRITICAL_ALERTS === "true"
    ? { critical: 1, name: "default", volume: 1.0 }
    : "default";

  return {
    aps: {
      alert: {
        title: `Yeni ${product} dekontu`,
        body,
      },
      sound,
      "interruption-level": process.env.APNS_CRITICAL_ALERTS === "true"
        ? "critical"
        : "time-sensitive",
    },
    orderId: order.id,
    reference: order.reference,
    product: order.product,
    status: order.status,
    type: "receipt_uploaded",
  };
}

async function apnsConfig() {
  const teamId = stringValue(process.env.APNS_TEAM_ID);
  const keyId = stringValue(process.env.APNS_KEY_ID);
  const bundleId = stringValue(process.env.APNS_BUNDLE_ID) || "com.medasi.adminpanel";
  const privateKey = await apnsPrivateKey();
  if (!teamId || !keyId || !privateKey) return null;
  return {
    teamId,
    keyId,
    bundleId,
    privateKey,
    environment: apnsEnvironment(),
    host: apnsEnvironment() === "production"
      ? "https://api.push.apple.com"
      : "https://api.sandbox.push.apple.com",
  };
}

async function apnsPrivateKey() {
  const inline = stringValue(process.env.APNS_AUTH_KEY);
  if (inline) return normalizePrivateKey(inline);
  const keyPath = stringValue(process.env.APNS_AUTH_KEY_PATH);
  if (!keyPath) return "";
  return normalizePrivateKey(await fs.readFile(keyPath, "utf8"));
}

function apnsEnvironment() {
  return process.env.APNS_ENVIRONMENT === "production" ||
    process.env.APP_ENV === "production"
    ? "production"
    : "sandbox";
}

function normalizePrivateKey(value) {
  return String(value || "").replace(/\\n/g, "\n").trim();
}

async function sendApnsNotification(config, device, payload) {
  const token = requiredDeviceToken(device.deviceToken);
  const jwt = apnsJwt(config);
  const response = await apnsRequest(config, token, jwt, payload);
  if (response.status < 200 || response.status >= 300) {
    console.error("APNs rejected notification", response);
  }
  return response;
}

function apnsJwt(config) {
  const now = Math.floor(Date.now() / 1000);
  if (cachedApnsJwt && cachedApnsJwt.keyId === config.keyId &&
    cachedApnsJwt.teamId === config.teamId && now - cachedApnsJwt.iat < 45 * 60) {
    return cachedApnsJwt.token;
  }

  const header = base64UrlJson({ alg: "ES256", kid: config.keyId });
  const claims = base64UrlJson({ iss: config.teamId, iat: now });
  const signingInput = `${header}.${claims}`;
  const derSignature = crypto.sign(
    "sha256",
    Buffer.from(signingInput),
    config.privateKey,
  );
  const signature = derSignatureToJose(derSignature, 64).toString("base64url");
  const token = `${signingInput}.${signature}`;
  cachedApnsJwt = { keyId: config.keyId, teamId: config.teamId, iat: now, token };
  return token;
}

function apnsRequest(config, token, jwt, payload) {
  return new Promise((resolve, reject) => {
    const client = http2.connect(config.host);
    const body = JSON.stringify(payload);
    let responseBody = "";
    let status = 0;

    client.on("error", reject);

    const request = client.request({
      ":method": "POST",
      ":path": `/3/device/${token}`,
      authorization: `bearer ${jwt}`,
      "content-type": "application/json",
      "apns-topic": config.bundleId,
      "apns-push-type": "alert",
      "apns-priority": "10",
    });

    request.setEncoding("utf8");
    request.on("response", (headers) => {
      status = Number(headers[":status"] || 0);
    });
    request.on("data", (chunk) => {
      responseBody += chunk;
    });
    request.on("end", () => {
      client.close();
      let reason = "";
      try {
        reason = JSON.parse(responseBody).reason || "";
      } catch {
        reason = responseBody;
      }
      resolve({ status, reason });
    });
    request.on("error", (error) => {
      client.close();
      reject(error);
    });
    request.end(body);
  });
}

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function derSignatureToJose(signature, partLength) {
  const bytes = Buffer.from(signature);
  if (bytes[0] !== 0x30) throw new Error("APNs imza biçimi geçersiz.");
  let offset = 2;
  if (bytes[1] & 0x80) {
    offset = 2 + (bytes[1] & 0x7f);
  }
  if (bytes[offset] !== 0x02) throw new Error("APNs imza R alanı geçersiz.");
  const rLength = bytes[offset + 1];
  const r = bytes.subarray(offset + 2, offset + 2 + rLength);
  offset += 2 + rLength;
  if (bytes[offset] !== 0x02) throw new Error("APNs imza S alanı geçersiz.");
  const sLength = bytes[offset + 1];
  const s = bytes.subarray(offset + 2, offset + 2 + sLength);
  return Buffer.concat([leftPadSignaturePart(r, partLength / 2), leftPadSignaturePart(s, partLength / 2)]);
}

function leftPadSignaturePart(value, length) {
  let bytes = value;
  while (bytes.length > length && bytes[0] === 0) {
    bytes = bytes.subarray(1);
  }
  if (bytes.length > length) throw new Error("APNs imza alanı çok uzun.");
  if (bytes.length === length) return bytes;
  return Buffer.concat([Buffer.alloc(length - bytes.length), bytes]);
}

async function ensureDataDirs() {
  await fs.mkdir(receiptDir, { recursive: true });
}

async function readJson(request) {
  const body = await readBody(request, maxJsonBytes);
  if (!body.length) return {};
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw httpError(400, "JSON gövdesi geçersiz.");
  }
}

async function readFormUrlEncoded(request, limit) {
  const body = await readBody(request, limit || maxJsonBytes);
  if (!body.length) return {};
  const params = new URLSearchParams(body.toString("utf8"));
  const fields = {};
  for (const [key, value] of params.entries()) fields[key] = value;
  return fields;
}

async function readKuveytCallbackForm(request, limit) {
  const body = await readBody(request, limit || maxJsonBytes);
  if (!body.length) return {};
  return parseFormUrlEncodedPreservingPlus(body.toString("utf8"), [
    "AuthenticationResponse",
  ]);
}

function parseFormUrlEncodedPreservingPlus(raw, preservePlusKeys) {
  const preserve = new Set(preservePlusKeys || []);
  const fields = {};
  String(raw || "").split("&").forEach((entry) => {
    if (!entry) return;
    const separator = entry.indexOf("=");
    const rawKey = separator >= 0 ? entry.slice(0, separator) : entry;
    const rawValue = separator >= 0 ? entry.slice(separator + 1) : "";
    const key = decodeFormComponent(rawKey, false);
    fields[key] = decodeFormComponent(rawValue, preserve.has(key));
  });
  return fields;
}

function decodeFormComponent(value, preservePlus) {
  const normalized = preservePlus
    ? String(value || "")
    : String(value || "").replace(/\+/g, " ");
  try {
    return decodeURIComponent(normalized);
  } catch {
    return normalized;
  }
}

async function readMultipart(request) {
  const contentType = request.headers["content-type"] || "";
  const match = String(contentType).match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!match) throw httpError(415, "Multipart boundary eksik.");
  const boundary = Buffer.from(`--${match[1] || match[2]}`);
  const body = await readBody(request, maxReceiptBytes + 512 * 1024);
  const fields = {};
  let file = null;

  for (const rawPart of splitBuffer(body, boundary)) {
    let part = trimCrlf(rawPart);
    if (!part.length || part.equals(Buffer.from("--"))) continue;
    if (part.subarray(0, 2).toString() === "--") continue;
    const headerEnd = part.indexOf(Buffer.from("\r\n\r\n"));
    if (headerEnd < 0) continue;
    const headerText = part.subarray(0, headerEnd).toString("utf8");
    let content = trimCrlf(part.subarray(headerEnd + 4));
    const disposition = headerText
      .split(/\r\n/)
      .find((line) => line.toLowerCase().startsWith("content-disposition:")) ||
      "";
    const name = disposition.match(/name="([^"]+)"/)?.[1] || "";
    const filename = disposition.match(/filename="([^"]*)"/)?.[1] || "";
    if (!name) continue;
    if (filename) {
      if (content.length > maxReceiptBytes) {
        throw httpError(413, "Dekont dosyası en fazla 3 MB olmalı.");
      }
      const detectedMimeType = detectReceiptMime(content);
      if (!detectedMimeType) {
        throw httpError(415, "Dekont PDF, PNG veya JPEG olmalı.");
      }
      file = { fieldName: name, filename, mimeType: detectedMimeType, buffer: content };
    } else {
      fields[name] = content.toString("utf8");
    }
  }
  return { fields, file };
}

async function readBody(request, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw httpError(413, "İstek gövdesi çok büyük.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function splitBuffer(buffer, separator) {
  const parts = [];
  let start = 0;
  let index = buffer.indexOf(separator, start);
  while (index >= 0) {
    parts.push(buffer.subarray(start, index));
    start = index + separator.length;
    index = buffer.indexOf(separator, start);
  }
  parts.push(buffer.subarray(start));
  return parts;
}

function trimCrlf(buffer) {
  let start = 0;
  let end = buffer.length;
  while (start < end && (buffer[start] === 13 || buffer[start] === 10)) start++;
  while (end > start && (buffer[end - 1] === 13 || buffer[end - 1] === 10)) {
    end--;
  }
  return buffer.subarray(start, end);
}

async function serveStatic(pathname, response, headOnly) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const normalized = path.normalize(safePath).replace(/^(\.\.[/\\])+/, "");
  let filePath = path.join(publicDir, normalized);
  if (!filePath.startsWith(publicDir)) {
    sendJson(response, 403, { error: "Forbidden" });
    return;
  }
  try {
    const stat = await fs.stat(filePath);
    if (stat.isDirectory()) filePath = path.join(filePath, "index.html");
  } catch {
    filePath = path.join(publicDir, "index.html");
  }
  let file;
  try {
    file = await fs.readFile(filePath);
  } catch {
    sendJson(response, 404, { error: "Not found" });
    return;
  }
  response.writeHead(200, {
    "Cache-Control": cacheControl(filePath),
    "Content-Type": contentType(filePath),
  });
  response.end(headOnly ? undefined : file);
}

function requireServiceKey(request) {
  const configured = process.env.MEDASIPAY_API_KEY ||
    process.env.PAYMENT_SERVICE_API_KEY ||
    process.env.SESSION_SIGNING_SECRET;
  if (!configured) throw httpError(503, "Ödeme servisi API anahtarı eksik.");
  if (readApiKey(request) !== configured) throw httpError(401, "Unauthorized");
}

function requireAdminKey(request) {
  const configured = process.env.MEDASIPAY_ADMIN_KEY ||
    process.env.ADMIN_API_KEY;
  if (!configured) throw httpError(503, "Admin API anahtarı eksik.");
  if (readApiKey(request) !== configured) throw httpError(401, "Unauthorized");
}

function readApiKey(request) {
  return stringValue(
    request.headers["x-medasi-api-key"] ||
      request.headers["x-medasi-admin-key"] ||
      String(request.headers.authorization || "").replace(/^Bearer\s+/i, ""),
  );
}

function sendJson(response, status, body, extraHeaders) {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    ...(extraHeaders || {}),
  });
  response.end(JSON.stringify(body));
}

function sendText(response, status, body, type) {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": type,
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

function sendHtml(response, status, body) {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "text/html; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

function redirect(response, location) {
  response.writeHead(303, {
    "Cache-Control": "no-store",
    Location: location,
  });
  response.end();
}

function sendError(response, error) {
  const status = error.statusCode || 500;
  const message = status === 500
    ? "Beklenmeyen ödeme servisi hatası."
    : error.message;
  if (status === 500) console.error(error);
  sendJson(response, status, { error: message });
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function isExpired(order) {
  return Date.now() > new Date(order.expiresAt).getTime();
}

function isTerminalStatus(status) {
  return ["approved", "entitled", "rejected"].includes(status);
}

function signPayload(raw, secret) {
  const hex = crypto.createHmac("sha256", secret).update(raw).digest("hex");
  return `sha256=${hex}`;
}

function totalAmount(items) {
  return items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
}

function productPrefix(product) {
  if (product === "praticase") return "PRC";
  if (product === "sourcebase") return "SRC";
  return "QLN";
}

function uniqueValue(items, key, factory) {
  let value = factory();
  while (items.some((item) => item[key] === value)) value = factory();
  return value;
}

function randomCode(size) {
  return crypto.randomBytes(Math.ceil(size * 0.75))
    .toString("base64url")
    .replace(/[^a-z0-9]/gi, "")
    .slice(0, size)
    .toUpperCase();
}

function extensionFor(file) {
  if (file.mimeType === "application/pdf") return ".pdf";
  if (file.mimeType === "image/png") return ".png";
  return ".jpg";
}

function safeHeaderFilename(value) {
  return stringValue(value).replace(/["\r\n]/g, "_") || "dekont";
}

function requiredString(value, name) {
  const text = stringValue(value);
  if (!text) throw httpError(400, `${name} zorunlu.`);
  return text;
}

function requiredDeviceToken(value) {
  const token = stringValue(value).replace(/[^a-f0-9]/gi, "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(token)) {
    throw httpError(400, "APNs cihaz tokenı geçersiz.");
  }
  return token;
}

function optionalUrl(value) {
  const text = stringValue(value);
  if (!text) return "";
  try {
    const url = new URL(text);
    if (url.protocol !== "https:" && url.hostname !== "localhost") {
      throw httpError(400, "URL HTTPS olmalı.");
    }
    return url.toString();
  } catch (error) {
    if (error.statusCode) throw error;
    throw httpError(400, "URL geçersiz.");
  }
}

function paymentWebhookUrl(value, product) {
  const webhookUrl = optionalUrl(value);
  if (process.env.APP_ENV !== "production") return webhookUrl;
  const envName = product === "praticase"
    ? "PRATICASE_PAYMENT_WEBHOOK_URL"
    : product === "sourcebase"
      ? "SOURCEBASE_PAYMENT_WEBHOOK_URL"
      : "QLINIK_PAYMENT_WEBHOOK_URL";
  const expectedUrl = optionalUrl(
    process.env[envName] || defaultPaymentWebhookUrls[product],
  );
  if (!webhookUrl || webhookUrl !== expectedUrl) {
    throw httpError(400, "Ödeme webhook adresi geçersiz.");
  }
  return webhookUrl;
}

function enumValue(value, choices, fallback) {
  const text = stringValue(value).toLowerCase();
  return choices.includes(text) ? text : fallback;
}

function numberValue(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeEmail(value) {
  return stringValue(value).toLowerCase();
}

function normalizeReference(value) {
  return stringValue(value).toUpperCase().replace(/\s+/g, "");
}

function formatPushMoney(amount, currency) {
  const numeric = numberValue(amount);
  if (numeric === null) return "";
  return `${numeric.toLocaleString("tr-TR", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })} ${stringValue(currency) || "TRY"}`;
}

function trimTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function detectReceiptMime(buffer) {
  if (buffer.subarray(0, 5).toString("ascii") === "%PDF-") {
    return "application/pdf";
  }
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
  )) {
    return "image/png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xFF && buffer[1] === 0xD8 &&
    buffer[2] === 0xFF) {
    return "image/jpeg";
  }
  return "";
}

function cacheControl(filePath) {
  return /\.(svg|png|jpg|jpeg|gif|webp|ico)$/i.test(filePath)
    ? "public, max-age=604800"
    : "no-cache";
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
  }[ext] || "application/octet-stream";
}
