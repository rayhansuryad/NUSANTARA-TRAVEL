(function () {
  "use strict";

  var I18N = window.I18N;
  var t = I18N.t;
  var setLang = I18N.setLang;
  var getLang = I18N.getLang;

  var CONFIG = {
    whatsappNumber: "6281200000000",
    storageKey: "nt-lang",
    /* null  -> no backend configured, so the page stays a labelled local demo
       ""    -> same origin, the booking is posted to /api/bookings
       "https://..." -> the API lives on another origin
       A deployment, or a test, can set window.NT_API_BASE before this script
       runs to choose without editing this file. */
    apiBase: typeof window.NT_API_BASE === "string" ? window.NT_API_BASE : null
  };

  /* Prices come from assets/data/pricing.json, which the server reads too.
     One shared copy is the only way the two cannot drift apart. */
  var PACKAGES = [];
  var ACCOMMODATION = [];
  var ADDONS = [];
  var DEPOSIT_SHARE = 0.3;

  function applyPricing(data) {
    PACKAGES = data.packages;
    ACCOMMODATION = data.accommodation;
    ADDONS = data.addons;
    if (typeof data.depositShare === "number") DEPOSIT_SHARE = data.depositShare;
  }

  function loadPricing() {
    return fetch("assets/data/pricing.json", { cache: "no-cache" })
      .then(function (response) {
        if (!response.ok) throw new Error("HTTP " + response.status);
        return response.json();
      })
      .then(function (data) {
        if (!data || !Array.isArray(data.packages) || !data.packages.length) {
          throw new Error("pricing.json holds no packages");
        }
        if (!Array.isArray(data.accommodation) || !data.accommodation.length) {
          throw new Error("pricing.json holds no accommodation tiers");
        }
        applyPricing(data);
      });
  }

  function apiEnabled() {
    return typeof CONFIG.apiBase === "string";
  }

  function apiUrl(path) {
    return (CONFIG.apiBase || "") + path;
  }

  function $(selector, root) {
    return (root || document).querySelector(selector);
  }

  function $$(selector, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(selector));
  }

  function money(value) {
    return "Rp " + Math.round(value).toLocaleString("id-ID");
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function findPackage(id) {
    for (var i = 0; i < PACKAGES.length; i += 1) {
      if (PACKAGES[i].id === id) return PACKAGES[i];
    }
    return PACKAGES.length ? PACKAGES[0] : null;
  }

  function todayISO() {
    var now = new Date();
    var local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 10);
  }

  /* Language */

  function detectLanguage() {
    var params = new URLSearchParams(window.location.search);
    var fromUrl = params.get("lang");
    if (fromUrl === "en" || fromUrl === "id") return fromUrl;
    try {
      var saved = window.localStorage.getItem(CONFIG.storageKey);
      if (saved === "en" || saved === "id") return saved;
    } catch (error) {
      /* Storage can be blocked in private modes. */
    }
    var browser = (navigator.language || "id").toLowerCase();
    return browser.indexOf("en") === 0 ? "en" : "id";
  }

  function applyTranslations() {
    $$("[data-i18n]").forEach(function (el) {
      el.textContent = t(el.getAttribute("data-i18n"));
    });
    $$("[data-i18n-placeholder]").forEach(function (el) {
      el.placeholder = t(el.getAttribute("data-i18n-placeholder"));
    });
    $$("[data-i18n-aria]").forEach(function (el) {
      el.setAttribute("aria-label", t(el.getAttribute("data-i18n-aria")));
    });
    $$("[data-i18n-alt]").forEach(function (el) {
      el.alt = t(el.getAttribute("data-i18n-alt"));
    });
    $$("[data-i18n-title]").forEach(function (el) {
      el.title = t(el.getAttribute("data-i18n-title"));
    });

    document.title = t("meta.title");
    var description = $('meta[name="description"]');
    if (description) description.setAttribute("content", t("meta.description"));
    document.documentElement.lang = getLang();

    updateWhatsAppLinks();
    updateGalleryLabels();
    updateModeCopy();
  }

  /* The page must never imply it takes real payments when it cannot. */
  function updateModeCopy() {
    var disclaimer = $("#booking-disclaimer");
    if (disclaimer) {
      disclaimer.textContent = apiEnabled() ? t("booking.disclaimerLive") : t("booking.disclaimer");
    }
    var note = $("#success-note");
    if (note) {
      note.textContent = apiEnabled() ? t("booking.successNoteLive") : t("booking.successNote");
    }
  }

  function setLanguage(lang, updateUrl) {
    var next = lang === "en" ? "en" : "id";
    setLang(next);
    applyTranslations();
    renderPackageOptions();
    syncPackagePrices();
    updateCalculator();
    updateBookingSummary();
    updateNavToggleLabel();

    $$(".lang-switch button").forEach(function (button) {
      button.setAttribute("aria-pressed", String(button.getAttribute("data-lang") === next));
    });

    try {
      window.localStorage.setItem(CONFIG.storageKey, next);
    } catch (error) {
      /* Preference simply will not persist. */
    }

    if (updateUrl) {
      try {
        var url = new URL(window.location.href);
        if (next === "en") {
          url.searchParams.set("lang", "en");
        } else {
          url.searchParams.delete("lang");
        }
        window.history.replaceState(null, "", url.toString());
      } catch (error) {
        /* file:// URLs can reject history updates. */
      }
    }

    if (!$("#lightbox").hidden) {
      renderLightbox();
    }

    if (lastBooking && !$("#booking-success").hidden) {
      renderSuccess(lastBooking);
      renderPayment(lastBooking.payment);
    }
  }

  function updateWhatsAppLinks() {
    var href = "https://wa.me/" + CONFIG.whatsappNumber + "?text=" + encodeURIComponent(t("wa.message"));
    var float = $("#wa-float");
    var footer = $("#footer-wa");
    if (float) {
      float.href = href;
      float.setAttribute("aria-label", t("wa.aria"));
    }
    if (footer) footer.href = href;
  }

  function renderPackageOptions() {
    if (!PACKAGES.length) return;
    ["#calc-destination", "#book-package"].forEach(function (selector) {
      var select = $(selector);
      if (!select) return;
      var previous = select.value;
      select.innerHTML = "";
      PACKAGES.forEach(function (pkg) {
        var option = document.createElement("option");
        option.value = pkg.id;
        option.textContent = t("pkg." + pkg.id + ".name");
        select.appendChild(option);
      });
      if (previous) select.value = previous;
    });
  }

  /*
   * The package cards carry the price as static markup so they render without
   * JavaScript, which leaves one hand-maintained copy of a number that also
   * lives in pricing.json. Rewriting them from the shared table means the two
   * cannot stay wrong for long, and no-JS visitors still see a price.
   */
  function syncPackagePrices() {
    $$("[data-price-for]").forEach(function (el) {
      var pkg = findPackage(el.getAttribute("data-price-for"));
      if (pkg) el.textContent = money(pkg.price);
    });
  }

  /* Calculator */

  function checkedValue(name) {
    var input = $('input[name="' + name + '"]:checked');
    return input ? input.value : "";
  }

  /* Payment labels are derived from the stored value, never from a snapshot of
     the text, so they follow the active language wherever they are shown. */

  function paymentTypeLabel(value) {
    return t(value === "dp" ? "booking.payDp" : "booking.payFull");
  }

  function paymentMethodLabel(value) {
    return t("pay." + (value || "va"));
  }

  /* The amount actually charged up front. The server repeats this calculation
     from the same depositShare in pricing.json. */
  function computePayNow(total, paymentType) {
    return paymentType === "dp" ? total * DEPOSIT_SHARE : total;
  }

  function getCheckedAddons() {
    return $$('input[name="addons"]:checked').map(function (input) {
      return input.value;
    });
  }

  function getAccommodation() {
    var id = checkedValue("accommodation") || "star3";
    for (var i = 0; i < ACCOMMODATION.length; i += 1) {
      if (ACCOMMODATION[i].id === id) return ACCOMMODATION[i];
    }
    return ACCOMMODATION.length ? ACCOMMODATION[Math.min(1, ACCOMMODATION.length - 1)] : null;
  }

  function getCalcState() {
    var participants = parseInt($("#calc-participants").value, 10);
    return {
      pkg: findPackage($("#calc-destination").value),
      participants: Number.isFinite(participants) ? participants : 0,
      acc: getAccommodation(),
      addons: ADDONS.filter(function (addon) {
        return getCheckedAddons().indexOf(addon.id) !== -1;
      })
    };
  }

  function computeEstimate(state) {
    var valid = state.participants >= 1 && state.participants <= 30;
    if (!valid || !state.pkg || !state.acc) {
      return { valid: false };
    }

    var basePerPerson = state.pkg.price * state.acc.multiplier;
    var baseTotal = basePerPerson * state.participants;
    var addonPerPerson = 0;
    var addonOnce = 0;

    state.addons.forEach(function (addon) {
      if (addon.per === "person") {
        addonPerPerson += addon.price;
      } else {
        addonOnce += addon.price;
      }
    });

    var total = baseTotal + addonPerPerson * state.participants + addonOnce;

    return {
      valid: true,
      basePerPerson: basePerPerson,
      baseTotal: baseTotal,
      addonPerPerson: addonPerPerson,
      addonOnce: addonOnce,
      addonTotal: addonPerPerson * state.participants + addonOnce,
      total: total,
      perPerson: total / state.participants
    };
  }

  function renderRows(target, rows) {
    target.innerHTML = "";
    rows.forEach(function (row) {
      var wrapper = document.createElement("div");
      wrapper.className = "calc-row";
      var term = document.createElement("dt");
      term.textContent = row[0];
      var detail = document.createElement("dd");
      detail.textContent = row[1];
      wrapper.appendChild(term);
      wrapper.appendChild(detail);
      target.appendChild(wrapper);
    });
  }

  function updateCalculator() {
    var state = getCalcState();
    var result = computeEstimate(state);
    var breakdown = $("#calc-breakdown");
    var empty = $("#calc-empty");
    var totalValue = $("#calc-total-value");
    var perPerson = $("#calc-per-person");
    var error = $("#calc-error");
    var participantsInput = $("#calc-participants");
    var bookButton = $("#calc-book");

    $("#calc-minus").disabled = state.participants <= 1;
    $("#calc-plus").disabled = state.participants >= 30;

    if (!result.valid) {
      empty.hidden = false;
      breakdown.hidden = true;
      breakdown.innerHTML = "";
      totalValue.textContent = money(0);
      perPerson.textContent = "";
      bookButton.disabled = true;
      error.textContent = t("calc.participantsError");
      error.hidden = false;
      participantsInput.setAttribute("aria-invalid", "true");
      syncGeneratedNote();
      return;
    }

    empty.hidden = true;
    breakdown.hidden = false;
    totalValue.textContent = money(result.total);
    perPerson.textContent = t("calc.perPerson", { amount: money(result.perPerson) });
    bookButton.disabled = false;
    error.hidden = true;
    participantsInput.removeAttribute("aria-invalid");

    var rows = [
      [t("calc.row.package"), t("pkg." + state.pkg.id + ".name")],
      [t("calc.row.accommodation"), t("calc.acc." + state.acc.id)],
      [t("calc.row.participants"), state.participants + " x " + money(result.basePerPerson)]
    ];

    if (state.addons.length) {
      rows.push([
        t("calc.row.addons"),
        state.addons.map(function (addon) {
          return t("calc.addon." + addon.id);
        }).join(", ") + " (" + money(result.addonTotal) + ")"
      ]);
    }

    renderRows(breakdown, rows);
    syncGeneratedNote();
    updateBookingSummary();
  }

  function stepParticipants(delta) {
    var input = $("#calc-participants");
    var value = parseInt(input.value, 10);
    if (!Number.isFinite(value)) value = 1;
    input.value = String(clamp(value + delta, 1, 30));
    updateCalculator();
  }

  function buildEstimateNote() {
    var state = getCalcState();
    var result = computeEstimate(state);
    if (!result.valid) return "";

    var addonNames = state.addons.length
      ? state.addons.map(function (addon) { return t("calc.addon." + addon.id); }).join(", ")
      : t("calc.none");

    return t("calc.note", {
      package: t("pkg." + state.pkg.id + ".name"),
      n: state.participants,
      acc: t("calc.acc." + state.acc.id),
      addons: addonNames,
      total: money(result.total)
    });
  }

  function syncGeneratedNote() {
    var notes = $("#book-notes");
    if (!notes) return;
    if (notes.getAttribute("data-generated") === "true") {
      notes.value = buildEstimateNote();
    }
  }

  function buildCalcSummaryText() {
    var state = getCalcState();
    var result = computeEstimate(state);
    if (!result.valid) return "";

    var lines = [
      "Nusantara Travel",
      t("calc.row.package") + ": " + t("pkg." + state.pkg.id + ".name"),
      t("calc.row.accommodation") + ": " + t("calc.acc." + state.acc.id),
      t("calc.row.participants") + ": " + state.participants,
      t("calc.row.addons") + ": " + (state.addons.length
        ? state.addons.map(function (addon) { return t("calc.addon." + addon.id); }).join(", ")
        : t("calc.none")),
      t("calc.total") + ": " + money(result.total),
      t("calc.perPerson", { amount: money(result.perPerson) }),
      t("calc.disclaimer")
    ];

    return lines.join("\n");
  }

  function setCalcStatus(message) {
    $("#calc-status").textContent = message;
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(function () {
        return true;
      }).catch(function () {
        return copyWithFallback(text);
      });
    }
    return Promise.resolve(copyWithFallback(text));
  }

  function copyWithFallback(text) {
    try {
      var area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.top = "-1000px";
      document.body.appendChild(area);
      area.select();
      var ok = document.execCommand("copy");
      document.body.removeChild(area);
      return ok;
    } catch (error) {
      return false;
    }
  }

  /* Booking */

  function getBookingTrip() {
    var pkg = findPackage($("#book-package").value);
    var participants = parseInt($("#book-participants").value, 10);
    var n = Number.isFinite(participants) ? participants : 0;
    var acc = getAccommodation();
    var addons = ADDONS.filter(function (addon) {
      return getCheckedAddons().indexOf(addon.id) !== -1;
    });

    return {
      pkg: pkg,
      n: n,
      acc: acc,
      addons: addons,
      result: computeEstimate({ pkg: pkg, participants: n, acc: acc, addons: addons })
    };
  }

  function updateBookingSummary() {
    var packageCell = $("#book-sum-package");
    if (!packageCell) return;

    var trip = getBookingTrip();
    var total = trip.result.valid ? trip.result.total : 0;
    var paymentType = checkedValue("paymentType") || "full";
    var payNow = computePayNow(total, paymentType);

    packageCell.textContent = t("pkg." + trip.pkg.id + ".name");
    $("#book-sum-accommodation").textContent = t("calc.acc." + trip.acc.id);
    $("#book-sum-participants").textContent = String(trip.n);
    $("#book-sum-addons").textContent = trip.addons.length
      ? trip.addons.map(function (addon) { return t("calc.addon." + addon.id); }).join(", ")
      : t("calc.none");

    $("#book-sum-method").textContent = paymentMethodLabel(checkedValue("method"));

    $("#book-sum-total").textContent = money(total);
    $("#book-sum-paynow").textContent = money(payNow);
    $("#book-sum-remaining").textContent = money(total - payNow);
  }

  var ERROR_FIELDS = {
    name: { input: "#book-name", error: "#err-name" },
    email: { input: "#book-email", error: "#err-email" },
    phone: { input: "#book-phone", error: "#err-phone" },
    package: { input: "#book-package", error: "#err-package" },
    date: { input: "#book-date", error: "#err-date" },
    participants: { input: "#book-participants", error: "#err-participants" },
    method: { input: 'input[name="method"]', error: "#err-method" }
  };

  function clearFieldError(key) {
    var config = ERROR_FIELDS[key];
    if (!config) return;
    var error = $(config.error);
    if (error) {
      error.hidden = true;
      error.textContent = "";
    }
    $$(config.input).forEach(function (input) {
      input.removeAttribute("aria-invalid");
    });
  }

  function clearAllErrors() {
    Object.keys(ERROR_FIELDS).forEach(clearFieldError);
  }

  function validateBooking() {
    var errors = {};

    if ($("#book-name").value.trim().length < 2) errors.name = t("err.name");
    if (!$("#book-email").value.trim().match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)) errors.email = t("err.email");

    var digits = $("#book-phone").value.replace(/\D/g, "");
    if (digits.length < 9 || digits.length > 15) errors.phone = t("err.phone");

    if (!$("#book-package").value) errors.package = t("err.package");

    var date = $("#book-date").value;
    if (!date) {
      errors.date = t("err.date");
    } else {
      var picked = new Date(date + "T00:00:00");
      var today = new Date();
      today.setHours(0, 0, 0, 0);
      if (isNaN(picked.getTime()) || picked < today) errors.date = t("err.date");
    }

    var participants = parseInt($("#book-participants").value, 10);
    if (!Number.isFinite(participants) || participants < 1 || participants > 30) {
      errors.participants = t("err.participants");
    }

    if (!$('input[name="method"]:checked')) errors.method = t("err.method");

    return errors;
  }

  function showErrors(errors) {
    clearAllErrors();
    var keys = Object.keys(errors);
    keys.forEach(function (key) {
      var config = ERROR_FIELDS[key];
      if (!config) return;
      var error = $(config.error);
      if (error) {
        error.textContent = errors[key];
        error.hidden = false;
      }
      $$(config.input).forEach(function (input) {
        input.setAttribute("aria-invalid", "true");
      });
    });
    if (keys.length) {
      var first = $(ERROR_FIELDS[keys[0]].input);
      if (first) first.focus();
    }
  }

  var lastBooking = null;
  var idempotencyKey = null;
  var statusTimer = null;
  var statusPollsLeft = 0;
  /* One countdown per panel: the deposit and the balance each carry a deadline. */
  var countdowns = { primary: null, balance: null };

  function bookingCode() {
    var stamp = String(Date.now()).slice(-6);
    return "NT-" + stamp;
  }

  /* Sent with every attempt so a double click or a retried request cannot
     create two bookings and two Virtual Accounts. */
  function newIdempotencyKey() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    return "k" + Date.now() + Math.random().toString(16).slice(2);
  }

  function statusLabel(status) {
    if (status === "demo") return t("booking.successStatusValue");
    return t("status." + status);
  }

  function setResultStatus(status) {
    var chip = $("#success-status");
    chip.textContent = statusLabel(status);
    chip.className = "status-chip status-chip--" + status;
    if (lastBooking) lastBooking.status = status;
  }

  function stopStatusPolling() {
    if (statusTimer) {
      window.clearInterval(statusTimer);
      statusTimer = null;
    }
    statusPollsLeft = 0;
  }

  function stopExpiryCountdown(key) {
    if (countdowns[key]) {
      window.clearInterval(countdowns[key]);
      countdowns[key] = null;
    }
  }

  function stopAllCountdowns() {
    stopExpiryCountdown("primary");
    stopExpiryCountdown("balance");
  }

  /* Both timers must die with the panel, otherwise a poll can settle a booking
     after the form is back on screen. */
  function stopResultTimers() {
    stopStatusPolling();
    stopAllCountdowns();
  }

  function formatDuration(ms) {
    var total = Math.max(0, Math.round(ms / 60000));
    var hours = Math.floor(total / 60);
    var minutes = total % 60;
    if (hours <= 0) return minutes + " " + t("pay.unitMinute");
    if (minutes === 0) return hours + " " + t("pay.unitHour");
    return hours + " " + t("pay.unitHour") + " " + minutes + " " + t("pay.unitMinute");
  }

  /* Grouped in fours for reading, but the raw value is what gets copied. */
  function formatVaNumber(value) {
    var raw = String(value || "").replace(/\s+/g, "");
    return raw.replace(/(.{4})/g, "$1 ").trim();
  }

  function renderSuccess(booking) {
    $("#success-code").textContent = booking.code;
    $("#success-package").textContent = t("pkg." + booking.pkg.id + ".name");
    $("#success-participants").textContent = String(booking.n);
    $("#success-total").textContent = money(booking.total);
    $("#success-payment-type").textContent = paymentTypeLabel(booking.paymentType);
    $("#success-paynow").textContent = money(booking.payNow);
    $("#success-method").textContent = paymentMethodLabel(booking.method);
    setResultStatus(booking.status || "pending");
    renderBalance(booking);
  }

  /*
   * The deposit and the balance are the same thing twice: an amount, either an
   * account number or a QR code, and a deadline. One renderer driven by a
   * descriptor keeps the pair from drifting apart, and keeps the "clear rather
   * than hide" rule in a single place.
   */
  var PAY_SLOTS = {
    key: "primary",
    panel: "#pay-panel",
    amount: "#pay-amount",
    va: "#pay-va",
    number: "#pay-va-number",
    bank: "#pay-va-bank",
    qr: "#pay-qr",
    image: "#pay-qr-image",
    expiry: "#pay-expiry"
  };

  var BALANCE_SLOTS = {
    key: "balance",
    panel: "#balance-panel",
    amount: "#balance-amount",
    va: "#balance-va",
    number: "#balance-va-number",
    bank: "#balance-va-bank",
    qr: "#balance-qr",
    image: "#balance-qr-image",
    expiry: "#balance-expiry"
  };

  function startCountdown(slots, expiresAt, onExpired) {
    var label = $(slots.expiry);
    var target = expiresAt ? new Date(expiresAt).getTime() : NaN;

    stopExpiryCountdown(slots.key);

    if (!label) return;
    if (!Number.isFinite(target)) {
      label.textContent = "";
      return;
    }

    function tick() {
      var left = target - Date.now();
      if (left <= 0) {
        label.textContent = t("pay.expired");
        stopExpiryCountdown(slots.key);
        if (onExpired) onExpired();
        return;
      }
      label.textContent = t("pay.expiresIn", { time: formatDuration(left) });
    }

    tick();
    /* The label only carries minutes, so a half-minute refresh is invisible
       while still catching the expiry edge. */
    countdowns[slots.key] = window.setInterval(tick, 30000);
  }

  function renderInstructions(slots, payment, onExpired) {
    var panel = $(slots.panel);
    if (!panel) return;
    var va = $(slots.va);
    var qr = $(slots.qr);
    var image = $(slots.image);
    var cell = $(slots.number);

    stopExpiryCountdown(slots.key);

    if (!payment) {
      panel.hidden = true;
      va.hidden = true;
      qr.hidden = true;
      /* Clear rather than hide: a stale account number left in the DOM is one
         stray line of code away from being shown or copied. */
      $(slots.amount).textContent = "";
      $(slots.bank).textContent = "";
      $(slots.expiry).textContent = "";
      if (image) image.removeAttribute("src");
      if (cell) {
        cell.textContent = "";
        cell.removeAttribute("data-raw");
      }
      return;
    }

    panel.hidden = false;
    $(slots.amount).textContent = money(payment.amount);

    if (payment.type === "qris") {
      va.hidden = true;
      qr.hidden = false;
      if (image.getAttribute("src") !== payment.qrUrl) image.setAttribute("src", payment.qrUrl);
      image.alt = t("pay.qrAlt");
    } else {
      qr.hidden = true;
      va.hidden = false;
      cell.textContent = formatVaNumber(payment.vaNumber);
      cell.setAttribute("data-raw", payment.vaNumber);
      $(slots.bank).textContent = payment.bank
        ? t("pay.bankNotice", { bank: payment.bank.toUpperCase() })
        : "";
    }

    startCountdown(slots, payment.expiresAt, onExpired);
  }

  function renderPayment(payment) {
    renderInstructions(PAY_SLOTS, payment, function () {
      if (lastBooking && lastBooking.status === "pending") setResultStatus("expired");
    });
  }

  function setBalanceStatus(status) {
    var chip = $("#balance-status");
    if (!chip) return;
    if (!status) {
      chip.hidden = true;
      chip.textContent = "";
      return;
    }
    chip.hidden = false;
    chip.textContent = statusLabel(status);
    chip.className = "status-chip status-chip--" + status;
  }

  /* Shown only once the balance has actually been raised, which happens server
     side inside the lead window and only after the deposit is paid. */
  function renderBalance(booking) {
    var balance = booking && booking.balance ? booking.balance : null;
    var note = $("#balance-note");

    renderInstructions(
      BALANCE_SLOTS,
      balance
        ? {
            type: balance.type === "qris" ? "qris" : "va",
            amount: balance.amount,
            vaNumber: balance.vaNumber || "",
            bank: balance.bank || "",
            qrUrl: balance.qrUrl || "",
            expiresAt: balance.expiresAt || ""
          }
        : null,
      function () {
        setBalanceStatus("expired");
        if (lastBooking && lastBooking.balance) lastBooking.balance.status = "expired";
      }
    );

    if (note) {
      note.textContent =
        balance && booking.date ? t("balance.note", { date: booking.date }) : "";
    }

    setBalanceStatus(balance ? balance.status : null);
  }

  function checkStatus() {
    if (!lastBooking || !apiEnabled()) return Promise.resolve();
    var code = lastBooking.code;

    /* The code travels as a query parameter, not a path segment, so the route
       is a plain file on every host rather than a framework dynamic route. */
    var url = apiUrl("/api/bookings/status?code=" + encodeURIComponent(code));

    return fetch(url, { cache: "no-store" })
      .then(function (response) {
        if (!response.ok) throw new Error("HTTP " + response.status);
        return response.json();
      })
      .then(function (data) {
        if (!lastBooking || lastBooking.code !== code || !data || !data.status) return;
        setResultStatus(data.status);
        /* The balance is raised server side, so the poll is how the page finds
           out about it without a reload. */
        if (data.balance) lastBooking.balance = data.balance;
        renderBalance(lastBooking);
        /* Keep polling while either window is still open. */
        var waiting =
          data.status === "pending" ||
          Boolean(data.balance && data.balance.status === "pending");
        if (!waiting) stopStatusPolling();
      })
      .catch(function () {
        /* A failed status read is not worth an error banner. The booking still
           exists and the countdown keeps running. */
      });
  }

  function startStatusPolling() {
    stopStatusPolling();
    if (!apiEnabled()) return;
    statusPollsLeft = 20; /* 20 polls at 15s covers the first five minutes. */
    statusTimer = window.setInterval(function () {
      if (statusPollsLeft <= 0) {
        stopStatusPolling();
        return;
      }
      statusPollsLeft -= 1;
      checkStatus();
    }, 15000);
  }

  function showResult(booking) {
    lastBooking = booking;
    renderSuccess(booking);
    renderPayment(booking.payment);
    $("#success-copy-status").textContent = "";

    stopStatusPolling();
    var waiting =
      booking.status === "pending" ||
      Boolean(booking.balance && booking.balance.status === "pending");
    if (apiEnabled() && waiting) startStatusPolling();

    $("#booking-form").hidden = true;
    var panel = $("#booking-success");
    panel.hidden = false;
    panel.focus();
  }

  /* --- building the booking record --- */

  function demoBooking() {
    var trip = getBookingTrip();
    var total = trip.result.valid ? trip.result.total : 0;
    var paymentType = checkedValue("paymentType") || "full";
    var payNow = computePayNow(total, paymentType);

    return {
      code: bookingCode(),
      name: $("#book-name").value.trim(),
      email: $("#book-email").value.trim(),
      phone: $("#book-phone").value.trim(),
      date: $("#book-date").value,
      pkg: trip.pkg,
      n: trip.n,
      acc: trip.acc,
      addons: trip.addons,
      total: total,
      payNow: payNow,
      remaining: total - payNow,
      paymentType: paymentType,
      method: checkedValue("method") || "va",
      payment: null,
      status: "demo"
    };
  }

  /* The server owns the amounts, so trust its numbers over anything local. */
  function liveBooking(body, payload) {
    var trip = getBookingTrip();
    var localTotal = trip.result.valid ? trip.result.total : 0;
    var total = typeof body.total === "number" ? body.total : localTotal;
    var payNow = typeof body.payNow === "number" ? body.payNow : computePayNow(total, payload.paymentType);
    var payment = body.payment || {};

    return {
      code: body.code,
      name: payload.name,
      email: payload.email,
      phone: payload.phone,
      date: payload.date,
      pkg: trip.pkg,
      n: trip.n,
      acc: trip.acc,
      addons: trip.addons,
      total: total,
      payNow: payNow,
      remaining: total - payNow,
      paymentType: payload.paymentType,
      method: payload.method,
      payment: {
        type: payment.type === "qris" ? "qris" : "va",
        amount: payNow,
        vaNumber: payment.vaNumber || "",
        bank: payment.bank || "",
        qrUrl: payment.qrUrl || "",
        /* The deadline sits at the top level of the response, not inside the
           payment object. Reading it from the wrong place left the countdown
           silently blank. */
        expiresAt: body.expiresAt || ""
      },
      /* Absent until the server raises it, which is why it is carried through
         as-is rather than reconstructed locally. */
      balance: body.balance || null,
      status: body.status || "pending"
    };
  }

  function buildBookingPayload() {
    var trip = getBookingTrip();
    var total = trip.result.valid ? trip.result.total : 0;
    var paymentType = checkedValue("paymentType") || "full";

    return {
      packageId: trip.pkg.id,
      date: $("#book-date").value,
      participants: trip.n,
      accommodationId: trip.acc.id,
      addonIds: trip.addons.map(function (addon) { return addon.id; }),
      paymentType: paymentType,
      method: checkedValue("method") || "va",
      name: $("#book-name").value.trim(),
      email: $("#book-email").value.trim(),
      phone: $("#book-phone").value.trim(),
      notes: $("#book-notes").value.trim(),
      /* Sent so the server can refuse a booking priced with a stale table
         instead of quietly charging a different number. */
      expectedTotal: total,
      expectedPayNow: computePayNow(total, paymentType),
      idempotencyKey: idempotencyKey
    };
  }

  /* --- submit --- */

  function setSubmitting(busy) {
    var submit = $("#booking-submit");
    var label = submit.querySelector(".btn-text");
    submit.disabled = busy;
    if (busy) {
      submit.setAttribute("aria-busy", "true");
      label.textContent = t("booking.processing");
    } else {
      submit.removeAttribute("aria-busy");
      label.textContent = t("booking.submit");
    }
  }

  function showSubmitError(message) {
    var box = $("#booking-error");
    if (!box) return;
    box.textContent = message;
    box.hidden = false;
  }

  function hideSubmitError() {
    var box = $("#booking-error");
    if (!box) return;
    box.hidden = true;
    box.textContent = "";
  }

  function submitErrorMessage(error) {
    if (error && error.code === "pricing_changed") return t("err.pricingChanged");
    if (error && error.code === "in_progress") return t("err.inProgress");
    if (error && error.code === "rate_limited") return t("err.rateLimited");
    if (error && error.code === "invalid") return t("err.rejected");
    if (error && error.status >= 500) return t("err.server");
    return t("err.network");
  }

  function handleSubmit(event) {
    event.preventDefault();

    var errors = validateBooking();
    if (Object.keys(errors).length) {
      showErrors(errors);
      return;
    }

    clearAllErrors();
    hideSubmitError();
    setSubmitting(true);

    if (!apiEnabled()) {
      /* No backend configured: nothing leaves the browser. */
      window.setTimeout(function () {
        setSubmitting(false);
        showResult(demoBooking());
      }, 900);
      return;
    }

    var payload = buildBookingPayload();
    if (!idempotencyKey) idempotencyKey = newIdempotencyKey();
    payload.idempotencyKey = idempotencyKey;

    fetch(apiUrl("/api/bookings"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    })
      .then(function (response) {
        return response.json()
          .catch(function () { return {}; })
          .then(function (body) {
            if (response.ok) return body;
            var error = new Error((body && body.message) || ("HTTP " + response.status));
            error.status = response.status;
            error.code = body && body.error;
            throw error;
          });
      })
      .then(function (body) {
        setSubmitting(false);
        idempotencyKey = null;
        showResult(liveBooking(body, payload));
      })
      .catch(function (error) {
        setSubmitting(false);
        showSubmitError(submitErrorMessage(error));
      });
  }

  function resetBooking() {
    var form = $("#booking-form");
    form.reset();
    $("#book-participants").value = "2";
    $("#book-date").min = todayISO();
    clearAllErrors();
    hideSubmitError();
    stopResultTimers();
    lastBooking = null;
    idempotencyKey = null;
    renderPayment(null);
    renderBalance(null);
    $("#booking-form").hidden = false;
    $("#booking-success").hidden = true;
    $("#success-copy-status").textContent = "";
    $("#book-notes").removeAttribute("data-generated");
    updateCalculator();
    updateBookingSummary();
    $("#book-name").focus();
  }

  function buildBookingText(booking) {
    var lines = [
      "Nusantara Travel",
      t("booking.successCode") + ": " + booking.code,
      t("booking.name") + ": " + booking.name,
      t("booking.email") + ": " + booking.email,
      t("booking.phone") + ": " + booking.phone,
      t("booking.package") + ": " + t("pkg." + booking.pkg.id + ".name"),
      t("booking.date") + ": " + booking.date,
      t("booking.participants") + ": " + booking.n,
      t("calc.row.accommodation") + ": " + t("calc.acc." + booking.acc.id),
      t("calc.row.addons") + ": " + (booking.addons.length
        ? booking.addons.map(function (addon) { return t("calc.addon." + addon.id); }).join(", ")
        : t("calc.none")),
      t("booking.total") + ": " + money(booking.total),
      t("booking.paymentChoice") + ": " + paymentTypeLabel(booking.paymentType),
      t("booking.payNow") + ": " + money(booking.payNow),
      t("booking.remaining") + ": " + money(booking.remaining),
      t("booking.method") + ": " + paymentMethodLabel(booking.method)
    ];

    if (booking.payment && booking.payment.vaNumber) {
      lines.push(t("pay.vaLabel") + ": " + booking.payment.vaNumber);
    }

    /* The balance is only mentioned once the server has actually raised it. */
    if (booking.balance) {
      lines.push("");
      lines.push(t("balance.heading") + ": " + money(booking.balance.amount));
      lines.push(t("balance.statusRow") + ": " + statusLabel(booking.balance.status));
      if (booking.balance.vaNumber) {
        lines.push(t("pay.vaLabel") + ": " + booking.balance.vaNumber);
      }
      if (booking.balance.expiresAt) {
        lines.push(t("balance.expiryRow") + ": " + booking.balance.expiresAt);
      }
    }

    lines.push(t("booking.successStatus") + ": " + statusLabel(booking.status || "pending"));

    return lines.join("\n");
  }

  /* Gallery */

  var galleryButtons = $$(".gallery-btn");
  var galleryIndex = 0;
  var lastFocused = null;

  function updateGalleryLabels() {
    galleryButtons.forEach(function (button) {
      var caption = t(button.getAttribute("data-caption-key"));
      button.setAttribute("aria-label", t("gallery.open") + ": " + caption);
    });
  }

  function renderLightbox() {
    var button = galleryButtons[galleryIndex];
    if (!button) return;
    var caption = t(button.getAttribute("data-caption-key"));
    var image = $("#lightbox-img");
    image.src = button.getAttribute("data-full");
    image.alt = caption;
    $("#lightbox-caption").textContent = caption;
  }

  function openLightbox(index) {
    galleryIndex = index;
    lastFocused = document.activeElement;
    renderLightbox();
    $("#lightbox").hidden = false;
    document.body.classList.add("no-scroll");
    $("#lightbox-close").focus();
  }

  function closeLightbox() {
    $("#lightbox").hidden = true;
    document.body.classList.remove("no-scroll");
    if (lastFocused && typeof lastFocused.focus === "function") lastFocused.focus();
  }

  function stepGallery(delta) {
    if (!galleryButtons.length) return;
    galleryIndex = (galleryIndex + delta + galleryButtons.length) % galleryButtons.length;
    renderLightbox();
  }

  /* Navigation */

  var navToggle = $("#nav-toggle");
  var mobileNav = $("#mobile-nav");
  var header = $("#site-header");

  function updateNavToggleLabel() {
    if (!navToggle) return;
    var open = navToggle.getAttribute("aria-expanded") === "true";
    navToggle.setAttribute("aria-label", open ? t("nav.close") : t("nav.menu"));
  }

  function setMenu(open) {
    navToggle.setAttribute("aria-expanded", String(open));
    mobileNav.hidden = !open;
    header.classList.toggle("menu-open", open);
    document.body.classList.toggle("no-scroll", open);
    updateNavToggleLabel();
  }

  /* Wire up */

  function init() {
    $("#year").textContent = String(new Date().getFullYear());
    $("#book-date").min = todayISO();

    $$(".lang-switch button").forEach(function (button) {
      button.addEventListener("click", function () {
        setLanguage(button.getAttribute("data-lang"), true);
      });
    });

    $("#calc-destination").addEventListener("change", updateCalculator);
    $("#calc-participants").addEventListener("input", updateCalculator);
    $("#calc-participants").addEventListener("blur", function () {
      var value = parseInt(this.value, 10);
      if (!Number.isFinite(value)) value = 1;
      this.value = String(clamp(value, 1, 30));
      updateCalculator();
    });
    $("#calc-minus").addEventListener("click", function () { stepParticipants(-1); });
    $("#calc-plus").addEventListener("click", function () { stepParticipants(1); });

    $$('input[name="accommodation"]').forEach(function (input) {
      input.addEventListener("change", updateCalculator);
    });
    $$('input[name="addons"]').forEach(function (input) {
      input.addEventListener("change", updateCalculator);
    });

    $("#calc-book").addEventListener("click", function () {
      $("#book-package").value = $("#calc-destination").value;
      $("#book-participants").value = $("#calc-participants").value;
      var note = buildEstimateNote();
      var notes = $("#book-notes");
      if (note) {
        notes.value = note;
        notes.setAttribute("data-generated", "true");
      }
      updateBookingSummary();
      var target = $("#booking");
      var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      target.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
      window.setTimeout(function () {
        $("#book-name").focus({ preventScroll: true });
      }, reduce ? 60 : 520);
    });

    $("#calc-copy").addEventListener("click", function () {
      var text = buildCalcSummaryText();
      if (!text) return;
      copyText(text).then(function (ok) {
        setCalcStatus(ok ? t("calc.copied") : t("calc.copyError"));
      });
    });

    $$(".package-card .btn[data-package]").forEach(function (button) {
      button.addEventListener("click", function () {
        var id = button.getAttribute("data-package");
        var select = $("#calc-destination");
        if (!select || !select.querySelector('option[value="' + id + '"]')) return;
        select.value = id;
        updateCalculator();

        var target = $("#kalkulator");
        var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        target.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
        window.setTimeout(function () {
          $("#calc-participants").focus({ preventScroll: true });
        }, reduce ? 60 : 520);
      });
    });

    $("#book-notes").addEventListener("input", function () {
      this.removeAttribute("data-generated");
    });

    $("#book-package").addEventListener("change", syncBookingToCalculator);
    $("#book-participants").addEventListener("change", syncBookingToCalculator);

    function syncBookingToCalculator() {
      var participants = parseInt($("#book-participants").value, 10);
      var safe = Number.isFinite(participants) ? clamp(participants, 1, 30) : 1;
      $("#calc-destination").value = $("#book-package").value;
      $("#calc-participants").value = String(safe);
      updateCalculator();
    }

    $$('input[name="paymentType"]').forEach(function (input) {
      input.addEventListener("change", updateBookingSummary);
    });
    $$('input[name="method"]').forEach(function (input) {
      input.addEventListener("change", function () {
        clearFieldError("method");
        updateBookingSummary();
      });
    });

    ["name", "email", "phone", "package", "date", "participants"].forEach(function (key) {
      var config = ERROR_FIELDS[key];
      $$(config.input).forEach(function (input) {
        input.addEventListener("input", function () { clearFieldError(key); });
        input.addEventListener("change", function () { clearFieldError(key); });
      });
    });

    $("#booking-form").addEventListener("submit", handleSubmit);

    $("#success-again").addEventListener("click", resetBooking);

    $("#pay-va-copy").addEventListener("click", function () {
      var cell = $("#pay-va-number");
      var raw = cell.getAttribute("data-raw") || cell.textContent;
      copyText(raw).then(function (ok) {
        $("#success-copy-status").textContent = ok
          ? t("pay.vaCopied")
          : t("booking.copySummaryError");
      });
    });

    $("#balance-va-copy").addEventListener("click", function () {
      var cell = $("#balance-va-number");
      var raw = cell.getAttribute("data-raw") || cell.textContent;
      copyText(raw).then(function (ok) {
        $("#success-copy-status").textContent = ok
          ? t("pay.vaCopied")
          : t("booking.copySummaryError");
      });
    });

    $("#pay-check").addEventListener("click", function () {
      var button = $("#pay-check");
      var label = button.querySelector(".btn-text");
      button.disabled = true;
      label.textContent = t("pay.checking");
      checkStatus().then(function () {
        button.disabled = false;
        label.textContent = t("pay.check");
      });
    });

    $("#success-copy").addEventListener("click", function () {
      if (!lastBooking) return;
      copyText(buildBookingText(lastBooking)).then(function (ok) {
        $("#success-copy-status").textContent = ok
          ? t("booking.copySummaryDone")
          : t("booking.copySummaryError");
      });
    });

    galleryButtons.forEach(function (button, index) {
      button.addEventListener("click", function () { openLightbox(index); });
    });
    $("#lightbox-close").addEventListener("click", closeLightbox);
    $("#lightbox-prev").addEventListener("click", function () { stepGallery(-1); });
    $("#lightbox-next").addEventListener("click", function () { stepGallery(1); });
    $("#lightbox").addEventListener("click", function (event) {
      if (event.target === this) closeLightbox();
    });

    $("#lightbox").addEventListener("keydown", function (event) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeLightbox();
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        stepGallery(-1);
        return;
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        stepGallery(1);
        return;
      }
      if (event.key === "Tab") {
        var focusable = [$("#lightbox-close"), $("#lightbox-prev"), $("#lightbox-next")];
        var index = focusable.indexOf(document.activeElement);
        event.preventDefault();
        var next = event.shiftKey
          ? (index - 1 + focusable.length) % focusable.length
          : (index + 1) % focusable.length;
        focusable[next].focus();
      }
    });

    $$(".faq-question").forEach(function (button) {
      button.addEventListener("click", function () {
        var expanded = button.getAttribute("aria-expanded") === "true";
        button.setAttribute("aria-expanded", String(!expanded));
        var panel = document.getElementById(button.getAttribute("aria-controls"));
        if (panel) panel.hidden = expanded;
      });
    });

    navToggle.addEventListener("click", function () {
      setMenu(navToggle.getAttribute("aria-expanded") !== "true");
    });

    $$("#mobile-nav a").forEach(function (link) {
      link.addEventListener("click", function () { setMenu(false); });
    });

    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && navToggle.getAttribute("aria-expanded") === "true") {
        setMenu(false);
        navToggle.focus();
      }
    });

    window.addEventListener("resize", function () {
      if (window.innerWidth > 980 && navToggle.getAttribute("aria-expanded") === "true") {
        setMenu(false);
      }
    });

    var ticking = false;
    window.addEventListener("scroll", function () {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(function () {
        header.classList.toggle("is-scrolled", window.scrollY > 24);
        ticking = false;
      });
    }, { passive: true });
    header.classList.toggle("is-scrolled", window.scrollY > 24);

    setLanguage(detectLanguage(), false);
    updateCalculator();
    updateBookingSummary();
  }

  function bootstrap() {
    loadPricing()
      .then(init)
      .catch(function (error) {
        /* Without prices, every figure on the page would be a guess that the
           server will refuse. Say so instead of pricing anything. */
        if (window.console) window.console.error("Pricing failed to load:", error);
        var note = $("#calc-status");
        if (note) note.textContent = t("calc.pricingError");
        var book = $("#calc-book");
        if (book) book.disabled = true;
        var submit = $("#booking-submit");
        if (submit) submit.disabled = true;
      });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootstrap);
  } else {
    bootstrap();
  }
})();
