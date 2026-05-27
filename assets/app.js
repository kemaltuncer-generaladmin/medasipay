(function () {
  "use strict";

  var LOCAL_HOSTNAMES = ["", "localhost", "127.0.0.1", "::1"];
  var IS_LOCAL_PREVIEW = LOCAL_HOSTNAMES.indexOf(window.location.hostname) >= 0;
  var configuredApiBase = window.MEDASI_PAYMENT_API_BASE;
  var API_BASE = configuredApiBase === undefined
    ? (IS_LOCAL_PREVIEW ? "" : window.location.origin)
    : String(configuredApiBase).replace(/\/+$/, "");
  var ALLOW_URL_SESSION = window.MEDASI_ALLOW_URL_SESSION === true || IS_LOCAL_PREVIEW;
  var DEFAULT_BANK_ACCOUNT = {
    holder: "MedAsi Teknoloji A.Ş.",
    iban: "TR11 0006 2000 0000 0123 4567 89"
  };

  var money = new Intl.NumberFormat("tr-TR", {
    style: "currency",
    currency: "TRY",
    maximumFractionDigits: 0
  });

  var channelLabels = {
    web: "Web"
  };

  var statusMeta = {
    payment_pending: { label: "Ödeme bekleniyor", tone: "warning" },
    receipt_uploaded: { label: "Dekont yüklendi", tone: "success" },
    review: { label: "Kontrol ediliyor", tone: "warning" },
    approved: { label: "Onaylandı", tone: "success" },
    entitled: { label: "Hak tanımlandı", tone: "success" },
    rejected: { label: "Reddedildi", tone: "danger" }
  };

  var demoSessions = {
    pay_qlinik_demo: {
      channel: "web",
      product: "Qlinik",
      reference: "QLN-8F3K2",
      accountName: "Qlinik web kullanıcısı",
      customerEmail: "demo@qlinik.com",
      expiresAt: "2026-05-27T15:30:00+03:00",
      items: [
        { name: "Doktor paketi", quantity: 1, unit: "1 kullanıcı", unitPrice: 1490 },
        { name: "SMS kontörü", quantity: 1, unit: "1000 SMS", unitPrice: 690 }
      ]
    },
    pay_praticase_demo: {
      channel: "web",
      product: "Praticase",
      reference: "PRC-92A7X",
      accountName: "Praticase web kullanıcısı",
      customerEmail: "demo@praticase.com",
      expiresAt: "2026-05-27T16:00:00+03:00",
      items: [
        { name: "Ofis lisansı", quantity: 1, unit: "1 ofis", unitPrice: 1890 },
        { name: "Ek kullanıcı", quantity: 2, unit: "1 kullanıcı", unitPrice: 490 }
      ]
    }
  };

  var demoTrackOrders = [
    Object.assign({}, demoSessions.pay_qlinik_demo, { status: "review" }),
    Object.assign({}, demoSessions.pay_praticase_demo, { status: "approved" })
  ];

  var currentSession = null;

  function $(selector) {
    return document.querySelector(selector);
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (char) {
      return {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;"
      }[char];
    });
  }

  function getHashParams() {
    var hash = window.location.hash.replace(/^#/, "");
    if (!hash) {
      return new URLSearchParams();
    }
    if (hash.indexOf("?") >= 0) {
      hash = hash.slice(hash.indexOf("?") + 1);
    }
    return new URLSearchParams(hash);
  }

  function readParam(name) {
    var url = new URL(window.location.href);
    return url.searchParams.get(name) || getHashParams().get(name) || "";
  }

  function readToken() {
    return readParam("token");
  }

  function parseNumber(value) {
    if (value === null || value === undefined || value === "") {
      return 0;
    }
    if (typeof value === "number") {
      return Number.isFinite(value) ? value : 0;
    }
    var normalized = String(value).trim();
    if (normalized.indexOf(",") >= 0) {
      normalized = normalized.replace(/\./g, "").replace(",", ".");
    } else if (/^\d{1,3}(\.\d{3})+$/.test(normalized)) {
      normalized = normalized.replace(/\./g, "");
    }
    var number = Number(normalized);
    return Number.isFinite(number) ? number : 0;
  }

  function normalizeChannel(value) {
    var channel = String(value || "").toLowerCase();
    return channelLabels[channel] ? channel : "web";
  }

  function formatChannel(value) {
    return channelLabels[value] || value || "-";
  }

  function formatMoney(amount) {
    return amount > 0 ? money.format(amount) : "-";
  }

  function formatDate(value) {
    if (!value) {
      return "-";
    }
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return value;
    }
    return new Intl.DateTimeFormat("tr-TR", {
      dateStyle: "medium",
      timeStyle: "short"
    }).format(date);
  }

  function normalizeReference(value) {
    return String(value || "").trim().toUpperCase().replace(/\s+/g, "");
  }

  function normalizeEmail(value) {
    return String(value || "").trim().toLowerCase();
  }

  function normalizeItems(items) {
    if (!Array.isArray(items)) {
      return [];
    }

    return items.map(function (item) {
      var quantity = parseNumber(item.quantity || item.qty || 1) || 1;
      var unitPrice = parseNumber(item.unitPrice || item.price || item.amount);
      var entitlement = item.entitlementQuantity && item.entitlementType
        ? item.entitlementQuantity + " " + item.entitlementType
        : "";

      return {
        name: item.name || item.sku || "Ödeme kalemi",
        qty: quantity,
        unit: item.unit || entitlement || "adet",
        price: unitPrice
      };
    });
  }

  function total(items) {
    return items.reduce(function (sum, item) {
      return sum + item.qty * item.price;
    }, 0);
  }

  function createReferenceFromToken(token) {
    return String(token || "")
      .replace(/^pay[_-]?/i, "")
      .replace(/[^a-z0-9]+/gi, "-")
      .replace(/^-|-$/g, "")
      .toUpperCase() || "-";
  }

  function normalizeSession(raw, token) {
    var source = raw || {};
    var bank = source.bankAccount || {};
    var items = normalizeItems(source.items);
    var amount = parseNumber(source.totalAmount || source.amount || source.total);

    if (!items.length && amount > 0) {
      items = [{
        name: source.paymentTitle || source.title || "Banka transferi",
        qty: 1,
        unit: "ödeme",
        price: amount
      }];
    }

    return {
      token: token || source.token || "",
      orderId: source.orderId || source.id || "",
      channel: normalizeChannel(source.channel),
      product: source.productName || source.product || "MedAsi",
      accountName: source.customerName || source.accountName || source.accountId || "Ödeme hesabı",
      customerEmail: source.customerEmail || source.email || "",
      reference: source.reference || source.paymentReference || createReferenceFromToken(token),
      expiresAt: source.expiresAt || "",
      status: source.status || "payment_pending",
      items: items,
      totalAmount: amount > 0 ? amount : total(items),
      bankAccount: {
        holder: bank.holder || bank.accountHolder || source.accountHolder || DEFAULT_BANK_ACCOUNT.holder,
        iban: bank.iban || source.iban || DEFAULT_BANK_ACCOUNT.iban
      }
    };
  }

  function decodePayload(value) {
    if (!value) {
      return null;
    }

    try {
      return JSON.parse(decodeURIComponent(value));
    } catch (jsonError) {
      try {
        return JSON.parse(atob(value));
      } catch (base64Error) {
        return null;
      }
    }
  }

  function readSessionFromUrl(token) {
    if (!ALLOW_URL_SESSION) {
      return null;
    }

    var payload = decodePayload(readParam("payload"));
    if (payload) {
      return normalizeSession(payload, token);
    }

    var hasDetails = [
      "reference",
      "amount",
      "product",
      "customerName",
      "accountName",
      "iban"
    ].some(function (key) {
      return Boolean(readParam(key));
    });

    if (!hasDetails) {
      return null;
    }

    return normalizeSession({
      channel: readParam("channel"),
      product: readParam("product"),
      customerName: readParam("customerName"),
      accountName: readParam("accountName"),
      customerEmail: readParam("email"),
      reference: readParam("reference"),
      expiresAt: readParam("expiresAt"),
      amount: readParam("amount"),
      bankAccount: {
        holder: readParam("accountHolder"),
        iban: readParam("iban")
      },
      items: readParam("amount") ? [{
        name: readParam("itemName") || "Ödeme",
        quantity: 1,
        unit: "ödeme",
        unitPrice: readParam("amount")
      }] : []
    }, token);
  }

  function inferDemoSession(token) {
    var normalized = String(token || "").toLowerCase();
    if (demoSessions[normalized]) {
      return normalizeSession(demoSessions[normalized], token);
    }
    if (normalized.indexOf("qlinik") >= 0 || normalized.indexOf("qln") >= 0) {
      return normalizeSession(demoSessions.pay_qlinik_demo, token);
    }
    if (normalized.indexOf("praticase") >= 0 || normalized.indexOf("prc") >= 0) {
      return normalizeSession(demoSessions.pay_praticase_demo, token);
    }
    return null;
  }

  function fetchSession(token) {
    if (!API_BASE) {
      return Promise.resolve(null);
    }

    return fetch(API_BASE + "/api/checkout-sessions/" + encodeURIComponent(token), {
      headers: { Accept: "application/json" },
      credentials: "same-origin"
    }).then(function (response) {
      if (!response.ok) {
        throw new Error("Session fetch failed");
      }
      return response.json();
    }).then(function (payload) {
      return normalizeSession(payload, token);
    });
  }

  function resolveSession(token) {
    var urlSession = readSessionFromUrl(token);
    if (urlSession) {
      return Promise.resolve(urlSession);
    }

    if (API_BASE) {
      return fetchSession(token);
    }

    return Promise.resolve(IS_LOCAL_PREVIEW ? inferDemoSession(token) : null);
  }

  function fetchOrderStatus(email, reference) {
    if (!API_BASE) {
      return Promise.resolve(null);
    }

    return fetch(API_BASE + "/api/orders/track", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json"
      },
      credentials: "same-origin",
      body: JSON.stringify({ email: email, reference: reference })
    }).then(function (response) {
      if (response.status === 404) {
        return null;
      }
      if (!response.ok) {
        throw new Error("Order status fetch failed");
      }
      return response.json();
    }).then(function (payload) {
      return payload ? normalizeSession(payload, payload.token || reference) : null;
    });
  }

  function findDemoOrder(email, reference) {
    var normalizedEmail = normalizeEmail(email);
    var normalizedReference = normalizeReference(reference);
    var order = demoTrackOrders.find(function (candidate) {
      return normalizeEmail(candidate.customerEmail) === normalizedEmail &&
        normalizeReference(candidate.reference) === normalizedReference;
    });

    return order ? normalizeSession(order, order.token || order.reference) : null;
  }

  function resolveOrderStatus(email, reference) {
    if (API_BASE) {
      return fetchOrderStatus(email, reference);
    }
    return Promise.resolve(IS_LOCAL_PREVIEW ? findDemoOrder(email, reference) : null);
  }

  function routeName() {
    var page = String(readParam("page") || "").toLowerCase();
    var path = decodeURIComponent(window.location.pathname).toLowerCase();
    if (page === "track" || page === "siparis-takip" || path.indexOf("track") >= 0 || path.indexOf("siparis-takip") >= 0) {
      return "track";
    }
    return "payment";
  }

  function setRoute(name) {
    $("#payment-route").classList.toggle("active", name === "payment");
    $("#track-route").classList.toggle("active", name === "track");
    $("#payment-nav").classList.toggle("active", name === "payment");
    $("#track-nav").classList.toggle("active", name === "track");
    document.body.setAttribute("data-route", name);
  }

  function renderPaymentState(title, message, label) {
    $("#checkout-screen").hidden = true;
    $("#locked-screen").hidden = false;
    $("#locked-screen .label").textContent = label || "Ödeme oturumu";
    $("#locked-screen h1").textContent = title;
    $("#locked-screen p").textContent = message;
  }

  function renderLocked() {
    renderPaymentState(
      "Geçerli ödeme tokenı bulunamadı",
      "Bu sayfa doğrudan açılmaz. Qlinik veya Praticase içinde ödeme talebi oluşturulduktan sonra uygulama tek kullanımlık ödeme tokenı üretir ve sizi buraya yönlendirir.",
      "Ödeme oturumu"
    );
  }

  function renderLoading() {
    renderPaymentState(
      "Token doğrulanıyor",
      "Ödeme bilgileri uygulamadan gelen token ile hazırlanıyor.",
      "Ödeme oturumu"
    );
  }

  function applyStatus(selector, status, fallbackLabel) {
    var meta = statusMeta[status] || { label: fallbackLabel || "Bekleniyor", tone: "warning" };
    var el = $(selector);
    el.textContent = meta.label;
    el.className = "status " + meta.tone;
  }

  function formatSessionLabel(session) {
    var product = session.product || "MedAsi";
    var channel = formatChannel(session.channel);
    if (product.toLowerCase().indexOf(channel.toLowerCase()) >= 0) {
      return product + " ödeme";
    }
    return product + " " + channel + " ödeme";
  }

  function statusReached(status, step) {
    var order = [
      "payment_pending",
      "receipt_uploaded",
      "review",
      "approved",
      "entitled"
    ];
    return order.indexOf(status) >= order.indexOf(step);
  }

  function paymentTimelineMarkup(session, receiptFileName) {
    var receiptDone = statusReached(session.status, "receipt_uploaded");
    var reviewDone = statusReached(session.status, "approved") || session.status === "rejected";
    var entitlementDone = statusReached(session.status, "entitled");
    var receiptMeta = receiptFileName || (receiptDone ? "Dekont ödeme servisine ulaştı" : "IBAN transferinden sonra");
    var reviewTitle = session.status === "rejected" ? "Ödeme reddedildi" : "Ödeme kontrolü";
    var reviewMeta = session.status === "rejected" ? "Dekont veya ödeme bilgileri eşleşmedi" : "Dekont kontrolünden sonra onaylanır";

    return (
      '<li class="event-row done"><span class="dot"></span><div><div class="row-title">Ödeme talebi oluşturuldu</div><div class="row-meta">' +
      escapeHtml(session.product) + " " + escapeHtml(formatChannel(session.channel)) + ' uygulamasında</div></div></li>' +
      '<li class="event-row done"><span class="dot"></span><div><div class="row-title">Açıklama kodu üretildi</div><div class="row-meta">' +
      escapeHtml(session.reference) + '</div></div></li>' +
      '<li class="event-row ' + (receiptDone ? "done" : "") + '"><span class="dot"></span><div><div class="row-title">' +
      (receiptDone ? "Dekont yüklendi" : "Dekont bekleniyor") + '</div><div class="row-meta">' +
      escapeHtml(receiptMeta) + '</div></div></li>' +
      '<li class="event-row ' + (reviewDone ? "done" : "") + '"><span class="dot"></span><div><div class="row-title">' +
      reviewTitle + '</div><div class="row-meta">' + reviewMeta + '</div></div></li>' +
      '<li class="event-row ' + (entitlementDone ? "done" : "") + '"><span class="dot"></span><div><div class="row-title">Hak tanımı</div><div class="row-meta">Onay sonrası ilgili hesaba işlenir</div></div></li>'
    );
  }

  function renderTimeline(session, receiptFileName) {
    $("#session-timeline").innerHTML = paymentTimelineMarkup(session, receiptFileName);
  }

  function renderSession(session) {
    currentSession = session;
    $("#locked-screen").hidden = true;
    $("#checkout-screen").hidden = false;

    $("#session-product-label").textContent = formatSessionLabel(session);
    $("#session-title").textContent = session.accountName;
    $("#session-reference").textContent = session.reference;
    $("#session-product-name").textContent = session.product;
    $("#session-channel").textContent = formatChannel(session.channel);
    $("#session-expires").textContent = formatDate(session.expiresAt);

    applyStatus("#session-status", session.status, "Ödeme bekleniyor");

    $("#bank-holder").textContent = session.bankAccount.holder;
    $("#bank-iban").textContent = session.bankAccount.iban;
    $("#bank-iban").setAttribute("data-copy", session.bankAccount.iban);
    $("#payment-reference").textContent = session.reference;
    $("#payment-reference").setAttribute("data-copy", session.reference);
    $("#bank-total").textContent = formatMoney(session.totalAmount);
    $("#session-total").textContent = formatMoney(session.totalAmount);

    $("#session-items").innerHTML = session.items.length ? session.items.map(function (item) {
      return (
        '<div class="summary-row">' +
          '<div><div class="row-title">' + escapeHtml(item.name) + '</div>' +
          '<div class="row-meta">' + item.qty + " x " + escapeHtml(item.unit) + '</div></div>' +
          '<strong>' + formatMoney(item.qty * item.price) + '</strong>' +
        '</div>'
      );
    }).join("") : '<p class="empty-state">Ödeme kalemi bekleniyor.</p>';

    renderTimeline(session);
  }

  function renderTrackEmpty(message, statusText, tone) {
    var status = $("#track-status");
    status.textContent = statusText || "Bekleniyor";
    status.className = "status " + (tone || "warning");
    $("#track-empty").hidden = false;
    $("#track-empty").textContent = message;
    $("#track-result").hidden = true;
  }

  function renderTrackOrder(order) {
    $("#track-empty").hidden = true;
    $("#track-result").hidden = false;
    applyStatus("#track-status", order.status, "Bekleniyor");
    $("#track-product").textContent = order.product;
    $("#track-reference-copy").textContent = order.reference;
    $("#track-reference-copy").setAttribute("data-copy", order.reference);
    $("#track-total").textContent = formatMoney(order.totalAmount);
    $("#track-timeline").innerHTML = paymentTimelineMarkup(order);
  }

  function toast(message) {
    var el = $("#toast");
    el.textContent = message;
    el.classList.add("show");
    window.clearTimeout(toast.timer);
    toast.timer = window.setTimeout(function () {
      el.classList.remove("show");
    }, 2200);
  }

  function formatFileSize(bytes) {
    if (!bytes) {
      return "";
    }
    if (bytes < 1024 * 1024) {
      return Math.round(bytes / 1024) + " KB";
    }
    return (bytes / 1024 / 1024).toFixed(1) + " MB";
  }

  function uploadReceipt(file) {
    if (!API_BASE || !currentSession || !currentSession.orderId) {
      return Promise.resolve({});
    }

    var body = new FormData();
    body.append("receipt", file);
    body.append("token", currentSession.token);

    return fetch(API_BASE + "/api/orders/" + encodeURIComponent(currentSession.orderId) + "/receipt", {
      method: "POST",
      body: body,
      credentials: "same-origin"
    }).then(function (response) {
      if (!response.ok) {
        throw new Error("Receipt upload failed");
      }
      return response.json().catch(function () {
        return {};
      });
    });
  }

  function bindCopyEvents() {
    document.addEventListener("click", function (event) {
      var copy = event.target.closest(".copy");
      if (!copy) {
        return;
      }
      var value = copy.getAttribute("data-copy") || copy.textContent.trim();
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(value).catch(function () {});
      }
      toast("Kopyalandı.");
    });
  }

  function bindReceiptForm() {
    $("#receipt-file").addEventListener("change", function (event) {
      var file = event.target.files[0];
      $("#receipt-meta").textContent = file
        ? file.name + " " + formatFileSize(file.size)
        : "Dosya seçilmedi.";
    });

    $("#receipt-form").addEventListener("submit", function (event) {
      event.preventDefault();
      var file = $("#receipt-file").files[0];
      var confirmed = $("#payment-confirm").checked;
      var submit = $("#receipt-submit");

      if (!currentSession) {
        toast("Ödeme oturumu bulunamadı.");
        return;
      }
      if (!confirmed) {
        toast("Ödeme onay kutusunu işaretleyin.");
        return;
      }
      if (!file) {
        toast("Dekont dosyası seçin.");
        return;
      }

      submit.disabled = true;
      submit.textContent = "Gönderiliyor";

      uploadReceipt(file).then(function () {
        currentSession.status = "receipt_uploaded";
        applyStatus("#session-status", currentSession.status, "Dekont yüklendi");
        renderTimeline(currentSession, file.name);
        toast("Dekont gönderildi.");
      }).catch(function () {
        toast("Dekont gönderilemedi.");
      }).finally(function () {
        submit.disabled = false;
        submit.textContent = "Dekontu gönder";
      });
    });
  }

  function bindTrackForm() {
    $("#track-form").addEventListener("submit", function (event) {
      event.preventDefault();

      var form = event.currentTarget;
      var submit = form.querySelector("button[type='submit']");
      var email = $("#track-email").value;
      var reference = $("#track-reference").value;

      if (!email || !reference) {
        toast("E-posta ve açıklama kodu girin.");
        return;
      }

      submit.disabled = true;
      submit.textContent = "Kontrol ediliyor";
      renderTrackEmpty("Sipariş durumu kontrol ediliyor.", "Kontrol ediliyor", "warning");

      resolveOrderStatus(email, reference).then(function (order) {
        if (!order) {
          renderTrackEmpty("Bu e-posta ve açıklama kodu ile sipariş bulunamadı.", "Bulunamadı", "danger");
          return;
        }
        renderTrackOrder(order);
      }).catch(function () {
        renderTrackEmpty("Sipariş durumu şu anda kontrol edilemedi.", "Hata", "danger");
      }).finally(function () {
        submit.disabled = false;
        submit.textContent = "Durumu kontrol et";
      });
    });
  }

  function bindEvents() {
    bindCopyEvents();
    bindReceiptForm();
    bindTrackForm();
  }

  function bootPayment() {
    var token = readToken();
    if (!token) {
      renderLocked();
      return;
    }

    renderLoading();
    resolveSession(token).then(function (session) {
      if (!session) {
        renderLocked();
        return;
      }
      renderSession(session);
    }).catch(function () {
      renderPaymentState(
        "Ödeme tokenı doğrulanamadı",
        "Token süresi dolmuş veya ödeme oturumu artık kullanılamıyor olabilir. Lütfen ödemeyi başlattığınız uygulamaya geri dönün.",
        "Ödeme oturumu"
      );
    });
  }

  function boot() {
    var route = routeName();
    bindEvents();
    setRoute(route);
    renderTrackEmpty("E-posta ve açıklama kodu girildiğinde sipariş durumu burada görünür.", "Bekleniyor", "warning");

    if (route === "payment") {
      bootPayment();
    }
  }

  boot();
}());
