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
  var RECEIPT_MAX_BYTES = 3 * 1024 * 1024;
  var RECEIPT_ALLOWED_MIME_TYPES = ["application/pdf", "image/png", "image/jpeg"];
  var RECEIPT_ALLOWED_EXTENSIONS = [".pdf", ".png", ".jpg", ".jpeg"];
  var RECEIPT_HELP_TEXT = "Dosya seçilmedi. PDF, PNG veya JPEG kabul edilir (en fazla 3 MB).";
  var CARD_PROFILE_STORAGE_KEY = "medasi-card-profile-v1";
  var TURKEY_PROVINCES = [
    ["01", "Adana"], ["02", "Adıyaman"], ["03", "Afyonkarahisar"], ["04", "Ağrı"],
    ["05", "Amasya"], ["06", "Ankara"], ["07", "Antalya"], ["08", "Artvin"],
    ["09", "Aydın"], ["10", "Balıkesir"], ["11", "Bilecik"], ["12", "Bingöl"],
    ["13", "Bitlis"], ["14", "Bolu"], ["15", "Burdur"], ["16", "Bursa"],
    ["17", "Çanakkale"], ["18", "Çankırı"], ["19", "Çorum"], ["20", "Denizli"],
    ["21", "Diyarbakır"], ["22", "Edirne"], ["23", "Elazığ"], ["24", "Erzincan"],
    ["25", "Erzurum"], ["26", "Eskişehir"], ["27", "Gaziantep"], ["28", "Giresun"],
    ["29", "Gümüşhane"], ["30", "Hakkari"], ["31", "Hatay"], ["32", "Isparta"],
    ["33", "Mersin"], ["34", "İstanbul"], ["35", "İzmir"], ["36", "Kars"],
    ["37", "Kastamonu"], ["38", "Kayseri"], ["39", "Kırklareli"], ["40", "Kırşehir"],
    ["41", "Kocaeli"], ["42", "Konya"], ["43", "Kütahya"], ["44", "Malatya"],
    ["45", "Manisa"], ["46", "Kahramanmaraş"], ["47", "Mardin"], ["48", "Muğla"],
    ["49", "Muş"], ["50", "Nevşehir"], ["51", "Niğde"], ["52", "Ordu"],
    ["53", "Rize"], ["54", "Sakarya"], ["55", "Samsun"], ["56", "Siirt"],
    ["57", "Sinop"], ["58", "Sivas"], ["59", "Tekirdağ"], ["60", "Tokat"],
    ["61", "Trabzon"], ["62", "Tunceli"], ["63", "Şanlıurfa"], ["64", "Uşak"],
    ["65", "Van"], ["66", "Yozgat"], ["67", "Zonguldak"], ["68", "Aksaray"],
    ["69", "Bayburt"], ["70", "Karaman"], ["71", "Kırıkkale"], ["72", "Batman"],
    ["73", "Şırnak"], ["74", "Bartın"], ["75", "Ardahan"], ["76", "Iğdır"],
    ["77", "Yalova"], ["78", "Karabük"], ["79", "Kilis"], ["80", "Osmaniye"],
    ["81", "Düzce"]
  ];

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
  var currentPaymentMethod = "bank_transfer";

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
      paymentMethod: source.paymentMethod || "bank_transfer",
      paymentOptions: {
        bankTransfer: !source.paymentOptions || source.paymentOptions.bankTransfer !== false,
        card: Boolean(source.paymentOptions && source.paymentOptions.card === true)
      },
      cardPayment: source.cardPayment || null,
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

    if (session.paymentMethod === "card" || session.cardPayment) {
      var cardPayment = session.cardPayment || {};
      var cardAuthorized = cardPayment.status === "authorized" ||
        status === "approved" ||
        status === "entitled";
      var cardFailed = String(cardPayment.status || "").indexOf("failed") >= 0 ||
        String(cardPayment.status || "").indexOf("declined") >= 0;
      var cardState = cardAuthorized ? "done" : (cardFailed ? "danger" : "current");
      rows.push(timelineRow(cardState,
        cardAuthorized ? "Kart ödemesi alındı" : (cardFailed ? "Kart ödemesi tamamlanamadı" : "Kart doğrulaması"),
        cardPayment.responseMessage || (cardAuthorized ? "Kuveyt Türk provizyonu onaylandı" : "3D Secure doğrulaması bekleniyor")));

      var cardReviewState = reviewDone ? "done" : (cardAuthorized ? "current" : "");
      rows.push(timelineRow(cardReviewState,
        reviewDone ? "Ödeme onaylandı" : "Ödeme kontrolü",
        reviewDone ? "Kart provizyon bilgisi doğrulandı" : "Provizyon sonrası sipariş onaylanır"));

      var cardEntitlementState = entitlementDone ? "done" : (reviewDone ? "current" : "");
      rows.push(timelineRow(cardEntitlementState,
        "Hak tanımı",
        entitlementDone ? "İlgili hesaba işlendi" : "Onay sonrası ilgili hesaba işlenir"));

      return rows.join("");
    }

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
    animateCheckoutEntrance();

    $("#session-product-label").textContent = formatSessionLabel(session);
    $("#session-title").textContent = session.accountName;
    $("#session-reference").textContent = session.reference;
    $("#session-product-name").textContent = session.product;
    $("#session-channel").textContent = formatChannel(session.channel);
    $("#session-expires").textContent = formatDate(session.expiresAt);

    applyStatus("#session-status", session.status, "Ödeme bekleniyor");

    var bankHolder = $("#bank-holder");
    if (bankHolder) {
      bankHolder.textContent = session.bankAccount.holder;
      bankHolder.setAttribute("data-copy", session.bankAccount.holder);
    }
    $("#bank-iban").textContent = session.bankAccount.iban;
    $("#bank-iban").setAttribute("data-copy", session.bankAccount.iban);

    var ibanHero = $("#iban-hero");
    var ibanHeroNumber = $("#iban-hero-number");
    var ibanHeroBtn = $("#iban-hero-copy");
    var ibanHeroHolder = $("#iban-hero-holder");
    if (ibanHeroNumber) ibanHeroNumber.textContent = session.bankAccount.iban;
    if (ibanHeroBtn) ibanHeroBtn.setAttribute("data-copy", session.bankAccount.iban);
    if (ibanHeroHolder) ibanHeroHolder.textContent = session.bankAccount.holder;
    if (ibanHero) {
      ibanHero.hidden = false;
      animateIbanHero();
    }
    $("#payment-reference").textContent = session.reference;
    $("#payment-reference").setAttribute("data-copy", session.reference);
    $("#bank-total").textContent = formatMoney(session.totalAmount);
    $("#session-total").textContent = formatMoney(session.totalAmount);
    configurePaymentMethods(session);
    configureCardForm(session);
    renderCardResult(session);

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

  function configurePaymentMethods(session) {
    var canUseCard = session.paymentOptions && session.paymentOptions.card !== false;
    var cardOption = $("#card-method-option");
    if (cardOption) {
      cardOption.disabled = !canUseCard;
      cardOption.setAttribute("aria-disabled", canUseCard ? "false" : "true");
    }

    var result = String(readParam("cardResult") || "").toLowerCase();
    var preferred = result ? "card" : (session.paymentMethod === "card" ? "card" : "bank_transfer");
    if (preferred === "card" && !canUseCard && !session.cardPayment) {
      preferred = "bank_transfer";
    }
    setPaymentMethod(preferred);
  }

  function setPaymentMethod(method) {
    currentPaymentMethod = method === "card" ? "card" : "bank_transfer";
    var bankPanel = $("#bank-panel");
    var cardPanel = $("#card-panel");
    if (bankPanel) bankPanel.hidden = currentPaymentMethod !== "bank_transfer";
    if (cardPanel) cardPanel.hidden = currentPaymentMethod !== "card";

    document.querySelectorAll("[data-payment-method]").forEach(function (button) {
      var active = button.getAttribute("data-payment-method") === currentPaymentMethod;
      button.classList.toggle("active", active);
      button.setAttribute("aria-checked", active ? "true" : "false");
    });

    var help = $("#payment-help");
    if (help && currentSession && currentSession.status === "payment_pending" && !isExpiredSession(currentSession)) {
      help.className = "callout info";
      if (currentPaymentMethod === "card") {
        help.querySelector("strong").textContent = "Kartla ödeme 3D Secure ile tamamlanır.";
        help.querySelector("span").textContent = "Kart doğrulaması başarılı olursa provizyon alınır ve sipariş otomatik tamamlanır.";
      } else {
        help.querySelector("strong").textContent = "Tutarı tam olarak ve TL hesabına yatırın.";
        help.querySelector("span").textContent = "Eksik tutar veya açıklama kodu olmadan yapılan transferler manuel inceleme nedeniyle gecikebilir.";
      }
    }
  }

  function configureCardForm(session) {
    var form = $("#card-form");
    if (!form) return;
    var canUseCard = session.paymentOptions && session.paymentOptions.card !== false;
    var canSubmit = canUseCard &&
      session.status === "payment_pending" &&
      !isExpiredSession(session) &&
      session.orderId;
    form.action = API_BASE + "/api/orders/" + encodeURIComponent(session.orderId || "") + "/card/initiate";
    $("#card-token").value = session.token || "";
    $("#card-email").value = session.customerEmail || "";
    form.dataset.sessionEnabled = canSubmit ? "true" : "false";
    form.querySelectorAll("input,select,textarea").forEach(function (el) {
      el.disabled = el.type === "hidden" ? false : !canSubmit;
    });
    updateCardFormValidity(false);
    var disabledNote = $("#card-disabled-note");
    if (disabledNote) disabledNote.hidden = canUseCard;
  }

  function renderCardResult(session) {
    var result = String(readParam("cardResult") || "").toLowerCase();
    var message = readParam("cardMessage");
    var box = $("#card-result");
    if (!box || !result) return;
    var success = result === "success";
    box.hidden = false;
    box.className = "callout " + (success ? "success" : "");
    $("#card-result-title").textContent = success
      ? "Kart ödemeniz alındı."
      : "Kart ödemesi tamamlanamadı.";
    $("#card-result-message").textContent = message ||
      (success
        ? "Siparişiniz otomatik onay sürecine alındı."
        : "Tekrar kartla deneyebilir veya IBAN ile devam edebilirsiniz.");
    if (session.cardPayment && session.cardPayment.responseMessage && !message) {
      $("#card-result-message").textContent = session.cardPayment.responseMessage;
    }
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

    var cardForm = $("#card-form");
    if (cardForm) {
      var canCardSubmit = session.paymentOptions && session.paymentOptions.card !== false &&
        session.status === "payment_pending" &&
        !isExpiredSession(session);
      cardForm.dataset.sessionEnabled = canCardSubmit ? "true" : "false";
      cardForm.querySelectorAll("input,select,textarea").forEach(function (el) {
        el.disabled = el.type === "hidden" ? false : !canCardSubmit;
      });
      updateCardFormValidity(false);
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
      if (currentPaymentMethod === "card") {
        help.querySelector("strong").textContent = "Kartla ödeme 3D Secure ile tamamlanır.";
        help.querySelector("span").textContent = "Kart doğrulaması başarılı olursa provizyon alınır ve sipariş otomatik tamamlanır.";
      } else {
        help.querySelector("strong").textContent = "Tutarı tam olarak ve TL hesabına yatırın.";
        help.querySelector("span").textContent = "Eksik tutar veya açıklama kodu olmadan yapılan transferler manuel inceleme nedeniyle gecikebilir.";
      }
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
    if (order.paymentMethod === "card" && order.status === "payment_pending") {
      meta = {
        title: "Bu sipariş için kart ödemesi tamamlanmadı.",
        subtitle: "Kartla tekrar deneyebilir veya IBAN ile ödeme akışına geçebilirsiniz.",
        button: "Ödemeye devam et"
      };
    }
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

  function receiptFileExtension(file) {
    var name = (file && file.name ? file.name : "").toLowerCase();
    var index = name.lastIndexOf(".");
    return index >= 0 ? name.slice(index) : "";
  }

  function isAllowedReceiptFile(file) {
    var type = (file && file.type ? file.type : "").toLowerCase();
    var extension = receiptFileExtension(file);
    return RECEIPT_ALLOWED_MIME_TYPES.indexOf(type) >= 0 ||
      RECEIPT_ALLOWED_EXTENSIONS.indexOf(extension) >= 0;
  }

  function receiptFileError(file) {
    if (!file) {
      return "Dekont dosyası seçin.";
    }
    if (file.size > RECEIPT_MAX_BYTES) {
      return "Dekont dosyası en fazla 3 MB olmalı.";
    }
    if (!isAllowedReceiptFile(file)) {
      return "Dekont PDF, PNG veya JPEG olmalı.";
    }
    return "";
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
      return response.text().then(function (text) {
        var payload = {};
        if (text) {
          try {
            payload = JSON.parse(text);
          } catch (error) {
            payload = {};
          }
        }
        if (!response.ok) {
          throw new Error(payload.error || "Dekont gönderilemedi. Lütfen tekrar deneyin.");
        }
        return payload;
      });
    });
  }

  function bindCopyEvents() {
    document.addEventListener("click", function (event) {
      var copy = event.target.closest(".copy, .iban-hero-btn");
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
      if (copy.classList.contains("iban-hero-btn")) {
        var copiedEl = copy.querySelector(".iban-hero-copied");
        if (copiedEl) {
          copiedEl.textContent = "Kopyalandı!";
          setTimeout(function () { copiedEl.textContent = ""; }, 2000);
        }
      } else {
        toast("Kopyalandı.");
      }
    });
  }

  function bindProceedButton() {
    var btn = $("#proceed-to-payment");
    if (!btn) return;
    btn.addEventListener("click", function () {
      var target = currentPaymentMethod === "card" ? $("#card-panel") : $("#bank-panel");
      if (!target) return;
      target.scrollIntoView({ behavior: "smooth", block: "start" });
      var m = window.Motion;
      if (!m || !m.animate) return;
      setTimeout(function () {
        m.animate(target, { boxShadow: ["0 0 0 0px #0f766e00", "0 0 0 4px #0f766e66", "0 0 0 0px #0f766e00"] }, { duration: 0.9, easing: "ease-out" });
      }, 400);
    });
  }

  function bindPaymentMethodSelector() {
    document.querySelectorAll("[data-payment-method]").forEach(function (button) {
      button.addEventListener("click", function () {
        if (button.disabled) {
          toast("Kart ödeme şu anda yapılandırılmamış.");
          return;
        }
        setPaymentMethod(button.getAttribute("data-payment-method"));
      });
    });
  }

  function digitsOnly(value) {
    return String(value || "").replace(/\D/g, "");
  }

  function formatCardNumber(value) {
    return digitsOnly(value).slice(0, 19).replace(/(.{4})/g, "$1 ").trim();
  }

  function formatCardExpiry(value) {
    var digits = digitsOnly(value).slice(0, 4);
    return digits.length > 2 ? digits.slice(0, 2) + "/" + digits.slice(2) : digits;
  }

  function formatTurkeyPhone(value) {
    var digits = digitsOnly(value);
    if (digits.indexOf("90") === 0) digits = digits.slice(2);
    return digits.replace(/^0+/, "").slice(0, 10);
  }

  function syncCardExpiry() {
    var expiry = $("#card-expiry");
    var digits = digitsOnly(expiry ? expiry.value : "");
    $("#card-expiry-month").value = digits.slice(0, 2);
    $("#card-expiry-year").value = digits.slice(2, 4);
  }

  function detectCardBrand(value) {
    var digits = digitsOnly(value);
    if (/^9792/.test(digits)) return "TROY";
    if (/^4/.test(digits)) return "VISA";
    if (/^(5[1-5]\d{2}|2(?:2(?:2[1-9]|[3-9]\d)|[3-6]\d{2}|7(?:[01]\d|20)))/.test(digits)) {
      return "Mastercard";
    }
    return "";
  }

  function updateCardBrandUi() {
    var cardNumber = $("#card-number");
    var brand = detectCardBrand(cardNumber ? cardNumber.value : "");
    document.querySelectorAll(".accepted-card-brands img").forEach(function (logo) {
      logo.classList.toggle("muted", Boolean(brand) && logo.alt !== brand);
    });
  }

  function passesLuhnCheck(value) {
    var sum = 0;
    var shouldDouble = false;
    for (var index = value.length - 1; index >= 0; index -= 1) {
      var digit = Number(value[index]);
      if (shouldDouble) {
        digit *= 2;
        if (digit > 9) digit -= 9;
      }
      sum += digit;
      shouldDouble = !shouldDouble;
    }
    return sum % 10 === 0;
  }

  function isFutureCardExpiry(month, year) {
    var expiryMonth = Number(digitsOnly(month));
    var yearDigits = digitsOnly(year);
    var expiryYear = Number(yearDigits.length === 4 ? yearDigits : "20" + yearDigits);
    var now = new Date();
    return expiryMonth >= 1 && expiryMonth <= 12 &&
      expiryYear >= now.getFullYear() &&
      (expiryYear > now.getFullYear() || expiryMonth >= now.getMonth() + 1);
  }

  function syncBillingState() {
    var city = $("#billing-city");
    var state = $("#billing-state");
    if (!city || !state) return;
    var option = city.options[city.selectedIndex];
    state.value = option ? option.getAttribute("data-code") || "" : "";
  }

  function configureProvinceSelect() {
    var city = $("#billing-city");
    if (!city || city.options.length > 1) return;
    TURKEY_PROVINCES.forEach(function (province) {
      var option = document.createElement("option");
      option.value = province[1];
      option.textContent = province[1];
      option.setAttribute("data-code", province[0]);
      city.appendChild(option);
    });
    city.addEventListener("change", syncBillingState);
  }

  function readCardProfile() {
    try {
      return JSON.parse(window.localStorage.getItem(CARD_PROFILE_STORAGE_KEY) || "{}");
    } catch (error) {
      return {};
    }
  }

  function restoreCardProfile() {
    var profile = readCardProfile();
    var values = {
      "#card-holder-name": profile.cardHolderName,
      "#card-phone": profile.cardPhone,
      "#billing-city": profile.billAddrCity,
      "#billing-address": profile.billAddrLine1,
      "#billing-postcode": profile.billAddrPostCode
    };
    Object.keys(values).forEach(function (selector) {
      var input = $(selector);
      if (input && values[selector]) input.value = values[selector];
    });
    syncBillingState();
  }

  function saveCardProfile() {
    try {
      window.localStorage.setItem(CARD_PROFILE_STORAGE_KEY, JSON.stringify({
        cardHolderName: $("#card-holder-name").value.trim(),
        cardPhone: digitsOnly($("#card-phone").value),
        billAddrCity: $("#billing-city").value,
        billAddrLine1: $("#billing-address").value.trim(),
        billAddrPostCode: digitsOnly($("#billing-postcode").value)
      }));
    } catch (error) {
      // The payment can continue when browser storage is unavailable.
    }
  }

  function cardFieldError(input) {
    if (!input || input.disabled) return "";
    var value = input.value.trim();
    var digits = digitsOnly(value);
    if (!value) return "Bu alan zorunlu.";
    if (input.id === "card-holder-name") {
      return /^[\p{L} .'-]{2,45}$/u.test(value) && value.replace(/[^\p{L}]/gu, "").length >= 2
        ? ""
        : "Kart üzerindeki ad soyadı girin.";
    }
    if (input.id === "card-number") {
      if (digits.length < 13 || digits.length > 19) return "Kart numarası 13-19 haneli olmalı.";
      if (!detectCardBrand(digits)) return "Yalnız TROY, Mastercard veya Visa kart kullanabilirsiniz.";
      return passesLuhnCheck(digits) ? "" : "Kart numarasını kontrol edin.";
    }
    if (input.id === "card-expiry") {
      if (!/^(0[1-9]|1[0-2])\d{2}$/.test(digits)) return "Son kullanma tarihini AA/YY olarak girin.";
      return isFutureCardExpiry(digits.slice(0, 2), digits.slice(2)) ? "" : "Son kullanma tarihi geçmiş.";
    }
    if (input.id === "card-cvv") {
      return /^\d{3}$/.test(digits) ? "" : "CVV / CVC üç haneli olmalı.";
    }
    if (input.id === "card-email") {
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? "" : "Sipariş e-postası geçersiz.";
    }
    if (input.id === "card-phone") {
      return /^5\d{9}$/.test(digits) ? "" : "5 ile başlayan 10 haneli cep telefonu girin.";
    }
    if (input.id === "billing-city") {
      return $("#billing-state").value ? "" : "Fatura ilini seçin.";
    }
    if (input.id === "billing-address") {
      return value.length >= 10 && /\p{L}/u.test(value) ? "" : "Açık adres en az 10 karakter olmalı.";
    }
    if (input.id === "billing-postcode") {
      var state = $("#billing-state").value;
      return state && new RegExp("^" + state + "\\d{3}$").test(digits)
        ? ""
        : "Posta kodu seçilen il ile eşleşmeli.";
    }
    return "";
  }

  function renderCardFieldError(input, error, forceErrors) {
    if (!input) return;
    var show = Boolean(error) && (forceErrors || input.dataset.touched === "true");
    input.setAttribute("aria-invalid", show ? "true" : "false");
    var field = input.closest(".field");
    if (!field) return;
    var message = field.querySelector(".field-error");
    if (!message) {
      message = document.createElement("small");
      message.className = "field-error";
      field.appendChild(message);
    }
    message.textContent = show ? error : "";
    message.hidden = !show;
  }

  function updateCardFormValidity(forceErrors) {
    var form = $("#card-form");
    var submit = $("#card-submit");
    if (!form || !submit) return false;
    syncCardExpiry();
    syncBillingState();
    updateCardBrandUi();
    var valid = true;
    form.querySelectorAll("input:not([type='hidden']),select,textarea").forEach(function (input) {
      var error = cardFieldError(input);
      if (error) valid = false;
      renderCardFieldError(input, error, forceErrors);
    });
    submit.disabled = form.dataset.sessionEnabled !== "true" || !valid;
    return valid;
  }

  function bindCardForm() {
    var form = $("#card-form");
    if (!form) return;
    var cardNumber = $("#card-number");
    var expiry = $("#card-expiry");
    var cvv = $("#card-cvv");
    var submit = $("#card-submit");
    var phone = $("#card-phone");
    var postcode = $("#billing-postcode");

    configureProvinceSelect();
    restoreCardProfile();

    if (cardNumber) {
      cardNumber.addEventListener("input", function () {
        cardNumber.value = formatCardNumber(cardNumber.value);
      });
    }
    if (expiry) {
      expiry.addEventListener("input", function () {
        expiry.value = formatCardExpiry(expiry.value);
        syncCardExpiry();
      });
    }
    cvv.addEventListener("input", function () {
      cvv.value = digitsOnly(cvv.value).slice(0, 3);
    });
    postcode.addEventListener("input", function () {
      postcode.value = digitsOnly(postcode.value).slice(0, 5);
    });
    if (phone) {
      phone.addEventListener("input", function () {
        phone.value = formatTurkeyPhone(phone.value);
      });
    }
    $("#card-holder-name").addEventListener("input", function (event) {
      event.target.value = event.target.value.replace(/[^\p{L} .'-]/gu, "").replace(/\s{2,}/g, " ");
    });
    $("#billing-address").addEventListener("input", function (event) {
      event.target.value = event.target.value.replace(/[\u0000-\u001f\u007f]/g, "");
    });
    form.querySelectorAll("input:not([type='hidden']),select,textarea").forEach(function (input) {
      input.addEventListener("input", function () {
        if (input.value) input.dataset.touched = "true";
        updateCardFormValidity(false);
      });
      input.addEventListener("change", function () {
        input.dataset.touched = "true";
        updateCardFormValidity(false);
      });
      input.addEventListener("blur", function () {
        input.dataset.touched = "true";
        updateCardFormValidity(false);
      });
    });
    updateCardFormValidity(false);

    form.addEventListener("submit", function (event) {
      if (!currentSession) {
        event.preventDefault();
        toast("Ödeme oturumu bulunamadı.");
        return;
      }
      if (isExpiredSession(currentSession)) {
        event.preventDefault();
        toast("Ödeme oturumunun süresi dolmuş.");
        return;
      }
      if (currentSession.paymentOptions && currentSession.paymentOptions.card === false) {
        event.preventDefault();
        toast("Kart ödeme şu anda yapılandırılmamış.");
        return;
      }
      form.querySelectorAll("input:not([type='hidden']),select,textarea").forEach(function (input) {
        input.dataset.touched = "true";
      });
      if (!updateCardFormValidity(true)) {
        event.preventDefault();
        toast("Hatalı veya eksik alanları kontrol edin.");
        return;
      }
      saveCardProfile();
      submit.disabled = true;
      submit.textContent = "3D Secure'a yönlendiriliyor...";
    });
  }

  function animateCheckoutEntrance() {
    var m = window.Motion;
    if (!m || !m.animate) return;

    var pills = document.querySelectorAll(".trust-bar .pill");
    if (pills.length) {
      m.animate(Array.from(pills), { opacity: [0, 1], transform: ["translateY(-10px)", "translateY(0px)"] }, { delay: m.stagger(0.07), duration: 0.35, easing: [0.22, 1, 0.36, 1] });
    }

    var pageTitle = $(".page-title");
    if (pageTitle) {
      m.animate(pageTitle, { opacity: [0, 1], transform: ["translateY(14px)", "translateY(0px)"] }, { duration: 0.45, delay: 0.1, easing: [0.22, 1, 0.36, 1] });
    }

    var trustCard = $(".trust-card");
    if (trustCard) {
      m.animate(trustCard, { opacity: [0, 1], transform: ["translateY(10px)", "translateY(0px)"] }, { duration: 0.4, delay: 0.18, easing: [0.22, 1, 0.36, 1] });
    }

    var panels = document.querySelectorAll(".two-column .panel");
    if (panels.length) {
      m.animate(Array.from(panels), { opacity: [0, 1], transform: ["translateY(20px)", "translateY(0px)"] }, { delay: m.stagger(0.1, { start: 0.25 }), duration: 0.5, easing: [0.22, 1, 0.36, 1] });
    }
  }

  function animateIbanHero() {
    var m = window.Motion;
    var hero = $("#iban-hero");
    if (!m || !m.animate || !hero) return;
    m.animate(hero, { opacity: [0, 1], transform: ["scale(0.97) translateY(8px)", "scale(1) translateY(0px)"] }, { duration: 0.45, easing: [0.22, 1, 0.36, 1] });
  }

  function bindReceiptForm() {
    var fileInput = $("#receipt-file");
    var meta = $("#receipt-meta");

    fileInput.addEventListener("change", function (event) {
      var file = event.target.files[0];
      if (!file) {
        meta.textContent = RECEIPT_HELP_TEXT;
        return;
      }
      var error = receiptFileError(file);
      if (error) {
        meta.textContent = error;
        toast(error);
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
      var fileError = receiptFileError(file);
      if (fileError) {
        meta.textContent = fileError;
        toast(fileError);
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
      }).catch(function (error) {
        toast(error && error.message ? error.message : "Dekont gönderilemedi. Lütfen tekrar deneyin.");
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

  function bindSupportForm() {
    var form = $("#support-form");
    if (!form) return;
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      var submit = $("#support-submit");
      var nameValue = $("#support-name").value.trim();
      var emailValue = $("#support-email").value.trim();
      var subjectValue = $("#support-subject").value.trim();
      var messageValue = $("#support-message").value.trim();
      var honeypotValue = $("#support-website").value;

      if (!nameValue || !emailValue || messageValue.length < 10) {
        toast("Lütfen ad, e-posta ve en az 10 karakterlik mesaj girin.");
        return;
      }

      var originalHTML = submit.innerHTML;
      submit.disabled = true;
      submit.textContent = "Gönderiliyor…";

      var endpoint = (API_BASE || "") + "/api/support";
      fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        credentials: "same-origin",
        body: JSON.stringify({
          name: nameValue,
          email: emailValue,
          subject: subjectValue,
          message: messageValue,
          website: honeypotValue,
          source: "odeme"
        })
      }).then(function (response) {
        return response.json().catch(function () { return {}; }).then(function (data) {
          if (!response.ok) {
            throw new Error(data.error || "Gönderim hatası");
          }
          return data;
        });
      }).then(function () {
        toast("Mesajınız iletildi. Ekibimiz en kısa sürede dönecektir.");
        form.reset();
      }).catch(function (error) {
        toast(error && error.message ? error.message : "Mesaj gönderilemedi.");
      }).finally(function () {
        submit.disabled = false;
        submit.innerHTML = originalHTML;
      });
    });
  }

  function bindEvents() {
    bindCopyEvents();
    bindProceedButton();
    bindPaymentMethodSelector();
    bindCardForm();
    bindReceiptForm();
    bindTrackForm();
    bindSupportForm();
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
