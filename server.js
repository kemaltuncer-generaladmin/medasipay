const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");

const port = Number(process.env.PORT || 3000);
const appUrl = trimTrailingSlash(
  process.env.APP_URL || `http://localhost:${port}`,
);
const dataDir = process.env.DATA_DIR || path.join(__dirname, "data");
const receiptDir = path.join(dataDir, "receipts");
const ordersFile = path.join(dataDir, "orders.json");
const publicDir = __dirname;
const maxJsonBytes = 128 * 1024;
const maxReceiptBytes = Number(process.env.MAX_RECEIPT_BYTES || 10 * 1024 * 1024);
const defaultBankAccount = {
  holder: "MedAsi Teknoloji A.Ş.",
  iban: "TR11 0006 2000 0000 0123 4567 89",
};
const defaultPaymentWebhookUrls = {
  qlinik: "https://qlinik.medasi.com.tr/functions/v1/qlinik",
  praticase: "https://qlinik.medasi.com.tr/functions/v1/praticase-storekit-verify",
};
let storeMutationQueue = Promise.resolve();

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
  const product = enumValue(input.product, ["qlinik", "praticase"], "qlinik");
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

async function saveReceipt(order, file) {
  await ensureDataDirs();
  const extension = extensionFor(file);
  const fileName = `${order.id}-${Date.now()}${extension}`;
  const storagePath = path.join(receiptDir, fileName);
  await fs.writeFile(storagePath, file.buffer);
  return {
    ...order,
    status: "receipt_uploaded",
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
  if (!order.receipt) throw httpError(409, "Dekont yüklenmeden hak tanımlanamaz.");
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
        throw httpError(413, "Dekont dosyası çok büyük.");
      }
      const detectedMimeType = detectReceiptMime(content);
      if (!detectedMimeType) {
        throw httpError(415, "Dekont PDF, PNG veya JPG olmalı.");
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
  return product === "praticase" ? "PRC" : "QLN";
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
