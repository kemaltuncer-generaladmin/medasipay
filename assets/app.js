(function () {
  "use strict";

  var LOCAL_HOSTNAMES = ["", "localhost", "127.0.0.1", "::1"];
  var IS_LOCAL_PREVIEW = LOCAL_HOSTNAMES.indexOf(window.location.hostname) >= 0;
  var IS_FILE_PREVIEW = window.location.protocol === "file:";
  var configuredApiBase = window.MEDASI_PAYMENT_API_BASE;
  var API_BASE = configuredApiBase === undefined
    ? (IS_FILE_PREVIEW ? "" : window.location.origin)
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
    android: "Android",
    web: "Web"
  };

  var statusMeta = {
    payment_pending: { label: "Ödeme bekleniyor", tone: "warning" },
    receipt_uploaded: { label: "Dekont yüklendi", tone: "info" },
    review: { label: "Kontrol ediliyor", tone: "warning" },
    approved: { label: "Onaylandı", tone: "success" },
    entitled: { label: "Hak tanımlandı", tone: "success" },
    rejected: { label: "Reddedildi", tone: "danger" },
    expired: { label: "Süresi dolmuş", tone: "danger" }
  };

  var resumeMeta = {
    payment_pending: {
      title: "Bu sipariş için ödeme henüz tamamlanmadı.",
      subtitle: "Banka bilgilerini gör, transferi yap ve dekontu yükle.",
      button: "Ödemeye devam et"
    },
    receipt_uploaded: {
      title: "Dekontu yükledin, kontrol bekleniyor.",
      subtitle: "Gerekirse yeni bir dekont yükleyebilir veya bilgileri tekrar görüntüleyebilirsin.",
      button: "Ödeme ekranını aç"
    },
    review: {
      title: "Sipariş ekibimizin kontrolünde.",
      subtitle: "Onay sürerken bilgileri görüntüleyebilirsin.",
      button: "Sipariş ekranını aç"
    }
  };

  var demoExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  var demoSessions = {
    pay_qlinik_demo: {
      token: "pay_qlinik_demo",
      channel: "web",
      product: "Qlinik",
      reference: "QLN-8F3K2",
      accountName: "Qlinik web kullanıcısı",
      customerEmail: "demo@qlinik.com",
      expiresAt: demoExpiresAt,
      items: [
        { name: "Doktor paketi", quantity: 1, unit: "1 kullanıcı", unitPrice: 1490 },
        { name: "SMS kontörü", quantity: 1, unit: "1000 SMS", unitPrice: 690 }
      ]
    },
    pay_praticase_demo: {
      token: "pay_praticase_demo",
      channel: "web",
      product: "Praticase",
      reference: "PRC-92A7X",
      accountName: "Praticase web kullanıcısı",
      customerEmail: "demo@praticase.com",
      expiresAt: demoExpiresAt,
      items: [
        { name: "Ofis lisansı", quantity: 1, unit: "1 ofis", unitPrice: 1890 },
        { name: "Ek kullanıcı", quantity: 2, unit: "1 kullanıcı", unitPrice: 490 }
      ]
    }
  };

  var demoTrackOrders = [
    Object.assign({}, demoSessions.pay_qlinik_demo, { status: "payment_pending" }),
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
    if (channel === "mobile" || channel === "mobil") {
      return "android";
    }
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

  function formatRelativeExpiry(value) {
    if (!value) return "";
    var target = new Date(value).getTime();
    if (!Number.isFinite(target)) return "";
    var diff = target - Date.now();
    if (diff <= 0) return "Süre doldu";
    var minutes = Math.round(diff / 60000);
    if (minutes < 60) return minutes + " dk içinde sona erer";
    var hours = Math.round(minutes / 60);
    if (hours < 24) return hours + " sa içinde sona erer";
    var days = Math.round(hours / 24);
    return days + " gün içinde sona erer";
  }

  function isExpiredSession(session) {
    if (!session || !session.expiresAt) return false;
    var ts = new Date(session.expiresAt).getTime();
    return Number.isFinite(ts) && ts <= Date.now();
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
      return fetchSession(token).catch(function (error) {
        var demoSession = IS_LOCAL_PREVIEW ? inferDemoSession(token) : null;
        if (demoSession) {
          return demoSession;
        }
        throw error;
      });
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
      return fetchOrderStatus(email, reference).catch(function (error) {
        if (IS_LOCAL_PREVIEW) {
          return findDemoOrder(email, reference);
        }
        throw error;
      });
    }
    return Promise.resolve(IS_LOCAL_PREVIEW ? findDemoOrder(email, reference) : null);
  }

  function routeName() {
    var page = String(readParam("page") || "").toLowerCase();
    var path = decodeURIComponent(window.location.pathname).toLowerCase();
    if (page === "track" || page === "siparis-takip" || path.indexOf("track") >= 0 || path.indexOf("siparis-takip") >= 0) {
      return "track";
    }
    return readToken() ? "payment" : "track";
  }

  function setRoute(name) {
    $("#payment-route").classList.toggle("active", name === "payment");
    $("#track-route").classList.toggle("active", name === "track");
    $("#payment-nav").classList.toggle("active", name === "payment");
    $("#track-nav").classList.toggle("active", name === "track");
    document.body.setAttribute("data-route", name);
  }

  function configurePaymentNavigation() {
    var token = readToken();
    var paymentNav = $("#payment-nav");
    paymentNav.hidden = !token;
    if (token) {
      paymentNav.setAttribute("href", "?token=" + encodeURIComponent(token));
    }
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
      "Bu sayfa doğrudan açılmaz. Qlinik veya Praticase uygulamasında ödeme talebi oluşturulduktan sonra size özel tek kullanımlık bir bağlantı üretilir ve buraya yönlendirilirsiniz.",
      "Ödeme oturumu"
    );
  }

  function renderLoading() {
    renderPaymentState(
      "Ödeme bilgileri hazırlanıyor",
      "Sipariş bilgileriniz uygulamadan gelen güvenli token ile doğrulanıyor.",
      "Bir saniye"
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

  function statusIs(status, step) {
    return status === step;
  }

  function timelineRow(state, title, meta) {
    return '<li class="event-row ' + state + '"><span class="dot"></span><div><div class="row-title">' +
      title + '</div><div class="row-meta">' + meta + '</div></div></li>';
  }

  function paymentTimelineMarkup(session, receiptFileName) {
    var status = session.status;
    var rejected = status === "rejected";
    var receiptDone = statusReached(status, "receipt_uploaded");
    var reviewDone = statusReached(status, "approved");
    var entitlementDone = statusReached(status, "entitled");

    var rows = [];
    rows.push(timelineRow("done",
      "Ödeme talebi oluşturuldu",
      escapeHtml(session.product) + " " + escapeHtml(formatChannel(session.channel)) + " uygulamasında"));

    rows.push(timelineRow("done",
      "Açıklama kodu üretildi",
      escapeHtml(session.reference)));

    var receiptState = receiptDone ? "done" : (statusIs(status, "payment_pending") ? "current" : "");
    var receiptMeta = receiptFileName
      ? escapeHtml(receiptFileName)
      : (receiptDone ? "Dekont ödeme servisine ulaştı" : "IBAN'a transfer sonrası dekont yükleyin");
    rows.push(timelineRow(receiptState,
      receiptDone ? "Dekont yüklendi" : "Dekont bekleniyor",
      receiptMeta));

    var reviewState = reviewDone ? "done" : (rejected ? "danger" : (receiptDone ? "current" : ""));
    var reviewTitle = rejected ? "Ödeme reddedildi" : (reviewDone ? "Ödeme onaylandı" : "Ödeme kontrolü");
    var reviewMeta = rejected
      ? "Dekont veya ödeme bilgileri eşleşmedi"
      : (reviewDone ? "Tutar ve açıklama kodu doğrulandı" : "Ekibimiz dekontu kontrol ediyor");
    rows.push(timelineRow(reviewState, reviewTitle, reviewMeta));

    var entitlementState = entitlementDone ? "done" : (reviewDone ? "current" : "");
    rows.push(timelineRow(entitlementState,
      "Hak tanımı",
      entitlementDone ? "İlgili hesaba işlendi" : "Onay sonrası ilgili hesaba işlenir"));

    return rows.join("");
  }

  function renderTimeline(session, receiptFileName) {
    $("#session-timeline").innerHTML = paymentTimelineMarkup(session, receiptFileName);
  }

  function renderExpiryPill(session) {
    var pill = $("#expiry-pill");
    var text = $("#expiry-text");
    if (!pill || !text) return;
    var label = formatRelativeExpiry(session.expiresAt);
    if (!label || isExpiredSession(session)) {
      pill.hidden = true;
      return;
    }
    text.textContent = label;
    pill.hidden = false;
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

    renderExpiryPill(session);
    renderTimeline(session);
    updatePaymentUiForStatus(session);
  }

  function updatePaymentUiForStatus(session) {
    var form = $("#receipt-form");
    var help = $("#payment-help");
    var canUpload = ["payment_pending", "receipt_uploaded"].indexOf(session.status) >= 0
      && !isExpiredSession(session);

    if (form) {
      form.querySelectorAll("input,button").forEach(function (el) {
        el.disabled = !canUpload;
      });
    }

    if (!help) return;
    if (isExpiredSession(session)) {
      help.className = "callout";
      help.querySelector("strong").textContent = "Ödeme oturumunun süresi dolmuş.";
      help.querySelector("span").textContent = "Lütfen ödemeyi başlattığınız uygulamadan yeni bir bağlantı oluşturun.";
    } else if (session.status === "approved" || session.status === "entitled") {
      help.className = "callout success";
      help.querySelector("strong").textContent = "Ödemeniz onaylandı.";
      help.querySelector("span").textContent = "İlgili hesabınıza hak tanımı işlenmiştir; ek bir işlem yapmanıza gerek yoktur.";
    } else if (session.status === "rejected") {
      help.className = "callout";
      help.querySelector("strong").textContent = "Ödeme reddedildi.";
      help.querySelector("span").textContent = "Dekont veya ödeme bilgileri eşleşmedi. Lütfen destek ile iletişime geçin.";
    } else if (session.status === "receipt_uploaded") {
      help.className = "callout info";
      help.querySelector("strong").textContent = "Dekontunuz alındı, kontrol bekleniyor.";
      help.querySelector("span").textContent = "Tutar ve açıklama kodu doğrulandıktan sonra siparişiniz onaylanacaktır.";
    } else {
      help.className = "callout info";
      help.querySelector("strong").textContent = "Tutarı tam olarak ve TL hesabına yatırın.";
      help.querySelector("span").textContent = "Eksik tutar veya açıklama kodu olmadan yapılan transferler manuel inceleme nedeniyle gecikebilir.";
    }
  }

  function renderTrackEmpty(message, statusText, tone) {
    var status = $("#track-status");
    status.textContent = statusText || "Bekleniyor";
    status.className = "status " + (tone || "warning");
    $("#track-empty").hidden = false;
    $("#track-empty").textContent = message;
    $("#track-result").hidden = true;
  }

  function configureResume(order) {
    var card = $("#track-resume");
    if (!card) return;

    var canResume = ["payment_pending", "receipt_uploaded", "review"].indexOf(order.status) >= 0
      && order.token
      && !isExpiredSession(order);

    if (!canResume) {
      card.hidden = true;
      return;
    }

    var meta = resumeMeta[order.status] || resumeMeta.payment_pending;
    $("#track-resume-title").textContent = meta.title;
    $("#track-resume-subtitle").textContent = meta.subtitle;

    var button = $("#track-resume-button");
    var svg = button.querySelector("svg");
    button.innerHTML = "";
    if (svg) button.appendChild(svg);
    button.appendChild(document.createTextNode(" " + meta.button));
    button.setAttribute("href", "?token=" + encodeURIComponent(order.token));
    card.hidden = false;
  }

  function renderTrackOrder(order) {
    $("#track-empty").hidden = true;
    $("#track-result").hidden = false;
    applyStatus("#track-status", order.status, "Bekleniyor");
    $("#track-product").textContent = order.product;
    $("#track-reference-copy").textContent = order.reference;
    $("#track-reference-copy").setAttribute("data-copy", order.reference);
    $("#track-total").textContent = formatMoney(order.totalAmount);
    var expiresNode = $("#track-expires");
    if (expiresNode) {
      var expiryText = order.expiresAt ? formatDate(order.expiresAt) : "-";
      if (order.expiresAt && isExpiredSession(order)) {
        expiryText += " (süresi dolmuş)";
      }
      expiresNode.textContent = expiryText;
    }
    configureResume(order);
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
      if (!value || value === "-") {
        return;
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(value).catch(function () {});
      }
      toast("Kopyalandı.");
    });
  }

  function bindReceiptForm() {
    var fileInput = $("#receipt-file");
    var meta = $("#receipt-meta");

    fileInput.addEventListener("change", function (event) {
      var file = event.target.files[0];
      if (!file) {
        meta.textContent = "Dosya seçilmedi. PDF, PNG veya JPG kabul edilir (en fazla 10 MB).";
        return;
      }
      meta.textContent = file.name + " — " + formatFileSize(file.size);
    });

    $("#receipt-form").addEventListener("submit", function (event) {
      event.preventDefault();
      var file = fileInput.files[0];
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
      var originalHTML = submit.innerHTML;
      submit.textContent = "Gönderiliyor...";

      uploadReceipt(file).then(function () {
        currentSession.status = "receipt_uploaded";
        applyStatus("#session-status", currentSession.status, "Dekont yüklendi");
        renderTimeline(currentSession, file.name);
        updatePaymentUiForStatus(currentSession);
        toast("Dekont gönderildi. Ekibimiz kontrol edecektir.");
      }).catch(function () {
        toast("Dekont gönderilemedi. Lütfen tekrar deneyin.");
      }).finally(function () {
        submit.disabled = false;
        submit.innerHTML = originalHTML;
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
      var originalHTML = submit.innerHTML;
      submit.textContent = "Kontrol ediliyor...";
      renderTrackEmpty("Sipariş durumu kontrol ediliyor.", "Kontrol ediliyor", "warning");

      resolveOrderStatus(email, reference).then(function (order) {
        if (!order) {
          renderTrackEmpty("Bu e-posta ve açıklama kodu ile sipariş bulunamadı.", "Bulunamadı", "danger");
          return;
        }
        renderTrackOrder(order);
      }).catch(function () {
        renderTrackEmpty("Sipariş durumu şu anda kontrol edilemedi. Lütfen biraz sonra tekrar deneyin.", "Hata", "danger");
      }).finally(function () {
        submit.disabled = false;
        submit.innerHTML = originalHTML;
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
        "Tokenın süresi dolmuş veya ödeme oturumu artık kullanılamıyor olabilir. Lütfen ödemeyi başlattığınız uygulamaya geri dönün.",
        "Ödeme oturumu"
      );
    });
  }

  function boot() {
    var route = routeName();
    bindEvents();
    configurePaymentNavigation();
    setRoute(route);
    renderTrackEmpty("E-posta adresinizi ve açıklama kodunu girdiğinizde sipariş durumu burada görünür.", "Bekleniyor", "warning");

    if (route === "payment") {
      bootPayment();
    }
  }

  boot();
}());
