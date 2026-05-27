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
    const filePath = order.receipt.storagePath;
    if (!filePath.startsWith(receiptDir)) {
      sendJson(response, 403, { error: "Dekont yolu geçersiz." });
      return;
    }
    const file = await fs.readFile(filePath);
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": order.receipt.mimeType,
      "Content-Disposition":
        `inline; filename="${safeHeaderFilename(order.receipt.originalName)}"`,
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
    const updated = await updateOrder(rejectMatch[1], (order) => ({
      ...order,
      status: "rejected",
      rejectionReason: reason,
      updatedAt: new Date().toISOString(),
    }));
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

  const store = await readStore();
  const token = uniqueValue(store.orders, "token", () =>
    `pay_${productPrefix(product).toLowerCase()}_${randomCode(16).toLowerCase()}`
  );
  const reference = uniqueValue(store.orders, "reference", () =>
    `${productPrefix(product)}-${randomCode(6)}`
  );
  const paymentBankAccount = bankAccount();
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
    returnUrl: optionalUrl(input.returnUrl),
    webhookUrl: optionalUrl(input.webhookUrl),
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
  await writeStore(store);
  return order;
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
    const priceCents = numberValue(source.priceCents);
    const unitPrice = priceCents !== null
      ? priceCents / 100
      : numberValue(source.unitPrice ?? source.price ?? source.amount) || 0;
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
    lastWebhookError: order.lastWebhookError || "",
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
  const approved = await updateOrder(orderId, (order) => ({
    ...order,
    status: "approved",
    updatedAt: new Date().toISOString(),
  }));
  if (body.skipGrant === true) return approved;
  return grantEntitlement(orderId, body);
}

async function grantEntitlement(orderId, body) {
  const order = await findOrder(orderId);
  if (!order) throw httpError(404, "Sipariş bulunamadı.");
  if (!order.webhookUrl) {
    return updateOrder(orderId, (item) => ({
      ...item,
      status: "approved",
      lastWebhookError: "webhook_url_missing",
      updatedAt: new Date().toISOString(),
    }));
  }

  const secret = process.env.MEDASIPAY_WEBHOOK_SECRET ||
    process.env.WEBHOOK_SIGNING_SECRET;
  if (!secret) throw httpError(503, "Webhook imza anahtarı yapılandırılmamış.");

  const payload = {
    action: "payment_entitlement_webhook",
    event: "payment.entitlement_granted",
    channel: order.channel,
    product: order.product,
    orderId: order.id,
    reference: order.reference,
    accountId: order.accountId,
    customerEmail: order.customerEmail,
    approvedAt: new Date().toISOString(),
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
      updatedAt: new Date().toISOString(),
    }));
  }

  return updateOrder(orderId, (item) => ({
    ...item,
    status: "entitled",
    lastWebhookError: "",
    webhookGrantedAt: new Date().toISOString(),
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
  const store = await readStore();
  const index = store.orders.findIndex((order) => order.id === orderId);
  if (index < 0) throw httpError(404, "Sipariş bulunamadı.");
  const updated = await updater(store.orders[index]);
  store.orders[index] = updated;
  await writeStore(store);
  return updated;
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
    const mimeType = headerText.match(/content-type:\s*([^\r\n]+)/i)?.[1]
      ?.trim() || "application/octet-stream";
    if (!name) continue;
    if (filename) {
      if (content.length > maxReceiptBytes) {
        throw httpError(413, "Dekont dosyası çok büyük.");
      }
      if (!isAllowedReceiptMime(mimeType)) {
        throw httpError(415, "Dekont PDF, PNG veya JPG olmalı.");
      }
      file = { fieldName: name, filename, mimeType, buffer: content };
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

function sendJson(response, status, body) {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
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

function isAllowedReceiptMime(value) {
  return [
    "application/pdf",
    "image/png",
    "image/jpeg",
    "image/jpg",
  ].includes(String(value).toLowerCase());
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
