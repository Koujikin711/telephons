const PIN_KEY = "telephons_pin";
const ADVANCED_UI_KEY = "telephons_advanced";
let pin = localStorage.getItem(PIN_KEY) || "";
let simpleUi = true;
let serverSimpleUi = true;
let fullRolePages = null;
let products = [];
let warehouses = [];
let cart = [];
let paymentMethod = "cash";
let storeConfig = { currency: { code: "TJS", symbol: "смн", name: "Сомони" }, payment_methods: [], exchange_rates: { TJS: 1 } };
let reportType = "finance";
let authRequired = false;
let currentPage = "dashboard";
let reportScope = "all";
let analyticsScope = "all";
let selectedWarehouseId = null;
let whStockViewTotal = true;
let whViewMode = "stock";
let accCart = [];
let accProducts = [];
let accWarehouseId = null;
let accViewMode = "intake";
let whDevicesCache = [];
let sellUnitTarget = null;

function warehouseKind(whId) {
  const w = warehouses.find((x) => x.id === whId);
  if (!w) return "new";
  if (isAccessoriesWarehouse(w)) return "accessories";
  if ((w.warehouse_type || "").toLowerCase() === "used") return "used";
  if ((w.warehouse_type || "").toLowerCase() === "partnership") return "partnership";
  const n = (w.name || "").toLowerCase();
  if (n.includes("бу") || n.includes("б/у") || n.includes("б у")) return "used";
  if (n.includes("артнер") || n.includes("partner")) return "partnership";
  return "new";
}

function whStockColumns(kind) {
  if (kind === "used") {
    return ["Приход", "Наименование", "Батар.", "IMEI", "Память", "Цвет", "Себест.", "Расходы", "Клиент / коммент.", ""];
  }
  return ["Приход", "Наименование", "Регион", "IMEI", "Память", "Цвет", "Себест.", "Расходы", "Поставщик", ""];
}
let tiGivenProducts = [];
let currentUser = null;
let allowedPages = null;
let imeiPickerResolve = null;
let catalogProducts = [];
let catalogDetailId = null;
let pendingProductImage = null;
let pendingProductImageUrl = null;

const OFFLINE_QUEUE_KEY = "telestore_offline_sales";
const PRODUCTS_CACHE_KEY = "telestore_products_cache";

function offlineQueueCount() {
  try {
    return JSON.parse(localStorage.getItem(OFFLINE_QUEUE_KEY) || "[]").length;
  } catch {
    return 0;
  }
}
function enqueueOfflineSale(payload) {
  const q = JSON.parse(localStorage.getItem(OFFLINE_QUEUE_KEY) || "[]");
  q.push({ payload, queued_at: new Date().toISOString() });
  localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(q));
  updateTopbar();
}

async function flushOfflineQueue() {
  if (!navigator.onLine || !pin) return;
  const q = JSON.parse(localStorage.getItem(OFFLINE_QUEUE_KEY) || "[]");
  if (!q.length) return;
  const remain = [];
  let ok = 0;
  for (const item of q) {
    try {
      await api("/api/sales", { method: "POST", body: JSON.stringify(item.payload) });
      ok++;
    } catch {
      remain.push(item);
    }
  }
  localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(remain));
  if (ok) {
    toast(`Синхронизировано офлайн-продаж: ${ok}`);
    updateTopbar();
    if (currentPage === "pos") {
      await loadProducts();
      loadPosCashRegister();
    }
    if (currentPage === "debtors") loadDebtorsPage();
  }
}

function isNetworkError(err) {
  return !navigator.onLine || err instanceof TypeError
    || /failed|network|fetch/i.test(String(err?.message || ""));
}

const ROLE_LABELS = { owner: "Владелец", warehouse: "Кладовщик", cashier: "Кассир", accessories: "Аксессуары" };

const ADVANCED_PAGES = new Set([
  "dashboard", "products-own", "products-consignment",
  "creditors", "analytics", "users", "sales",
]);

function effectiveSimpleUi() {
  return serverSimpleUi && simpleUi && !localStorage.getItem(ADVANCED_UI_KEY);
}

function syncSimpleBodyClass() {
  document.body.classList.toggle("simple-ui", effectiveSimpleUi());
}

const fmt = (n) => {
  const code = storeConfig.currency?.code || "TJS";
  const digits = code === "TJS" ? 2 : 0;
  try {
    return new Intl.NumberFormat("ru-RU", { style: "currency", currency: code, maximumFractionDigits: digits }).format(n);
  } catch {
    return `${Number(n).toFixed(digits)} ${storeConfig.currency?.symbol || code}`;
  }
};
const fmtCurrency = (n, cur) => {
  const code = (cur?.code || "TJS").toUpperCase();
  const val = Number(n);
  if (Number.isNaN(val)) return "—";
  const num = new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(val);
  if (code === "USD") return `$ ${num}`;
  return `${num} ${cur?.symbol || "смн"}`;
};
const saleFmt = (s, n) => fmtCurrency(n, currency_meta(s?.currency_code));
const currency_meta = (code) => {
  const c = (code || "TJS").toUpperCase();
  return c === "USD"
    ? { code: "USD", symbol: "$", name: "Доллар США" }
    : { code: "TJS", symbol: "смн", name: "Сомони" };
};
function warehouseCurrency(whId) {
  const w = warehouses.find((x) => x.id === whId);
  if (w?.currency) return w.currency;
  if (isAccessoriesWarehouse(w)) return currency_meta("USD");
  return currency_meta(warehouseKind(whId) === "used" ? "TJS" : "USD");
}
function accMoney(n) {
  const w = warehouses.find((x) => x.id === accWarehouseId);
  return fmtCurrency(n, w?.currency?.code === "USD" ? w.currency : currency_meta("USD"));
}
function isAccessoriesWarehouse(w) {
  if (!w) return false;
  const t = (w.warehouse_type || "").toLowerCase();
  if (t === "accessories") return true;
  return (w.name || "").toLowerCase().includes("аксесс");
}
function phoneWarehouses() {
  return warehouses.filter((w) => !isAccessoriesWarehouse(w));
}
function whMoney(n, whId = selectedWarehouseId) {
  return fmtCurrency(n, warehouseCurrency(whId));
}
function posWhId() {
  const el = document.getElementById("pos-warehouse");
  return +(el?.value || defaultWarehouseId() || 0);
}
function posMoney(n) {
  return whMoney(n, posWhId());
}
function lineUnitPrice(c) {
  const v = c.unit_price;
  if (v != null && Number.isFinite(+v) && +v > 0) return +v;
  return +c.product?.sale_price || 0;
}
function lineSubtotal(c) {
  return lineUnitPrice(c) * (c.quantity || 0);
}
function currencyLabel(code) {
  const c = (code || "").toUpperCase();
  if (c === "USD") return "$ (USD)";
  if (c === "TJS") return "смн (TJS)";
  return c || "—";
}
function getRate(code) {
  const c = (code || "").toUpperCase();
  const base = (storeConfig.currency?.code || "TJS").toUpperCase();
  if (!c || c === base) return 1;
  const rates = storeConfig.exchange_rates || {};
  if (rates[c] == null) return null;
  return +rates[c];
}
/** Convert amount from → to using rates to base currency. */
function convertMoney(amount, fromCode, toCode) {
  const from = (fromCode || "").toUpperCase();
  const to = (toCode || "").toUpperCase();
  if (!from || !to || from === to) return +amount || 0;
  const fr = getRate(from);
  const tr = getRate(to);
  if (fr == null || tr == null || fr <= 0 || tr <= 0) return null;
  return (+amount || 0) * fr / tr;
}
function posSaleCurrency() {
  return (warehouseCurrency(posWhId())?.code || "TJS").toUpperCase();
}
function posPayCurrency() {
  if (!document.getElementById("pos-fx-enable")?.checked) return posSaleCurrency();
  return (document.getElementById("pos-fx-currency")?.value || posSaleCurrency()).toUpperCase();
}
function posPayMoney(n) {
  return fmtCurrency(n, currency_meta(posPayCurrency()));
}
/** Rate: 1 sale_currency = rate pay_currency (editable). */
function posFxRateSaleToPay() {
  const inp = document.getElementById("pos-fx-rate");
  if (inp && inp.value !== "" && +inp.value > 0) return +inp.value;
  return convertMoney(1, posSaleCurrency(), posPayCurrency());
}
function posConvertSaleToPay(amount) {
  const r = posFxRateSaleToPay();
  if (r == null || r <= 0) return null;
  return (+amount || 0) * r;
}
function posConvertToSale(amount, fromCur) {
  const sale = posSaleCurrency();
  const from = (fromCur || sale).toUpperCase();
  if (!from || from === sale) return +amount || 0;
  const pay = posPayCurrency();
  if (from === pay) {
    const r = posFxRateSaleToPay();
    if (r == null || r <= 0) return null;
    return (+amount || 0) / r;
  }
  return convertMoney(amount, from, sale);
}
function syncPosFxRateFromSettings(force = false) {
  const inp = document.getElementById("pos-fx-rate");
  if (!inp) return;
  if (!force && inp.dataset.manual === "1") return;
  const rate = convertMoney(1, posSaleCurrency(), posPayCurrency());
  if (rate != null && rate > 0) {
    inp.value = String(Math.round(rate * 10000) / 10000);
    inp.dataset.manual = "0";
  } else {
    inp.value = "";
  }
}
function refreshPosFxUi() {
  const enable = document.getElementById("pos-fx-enable");
  const fields = document.getElementById("pos-fx-fields");
  const sel = document.getElementById("pos-fx-currency");
  const hint = document.getElementById("pos-fx-rate-hint");
  const caption = document.getElementById("pos-fx-rate-caption");
  const totalEl = document.getElementById("pos-fx-total");
  const totalLabel = document.getElementById("pos-fx-total-label");
  if (!enable || !fields || !sel) return;
  const saleCur = posSaleCurrency();
  const opts = ["TJS", "USD"].filter((c, i, a) => a.indexOf(c) === i);
  const prev = sel.value;
  sel.innerHTML = opts.map((c) =>
    `<option value="${c}" ${c === saleCur ? "disabled" : ""}>${currencyLabel(c)}</option>`
  ).join("");
  const prefer = opts.find((c) => c !== saleCur) || opts[0];
  sel.value = opts.includes(prev) && prev !== saleCur ? prev : prefer;
  fields.classList.toggle("hidden", !enable.checked);
  if (!enable.checked) {
    if (hint) hint.textContent = "";
    updateSplitSummary();
    return;
  }
  const payCur = sel.value;
  if (caption) caption.textContent = `1 ${saleCur} = … ${payCur}`;
  syncPosFxRateFromSettings(false);
  const rate = posFxRateSaleToPay();
  if (hint) {
    if (rate == null) {
      hint.textContent = `Нет курса в настройках — введите курс вручную`;
      hint.style.color = "var(--danger)";
    } else {
      const fromSettings = convertMoney(1, saleCur, payCur);
      const custom = document.getElementById("pos-fx-rate")?.dataset.manual === "1";
      hint.textContent = custom
        ? `Свой курс: 1 ${saleCur} = ${(+rate).toFixed(4)} ${payCur}`
        : `Авто из настроек: 1 ${saleCur} = ${(+rate).toFixed(4)} ${payCur}`;
      hint.style.color = "";
      if (fromSettings == null && !custom) hint.style.color = "var(--danger)";
    }
  }
  const dueWh = cartTotalDue();
  const duePay = posConvertSaleToPay(dueWh);
  if (totalLabel) totalLabel.textContent = `К оплате (${payCur})`;
  if (totalEl) totalEl.textContent = duePay == null ? "—" : posPayMoney(duePay);
  updateSplitSummary();
}
function finFmt(block, field = "gross_revenue") {
  const rows = block?.by_currency;
  if (rows?.length) {
    const bags = { USD: 0, TJS: 0 };
    for (const c of rows) {
      const code = String(c.code || "TJS").toUpperCase();
      bags[code] = (bags[code] || 0) + (+c[field] || 0);
    }
    // Prefer labeled bags whenever currency rows exist (incl. single-currency)
    if (rows.length > 1 || (bags.USD && bags.TJS) || rows.length === 1) {
      if (rows.length > 1 || (Math.abs(bags.USD) > 0.005 && Math.abs(bags.TJS) > 0.005)) {
        return formatCurrencyBags(bags);
      }
      const only = rows[0];
      return fmtCurrency(only[field] ?? block?.[field], currency_meta(only.code));
    }
  }
  const v = block?.[field];
  if (v == null) return "—";
  return fmt(v);
}

function moneyLine(amount, currencyCode) {
  return fmtCurrency(amount, currency_meta(currencyCode || "TJS"));
}

function creditorBagsHtml(c, field = "balance") {
  return formatSideBags(c?.by_currency || [], field);
}
const pct = (a, b) => b ? Math.round((a / b) * 100) : 0;
const catLabel = (c) => ({ phone: "Телефон", accessory: "Аксессуар" }[c] || c);
const ownLabel = (o) => ({ own: "Собственный", consignment: "Реализация" }[o] || o);
const payLabel = (p) => storeConfig.payment_methods?.find((m) => m.code === p)?.name || ({ cash: "Наличные", card: "Карта", transfer: "Перевод", trade_in: "Обмен", split: "Смешанная" }[p] || p);

function formatPaySummary(sale) {
  if (sale.payments?.length) {
    if (sale.payments.length === 1) return payLabel(sale.payments[0].method_code);
    return sale.payments.map((p) => `${payLabel(p.method_code)} ${saleFmt(sale, p.amount)}`).join(" · ");
  }
  return payLabel(sale.payment_method);
}

function renderReceiptHtml(sale) {
  const sf = (n) => saleFmt(sale, n);
  const cashier = sale.user_name ? `<div class="receipt-meta">Кассир: ${esc(sale.user_name)}</div>` : "";
  const payBlock = sale.payments?.length
    ? `<div class="receipt-payments">${sale.payments.map((p) =>
        `<div class="receipt-pay-row"><span>${payLabel(p.method_code)}</span><strong>${sf(p.amount)}</strong></div>`
      ).join("")}</div>`
    : `<div class="receipt-payments"><div class="receipt-pay-row"><span>${payLabel(sale.payment_method)}</span><strong>${sf(sale.total)}</strong></div></div>`;
  return `
    <div class="rt">TeleStore ERP</div>
    <div class="receipt-meta">Чек №${sale.id}</div>
    <div class="receipt-meta">${sale.created_at}</div>
    ${cashier}
    <hr>
    ${sale.items.map((i) => {
      const unitLines = (i.units || []).map((u) => {
        const id = u.imei || u.serial || (u.imei_pending ? "IMEI позже" : "—");
        const cust = u.customs_cleared ? ` · таможня ${sf(u.customs_price)}` : "";
        return `<div class="receipt-meta" style="text-align:left;font-size:.8rem">↳ ${esc(id)}${cust}</div>`;
      }).join("");
      return `<div class="receipt-line">${esc(i.product_name)} ×${i.quantity}<span>${sf(i.subtotal)}</span></div>${unitLines}`;
    }).join("")}
    <hr>
    ${sale.discount > 0 ? `<div class="receipt-line">Скидка<span>−${sf(sale.discount)}</span></div>` : ""}
    <div class="receipt-total">ИТОГО: ${sf(sale.total)}</div>
    ${payBlock}`;
}

let lastSaleDetail = null;
const scopeLabel = (s) => ({ all: "Общий", own: "Собственные", consignment: "Реализация", trade_ins: "Обмены" }[s] || s);
const conditionLabel = (c) => ({ new: "Новый", used: "Б/у", refurbished: "Восстановленный" }[c] || c);
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const dash = (s) => s ? esc(s) : "—";

function scanBeep(ok = true) {
  try {
    if (navigator.vibrate) navigator.vibrate(ok ? 40 : [30, 40, 30]);
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = ok ? 880 : 220;
    gain.gain.value = 0.08;
    osc.start();
    osc.stop(ctx.currentTime + (ok ? 0.08 : 0.15));
  } catch { /* ignore */ }
}

function focusScanInput(id) {
  requestAnimationFrame(() => {
    const el = document.getElementById(id);
    if (el) { el.focus(); el.select?.(); }
  });
}

function unitStatusBadge(u) {
  const map = {
    no_imei: '<span class="tag unit-no-imei-tag">нет IMEI</span>',
    pending_customs: '<span class="tag unit-customs-tag">на растamожке</span>',
    reserved: '<span class="tag unit-reserved-tag">резерв</span>',
  };
  return map[u.display_status] || "";
}

function productPhClass(p) {
  return (p?.category || "phone") === "phone" ? "ph-phone" : "ph-accessory";
}
function productPhIcon(p) {
  return (p?.category || "phone") === "phone" ? "📱" : "🎧";
}
function renderProductVisual(p, size = "") {
  const cls = `${productPhClass(p)} ${size}`.trim();
  if (p?.image_url) {
    return `<div class="product-visual ${cls}"><img src="${esc(p.image_url)}" alt="${esc(p.name)}" loading="lazy"></div>`;
  }
  return `<div class="product-visual ${cls}"><span class="product-visual-icon">${productPhIcon(p)}</span></div>`;
}
function productSpecChips(p) {
  const parts = [];
  if (p.color) parts.push(colorChipHtml(p.color));
  [p.model, p.memory, p.ram, p.size].forEach((s) => {
    if (!s) return;
    const sLow = s.toLocaleLowerCase("ru");
    if (p.color && p.color.toLocaleLowerCase("ru") === sLow) return;
    parts.push(`<span class="spec-chip">${esc(s)}</span>`);
  });
  return parts.slice(0, 4).join("");
}
function productCatalogTitle(p) {
  const name = String(p.name || "").trim();
  const color = String(p.color || "").trim();
  if (!color) return name;
  const nLow = name.toLocaleLowerCase("ru");
  const cLow = color.toLocaleLowerCase("ru");
  if (nLow.includes(cLow)) return name;
  return `${name} · ${color}`;
}
function colorChipHtml(color) {
  if (!color) return "";
  return `<span class="spec-chip spec-chip-color">${esc(color)}</span>`;
}
function stockBadgeClass(p) {
  if (p.stock <= 0) return "out";
  if (p.stock <= p.min_stock) return "low";
  return "";
}
function stockBadgeText(p) {
  if (p.stock <= 0) return "Нет в наличии";
  if (p.track_units && p.units_available != null) return `${p.units_available} IMEI`;
  return `${p.stock} шт.`;
}

async function apiUpload(path, file) {
  const headers = {};
  if (pin) headers["X-Pin"] = pin;
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch(path, { method: "POST", headers, body: fd });
  if (res.status === 401) {
    pin = "";
    localStorage.removeItem(PIN_KEY);
    showLogin();
    throw new Error("Неверный PIN — войдите снова");
  }
  if (res.status === 403) {
    throw new Error("Недостаточно прав для загрузки фото");
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(typeof err.detail === "string" ? err.detail : `Ошибка загрузки ${res.status}`);
  }
  return res.json();
}

function el(id) {
  return document.getElementById(id);
}

function showModal(id) {
  const dlg = el(id);
  if (!dlg) {
    toast(`Ошибка интерфейса (${id}). Обновите страницу: Ctrl+F5`, "error");
    return false;
  }
  try {
    if (typeof dlg.showModal === "function") {
      if (dlg.open) return true;
      dlg.showModal();
    } else {
      dlg.setAttribute("open", "");
      dlg.style.display = "block";
    }
    return true;
  } catch (err) {
    console.error("showModal", id, err);
    toast(err.message || "Не удалось открыть окно", "error");
    return false;
  }
}

function resetProductSaveBtn() {
  const btn = el("product-save-btn");
  if (btn) {
    btn.disabled = false;
    btn.textContent = "Сохранить";
  }
}

function setImageUploadBusy(busy) {
  const label = el("pf-image-upload-label");
  const text = el("pf-upload-text");
  const hint = el("pf-image-hint");
  if (!label) return;
  label.classList.toggle("disabled", busy);
  if (text) text.textContent = busy ? "Загрузка…" : "Загрузить фото";
  if (hint && !busy) hint.textContent = "JPG, PNG, WEBP до 5 МБ · можно перетащить на превью";
}

async function handleProductImageFile(file) {
  if (!file) return;
  if (!file.type.startsWith("image/")) {
    toast("Выберите файл изображения", "error");
    return;
  }
  if (file.size > 5 * 1024 * 1024) {
    toast("Файл больше 5 МБ", "error");
    return;
  }
  clearProductImagePending();
  pendingProductImage = file;
  pendingProductImageUrl = URL.createObjectURL(file);
  setProductImagePreview();

  const id = document.getElementById("pf-id")?.value;
  if (id) {
    setImageUploadBusy(true);
    try {
      const updated = await apiUpload(`/api/products/${id}/image`, file);
      pendingProductImage = null;
      URL.revokeObjectURL(pendingProductImageUrl);
      pendingProductImageUrl = null;
      setProductImagePreview(updated);
      toast("Фото загружено");
      if (currentPage === "catalog") {
      loadCatalog();
      loadCatalogColors();
    }
    } catch (err) {
      toast(err.message, "error");
    } finally {
      setImageUploadBusy(false);
    }
  }
}

function clearProductImagePending() {
  pendingProductImage = null;
  if (pendingProductImageUrl) {
    URL.revokeObjectURL(pendingProductImageUrl);
    pendingProductImageUrl = null;
  }
}

function setProductImagePreview(p = null) {
  const box = document.getElementById("pf-image-preview");
  if (!box) return;
  const cat = p?.category || document.getElementById("pf-category")?.value || "phone";
  const fake = { category: cat, name: p?.name || "", image_url: p?.image_url || "" };
  box.className = `pf-image-preview ${productPhClass(fake)}`;
  if (pendingProductImageUrl) {
    box.innerHTML = `<img src="${pendingProductImageUrl}" alt="">`;
  } else if (fake.image_url) {
    box.innerHTML = `<img src="${esc(fake.image_url)}" alt="">`;
  } else {
    box.innerHTML = `<span class="pf-image-placeholder">${productPhIcon(fake)}</span>`;
  }
}

function sortCatalogItems(items, sort) {
  const list = [...items];
  if (sort === "price_asc") list.sort((a, b) => a.sale_price - b.sale_price);
  else if (sort === "price_desc") list.sort((a, b) => b.sale_price - a.sale_price);
  else if (sort === "stock") list.sort((a, b) => b.stock - a.stock);
  else list.sort((a, b) => a.name.localeCompare(b.name, "ru"));
  return list;
}

const PAGE_TITLES = {
  dashboard: "Обзор",
  pos: "Касса",
  sales: "Продажи",
  warehouses: "Склад",
  "products-own": "Собственные товары",
  "products-consignment": "Под реализацию",
  accessories: "Аксессуары",
  users: "Пользователи",
  reports: "Отчёты",
  debtors: "Взаиморасчёты",
  creditors: "Кредиторка",
  analytics: "Аналитика",
  settings: "Настройки",
  stocktake: "Инвентаризация",
};

function defaultWarehouseId() {
  const list = phoneWarehouses();
  const d = list.find((w) => w.is_default);
  return d ? d.id : list[0]?.id ?? null;
}

function whStock(p, whId) {
  if (!whId || !p) return p?.stock ?? 0;
  if (p.track_units && p.units_by_warehouse) {
    return +(p.units_by_warehouse[String(whId)] ?? p.units_by_warehouse[whId] ?? 0);
  }
  if (!p.stock_by_warehouse) return p.stock ?? 0;
  return +(p.stock_by_warehouse[String(whId)] ?? p.stock_by_warehouse[whId] ?? 0);
}

function pagesForCurrentUser() {
  if (!effectiveSimpleUi() && fullRolePages && currentUser?.role) {
    return fullRolePages[currentUser.role] || allowedPages;
  }
  return allowedPages;
}

function canAccess(page) {
  const pages = pagesForCurrentUser();
  return !pages || pages.includes(page);
}

function firstAllowedPage() {
  const pages = pagesForCurrentUser();
  if (!pages?.length) return effectiveSimpleUi() ? "pos" : "dashboard";
  if (currentUser?.role === "accessories" && pages.includes("accessories")) return "accessories";
  if (effectiveSimpleUi() && pages.includes("pos")) return "pos";
  return pages.includes("dashboard") ? "dashboard" : pages[0];
}

async function refreshSession() {
  if (authRequired && !pin) return;
  try {
    const data = await api("/api/auth/check", { method: "POST", body: JSON.stringify({ pin: pin || "" }) });
    currentUser = data.user;
    allowedPages = data.pages;
    if (typeof data.simple_ui === "boolean") serverSimpleUi = data.simple_ui;
  } catch {
    if (authRequired) throw new Error("auth");
  }
  updateTopbar();
  applyRoleNav();
  applySimpleNav();
}

function applySimpleNav() {
  syncSimpleBodyClass();
  document.querySelectorAll("#page-pos .pos-layout-3").forEach((el) => {
    el.classList.toggle("pos-layout-simple", effectiveSimpleUi());
  });
  if (!effectiveSimpleUi()) return;
  document.querySelectorAll(".nav-advanced").forEach((el) => el.classList.add("hidden"));
  document.querySelectorAll(".nav-item").forEach((btn) => {
    const page = btn.dataset.page;
    if (ADVANCED_PAGES.has(page)) btn.classList.add("hidden");
  });
  document.querySelectorAll(".nav-group-label").forEach((label) => {
    let el = label.nextElementSibling;
    let anyVisible = false;
    while (el && !el.classList.contains("nav-group-label")) {
      if (el.classList.contains("nav-item") && !el.classList.contains("hidden")) anyVisible = true;
      el = el.nextElementSibling;
    }
    label.classList.toggle("hidden", !anyVisible);
  });
  const whSel = document.getElementById("pos-warehouse");
  if (whSel && phoneWarehouses().length <= 1) {
    whSel.classList.add("hidden");
  }
}

function updateAdvancedUiToggle() {
  const cb = document.getElementById("toggle-advanced-ui");
  if (!cb) return;
  cb.checked = !!localStorage.getItem(ADVANCED_UI_KEY);
  const card = document.getElementById("simple-mode-card");
  if (card) card.classList.toggle("hidden", !serverSimpleUi || currentUser?.role !== "owner");
}

function updateTopbar() {
  const actions = document.getElementById("topbar-actions");
  if (!actions) return;
  const offline = !navigator.onLine;
  const qn = offlineQueueCount();
  const statusBadge = offline || qn
    ? `<span class="topbar-status ${offline ? "is-offline" : "is-sync"}">${offline ? "Офлайн" : "Онлайн"}${qn ? ` · ${qn} в очереди` : ""}</span>`
    : "";
  const userBadge = currentUser
    ? `<span class="topbar-user">${esc(currentUser.name)} · ${ROLE_LABELS[currentUser.role] || currentUser.role}</span>`
    : "";
  actions.innerHTML = `${statusBadge}${userBadge}<button class="btn btn-ghost btn-sm" id="btn-logout">Выход</button>`;
  document.getElementById("btn-logout")?.addEventListener("click", () => {
    pin = "";
    localStorage.removeItem(PIN_KEY);
    currentUser = null;
    allowedPages = null;
    showLogin();
  });
}

function applyRoleNav() {
  const pages = pagesForCurrentUser();
  document.querySelectorAll(".nav-item").forEach((btn) => {
    const page = btn.dataset.page;
    btn.classList.toggle("hidden", pages && !pages.includes(page));
  });
  document.querySelectorAll(".nav-group-label").forEach((label) => {
    let el = label.nextElementSibling;
    let anyVisible = false;
    while (el && !el.classList.contains("nav-group-label")) {
      if (el.classList.contains("nav-item") && !el.classList.contains("hidden")) anyVisible = true;
      el = el.nextElementSibling;
    }
    label.classList.toggle("hidden", !anyVisible);
  });
}

function fillWarehouseSelect(el, selectedId, { empty = false, emptyLabel = "— выберите —", phonesOnly = false } = {}) {
  if (!el) return;
  const list = phonesOnly ? phoneWarehouses() : warehouses;
  const cur = selectedId ?? el.value;
  el.innerHTML = (empty ? `<option value="">${emptyLabel}</option>` : "") +
    list.map((w) => `<option value="${w.id}">${esc(w.name)}${w.is_default ? " ★" : ""}</option>`).join("");
  if (cur) el.value = String(cur);
  else if (!empty && defaultWarehouseId()) el.value = String(defaultWarehouseId());
}

async function api(path, opts = {}) {
  const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  if (pin) headers["X-Pin"] = pin;
  const res = await fetch(path, { ...opts, headers });
  if (res.status === 401) {
    pin = "";
    localStorage.removeItem(PIN_KEY);
    showLogin();
    throw new Error("Неверный PIN");
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    let detail = err.detail;
    if (Array.isArray(detail)) {
      detail = detail.map((d) => d.msg || d.message || JSON.stringify(d)).join("; ");
    } else if (detail && typeof detail === "object") {
      detail = detail.msg || detail.message || JSON.stringify(detail);
    }
    throw new Error(typeof detail === "string" && detail ? detail : `Ошибка ${res.status}`);
  }
  return res.json();
}

function toast(msg, type = "success") {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.className = `toast toast-show${type === "error" ? " error" : ""}`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("toast-show"), 3200);
}

function showLogin() {
  document.getElementById("login-screen").classList.remove("hidden");
  document.getElementById("app").classList.add("hidden");
}

function showApp() {
  document.getElementById("login-screen").classList.add("hidden");
  document.getElementById("app").classList.remove("hidden");
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

function navigate(page) {
  if (page === "catalog") page = "warehouses";
  if (!canAccess(page)) {
    page = firstAllowedPage();
  }
  currentPage = page;
  document.querySelectorAll(".nav-item").forEach((n) => n.classList.toggle("active", n.dataset.page === page));
  document.querySelectorAll(".page").forEach((p) => {
    p.classList.remove("active");
    p.classList.remove("page-enter");
  });
  const pageEl = document.getElementById(`page-${page}`);
  pageEl?.classList.add("active");
  requestAnimationFrame(() => pageEl?.classList.add("page-enter"));
  document.getElementById("page-title").textContent = PAGE_TITLES[page] || page;
  const loaders = {
    dashboard: loadDashboard,
    pos: loadPos,
    sales: loadSales,
    warehouses: loadWarehousesPage,
    "products-own": loadOwnProducts,
    "products-consignment": loadConsProducts,
    accessories: loadAccessoriesPage,
    reservations: loadReservationsPage,
    users: loadUsersPage,
    settings: loadSettingsPage,
    stocktake: loadStocktakePage,
    reports: loadReport,
    debtors: loadDebtorsPage,
    creditors: loadCreditorsPage,
    analytics: loadAnalytics,
  };
  loaders[page]?.();
}

function bindNav() {
  document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.addEventListener("click", () => navigate(btn.dataset.page));
  });
}

function bindGlobalActions() {
  document.body.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const action = btn.dataset.action;
    if (action === "product-add-own") openProductModal("own");
    else if (action === "product-add-consignment") openProductModal("consignment");
    else if (action === "warehouse-add") openWarehouseModal();
  });
}

function startClock() {
  const tick = () => {
    document.getElementById("clock").textContent = new Date().toLocaleString("ru-RU", {
      weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
    });
  };
  tick();
  setInterval(tick, 30000);
}

async function loadWarehouses() {
  warehouses = await api("/api/warehouses");
  fillWarehouseSelect(document.getElementById("pos-warehouse"), defaultWarehouseId(), { phonesOnly: true });
  fillWarehouseSelect(document.getElementById("pos-exp-warehouse"), defaultWarehouseId(), { phonesOnly: true });
  fillWarehouseSelect(document.getElementById("pf-warehouse"), defaultWarehouseId());
  fillWarehouseSelect(document.getElementById("sm-to-warehouse"), null, { empty: true });
}

async function init() {
  try {
    const res = await fetch("/api/config");
    if (!res.ok) throw new Error("config");
    const cfg = await res.json();
    authRequired = cfg.auth_required;
    serverSimpleUi = cfg.simple_ui !== false;
    simpleUi = serverSimpleUi;
    fullRolePages = cfg.role_pages || null;
    document.getElementById("store-name").textContent = cfg.store_name || "TeleStore";
    if (cfg.currency) storeConfig.currency = cfg.currency;
    if (cfg.payment_methods?.length) storeConfig.payment_methods = cfg.payment_methods;
    if (cfg.exchange_rates) storeConfig.exchange_rates = cfg.exchange_rates;

    if (authRequired && !pin) {
      showLogin();
      return;
    }

    try {
      await refreshSession();
    } catch {
      if (authRequired) {
        showLogin();
        return;
      }
    }

    if (!authRequired) allowedPages = null;
    showApp();
    syncSimpleBodyClass();
    updateAdvancedUiToggle();
    startClock();
    bindNav();
    bindGlobalActions();
    bindPos();
    bindSales();
    bindDashboard();
    bindProducts();
    bindCatalog();
    bindWarehouses();
    bindSuppliers();
    bindAccessories();
    bindDebtors();
    bindCreditors();
    bindReports();
    bindAnalytics();
    bindUsers();
    bindSettings();
    bindStocktake();
    window.addEventListener("online", () => { updateTopbar(); flushOfflineQueue(); });
    window.addEventListener("offline", updateTopbar);
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.ready.then(() => flushOfflineQueue()).catch(() => {});
    }
    await loadWarehouses();
    navigate(firstAllowedPage());
  } catch (e) {
    console.error("init failed", e);
    showLogin();
    const errEl = document.getElementById("pin-error");
    if (errEl) {
      errEl.textContent = "Не удалось подключиться к серверу. Обновите страницу.";
      errEl.classList.remove("hidden");
    }
  }
}

document.getElementById("pin-submit").addEventListener("click", async () => {
  pin = document.getElementById("pin-input").value.trim();
  try {
    await api("/api/auth/check", { method: "POST", body: JSON.stringify({ pin }) });
    localStorage.setItem(PIN_KEY, pin);
    document.getElementById("pin-error").classList.add("hidden");
    await init();
  } catch {
    document.getElementById("pin-error").textContent = "Неверный PIN";
    document.getElementById("pin-error").classList.remove("hidden");
  }
});
document.getElementById("pin-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("pin-submit").click();
});

/* ── Dashboard ── */
async function loadDashboard() {
  const d = await api("/api/dashboard");
  document.getElementById("dash-kpi").innerHTML = `
    <div class="kpi accent-blue kpi-clickable" data-kpi="revenue_today" title="Нажмите для детализации">
      <div class="label">Выручка сегодня</div><div class="value">${finFmt(d.today, "gross_revenue")}</div><div class="sub">${d.today.sales_count} продаж · подробнее →</div></div>
    <div class="kpi accent-green kpi-clickable" data-kpi="profit_today" title="Нажмите для детализации">
      <div class="label">Прибыль сегодня</div><div class="value">${finFmt(d.today, "shop_profit")}</div><div class="sub">маржа ${d.today.margin_pct}% · подробнее →</div></div>
    <div class="kpi accent-blue kpi-clickable" data-kpi="revenue_month" title="Нажмите для детализации">
      <div class="label">Выручка за месяц</div><div class="value">${finFmt(d.month, "gross_revenue")}</div><div class="sub">${d.month.sales_count} продаж · подробнее →</div></div>
    <div class="kpi accent-warn kpi-clickable" data-kpi="low_stock" title="Нажмите для списка">
      <div class="label">Мало на складе</div><div class="value">${d.low_stock_count}</div><div class="sub">позиций · подробнее →</div></div>
  `;
  document.querySelectorAll("#dash-kpi .kpi-clickable").forEach((el) => {
    el.addEventListener("click", () => openKpiDetail(el.dataset.kpi));
  });
  document.getElementById("dash-today").innerHTML = `
    ${renderCurrencyBreakdown(d.month.by_currency)}
    <div class="metric-row"><span>Выручка сегодня</span><strong class="value-multi">${finFmt(d.today, "gross_revenue")}</strong></div>
    <div class="metric-row"><span>Прибыль сегодня</span><strong class="value-multi">${finFmt(d.today, "shop_profit")}</strong></div>
    <div class="metric-row"><span>К оплате поставщикам</span><strong class="value-multi">${finFmt(d.today, "supplier_due")}</strong></div>
    <div class="metric-row"><span>Себестоимость (свои)</span><strong class="value-multi">${finFmt(d.today, "own_cogs")}</strong></div>
  `;
  document.getElementById("dash-split").innerHTML = `
    <div class="metric-row"><span><span class="tag tag-own">Свои</span> Выручка</span><strong class="value-multi">${finFmt(d.own_month, "gross_revenue")}</strong></div>
    <div class="metric-row"><span><span class="tag tag-own">Свои</span> Прибыль</span><strong class="value-multi">${finFmt(d.own_month, "shop_profit")}</strong></div>
    <div class="metric-row"><span><span class="tag tag-cons">Реализация</span> Выручка</span><strong class="value-multi">${finFmt(d.consignment_month, "gross_revenue")}</strong></div>
    <div class="metric-row"><span><span class="tag tag-cons">Реализация</span> Комиссия</span><strong class="value-multi">${finFmt(d.consignment_month, "shop_profit")}</strong></div>
    <div class="metric-row"><span><span class="tag tag-cons">Реализация</span> Долг поставщикам</span><strong class="value-multi">${finFmt(d.consignment_month, "supplier_due")}</strong></div>
  `;
  const sup = d.supplier_balances || [];
  document.getElementById("dash-suppliers-card").classList.toggle("hidden", !sup.length);
  document.getElementById("dash-suppliers").innerHTML = sup.length
    ? `<table class="data-table"><thead><tr><th>Поставщик</th><th>К выплате</th></tr></thead><tbody>
        ${sup.map((s) => `<tr><td>${esc(s.supplier_name)}</td><td class="value-multi"><strong>${creditorBagsHtml(s, "balance")}</strong></td></tr>`).join("")}
       </tbody></table>`
    : '<p style="color:var(--muted)">Нет задолженности</p>';

  const alerts = d.alerts || {};
  const alertCard = document.getElementById("dash-alerts-card");
  const alertBody = document.getElementById("dash-alerts");
  const hasAlerts = (alerts.imei_pending_stale || 0) > 0 || (alerts.no_imei_stock || 0) > 0
    || (alerts.pending_customs || 0) > 0 || (alerts.active_reservations || 0) > 0;
  alertCard?.classList.toggle("hidden", !hasAlerts);
  if (alertBody && hasAlerts) {
    const rows = [];
    if (alerts.imei_pending_stale > 0) {
      rows.push(`<div class="dash-alert dash-alert-warn"><strong>⚠ IMEI не внесён &gt; 3 дней: ${alerts.imei_pending_stale}</strong>
        <button class="btn btn-ghost btn-sm" onclick="navigate('warehouses')">Открыть склад</button></div>`);
    }
    if (alerts.no_imei_stock > 0) {
      rows.push(`<div class="dash-alert"><span>На складе без IMEI: <strong>${alerts.no_imei_stock}</strong></span></div>`);
    }
    if (alerts.pending_customs > 0) {
      rows.push(`<div class="dash-alert"><span>На растamожке: <strong>${alerts.pending_customs}</strong></span></div>`);
    }
    if (alerts.active_reservations > 0) {
      rows.push(`<div class="dash-alert"><span>Активных резервов: <strong>${alerts.active_reservations}</strong></span>
        <button class="btn btn-ghost btn-sm" onclick="navigate('reservations')">Резервы</button></div>`);
    }
    if (alerts.stale_imei_items?.length) {
      rows.push(`<table class="data-table" style="margin-top:.5rem"><thead><tr><th>Чек</th><th>Дата</th><th>Товар</th><th>Серийник</th></tr></thead><tbody>
        ${alerts.stale_imei_items.map((r) => `<tr><td>#${r.sale_id}</td><td>${r.created_at}</td><td>${esc(r.product_name)}</td><td>${esc(r.serial || "—")}</td></tr>`).join("")}
      </tbody></table>`);
    }
    alertBody.innerHTML = rows.join("");
  }
}

async function openKpiDetail(metric) {
  try {
    const data = await api(`/api/dashboard/kpi-detail?metric=${encodeURIComponent(metric)}`);
    document.getElementById("kpi-detail-title").textContent = data.title || "Отчёт";
    const summaryEl = document.getElementById("kpi-detail-summary");
    const byWhEl = document.getElementById("kpi-detail-by-wh");
    const thead = document.getElementById("kpi-detail-thead");
    const tbody = document.getElementById("kpi-detail-tbody");

    if (metric === "low_stock") {
      summaryEl.innerHTML = `Позиций с низким остатком: <strong>${data.total}</strong>`;
      byWhEl.classList.add("hidden");
      thead.innerHTML = "<tr><th>Склад</th><th>Товар</th><th>Остаток</th><th>Мин.</th></tr>";
      tbody.innerHTML = (data.items || []).map((r) => `
        <tr>
          <td>${esc(r.warehouse_name)}</td>
          <td><strong>${esc(r.product_name)}</strong></td>
          <td><strong>${r.quantity}</strong></td>
          <td>${r.min_stock}</td>
        </tr>`).join("") || '<tr><td colspan="4" style="text-align:center;color:var(--muted)">Всё в норме</td></tr>';
    } else {
      const isProfit = metric === "profit_today";
      const field = isProfit ? "shop_profit" : "gross_revenue";
      summaryEl.innerHTML = `Итого: <strong class="value-multi">${formatSideBags(data.by_currency || [], field)}</strong>`;
      if (data.by_warehouse?.length) {
        byWhEl.classList.remove("hidden");
        byWhEl.innerHTML = `
          <h4>По складам</h4>
          <table class="data-table"><thead><tr><th>Склад</th><th>Валюта</th><th>Чеков</th><th>Выручка</th><th>Прибыль</th></tr></thead><tbody>
            ${data.by_warehouse.map((w) => `
              <tr>
                <td><strong>${esc(w.warehouse_name)}</strong></td>
                <td>${esc(w.currency_code || "TJS")}</td>
                <td>${w.sales_count}</td>
                <td>${moneyLine(w.revenue, w.currency_code)}</td>
                <td>${moneyLine(w.profit, w.currency_code)}</td>
              </tr>`).join("")}
          </tbody></table>`;
      } else {
        byWhEl.classList.add("hidden");
        byWhEl.innerHTML = "";
      }
      thead.innerHTML = `<tr><th>Дата</th><th>Чек</th><th>Склад</th><th>Товар</th><th>Кол-во</th><th>${isProfit ? "Прибыль" : "Сумма"}</th><th>Кассир</th></tr>`;
      tbody.innerHTML = (data.items || []).map((r) => `
        <tr>
          <td>${esc(r.created_at)}</td>
          <td>#${r.sale_id}</td>
          <td><strong>${esc(r.warehouse_name)}</strong></td>
          <td>${esc(r.product_name)}</td>
          <td>${r.quantity}</td>
          <td><strong>${moneyLine(isProfit ? r.shop_profit : r.subtotal, r.currency_code)}</strong></td>
          <td>${esc(r.cashier || "—")}</td>
        </tr>`).join("") || '<tr><td colspan="7" style="text-align:center;color:var(--muted)">Нет продаж за период</td></tr>';
    }
    document.getElementById("kpi-detail-modal").showModal();
  } catch (err) {
    toast(err.message, "error");
  }
}

function bindDashboard() {
  document.getElementById("kpi-detail-close")?.addEventListener("click", () => {
    document.getElementById("kpi-detail-modal")?.close();
  });
  document.getElementById("unit-history-close")?.addEventListener("click", () => {
    document.getElementById("unit-history-modal")?.close();
  });
  const imeInp = document.getElementById("dash-imei-search");
  imeInp?.addEventListener("input", debounce((e) => {
    const q = e.target.value.trim();
    if (q.replace(/\D/g, "").length < 5 && q.length < 5) {
      hideDashImeiResults();
      return;
    }
    runDashImeiSearch(q);
  }, 220));
  imeInp?.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideDashImeiResults();
    if (e.key === "Enter") {
      e.preventDefault();
      const first = document.querySelector("#dash-imei-results .pos-search-item");
      if (first) first.click();
    }
  });
  document.addEventListener("click", (e) => {
    const wrap = document.querySelector(".dash-imei-wrap");
    if (wrap && !wrap.contains(e.target)) hideDashImeiResults();
  });
}

function hideDashImeiResults() {
  const box = document.getElementById("dash-imei-results");
  if (box) {
    box.classList.add("hidden");
    box.innerHTML = "";
  }
}

function unitStatusLabel(u) {
  if (u.is_sold || u.status === "sold") return { text: "Продан", cls: "sold" };
  if (u.status === "reserved" || u.is_reserved) return { text: "Резерв", cls: "reserved" };
  if (u.status === "in_stock") return { text: "На складе", cls: "stock" };
  return { text: u.status || "—", cls: "" };
}

async function runDashImeiSearch(q) {
  const box = document.getElementById("dash-imei-results");
  if (!box) return;
  try {
    const data = await api(`/api/units/imei-history?q=${encodeURIComponent(q)}`);
    const items = data.matches || [];
    if (!items.length) {
      box.innerHTML = `<div class="pos-search-empty">Ничего не найдено</div>`;
      box.classList.remove("hidden");
      return;
    }
    box.innerHTML = items.map((u, idx) => {
      const st = unitStatusLabel(u);
      const last = u.last_sale
        ? ` · продажа ${fmtCurrency(u.last_sale.unit_price, currency_meta(u.last_sale.currency_code || "TJS"))} (${(u.last_sale.created_at || "").slice(0, 10)})`
        : "";
      return `<button type="button" class="pos-search-item" data-idx="${idx}">
        <span class="psi-name">${esc(u.product_name || u.model || "Устройство")}
          <span class="dash-imei-status ${st.cls}">${st.text}</span>
        </span>
        <span class="psi-price">${u.ops_count || 0} оп.</span>
        <span class="psi-meta">${esc([u.imei || u.serial, u.product_color || u.color, u.memory, u.warehouse_name].filter(Boolean).join(" · "))}${esc(last)}</span>
      </button>`;
    }).join("");
    box.classList.remove("hidden");
    box.querySelectorAll(".pos-search-item").forEach((btn) => {
      btn.addEventListener("click", () => openUnitHistory(items[+btn.dataset.idx].id));
    });
  } catch (err) {
    box.innerHTML = `<div class="pos-search-empty">${esc(err.message)}</div>`;
    box.classList.remove("hidden");
  }
}

async function openUnitHistory(unitId) {
  hideDashImeiResults();
  try {
    const data = await api(`/api/units/${unitId}/history`);
    const u = data.unit || {};
    const events = data.events || [];
    const st = unitStatusLabel(u);
    document.getElementById("unit-history-title").textContent =
      `${u.imei || u.serial || "#" + u.id} · ${u.product_name || u.model || "Устройство"}`;
    document.getElementById("unit-history-sub").textContent =
      `${st.text} · ${u.warehouse_name || ""} · ${u.ops_count || events.length} операций` +
      (u.product_color || u.memory ? ` · ${[u.product_color, u.memory].filter(Boolean).join(" / ")}` : "");
    const box = document.getElementById("unit-history-content");
    if (!events.length) {
      box.innerHTML = '<p class="hint">История пуста</p>';
    } else {
      box.innerHTML = `<div class="unit-history-timeline">${events.map((e) => {
        const money = e.amount
          ? fmtCurrency(e.amount, currency_meta(e.currency_code || "TJS"))
          : "";
        const who = e.user_name ? ` · ${esc(e.user_name)}` : "";
        const saleBtn = e.sale_id
          ? ` <button type="button" class="btn btn-ghost btn-sm" data-open-sale="${e.sale_id}">Чек #${e.sale_id}</button>`
          : "";
        return `<div class="unit-history-event ${esc(e.kind)}">
          <div class="uhe-top">
            <span class="uhe-title">${esc(e.title)}</span>
            <span class="uhe-amount">${money}</span>
          </div>
          <div class="uhe-meta">${esc((e.at || "").slice(0, 16))}${who}${e.warehouse_name ? ` · ${esc(e.warehouse_name)}` : ""}${e.notes ? ` · ${esc(e.notes)}` : ""}${saleBtn}</div>
        </div>`;
      }).join("")}</div>`;
      box.querySelectorAll("[data-open-sale]").forEach((btn) => {
        btn.addEventListener("click", () => {
          document.getElementById("unit-history-modal")?.close();
          showSale(+btn.dataset.openSale);
        });
      });
    }
    document.getElementById("unit-history-modal")?.showModal();
  } catch (err) {
    toast(err.message, "error");
  }
}

window.openUnitHistory = openUnitHistory;
window.runDashImeiSearch = runDashImeiSearch;

/* ── POS ── */
let posInType = "counterparty";

function bindPos() {
  document.getElementById("pos-warehouse")?.addEventListener("change", (e) => {
    const sel = e.currentTarget;
    const keep = sel?.dataset.keepCart === "1";
    if (sel) delete sel.dataset.keepCart;
    if (!keep) {
      cart = [];
      const fx = document.getElementById("pos-fx-enable");
      if (fx) fx.checked = false;
    }
    const curHint = document.getElementById("pos-currency-hint");
    if (curHint) {
      const cur = warehouseCurrency(posWhId());
      curHint.textContent = cur.code === "USD" ? "Цены в $" : "Цены в смн";
    }
    renderCart();
    const q = document.getElementById("pos-search")?.value?.trim();
    if (q) runPosSmartSearch(q);
    else hidePosSearchResults();
  });
  document.getElementById("pos-search")?.addEventListener("input", debounce((e) => {
    const q = e.target.value.trim();
    if (q.length < 1) { hidePosSearchResults(); return; }
    runPosSmartSearch(q);
  }, 220));
  document.getElementById("pos-search")?.addEventListener("keydown", async (e) => {
    if (e.key === "Escape") { hidePosSearchResults(); return; }
    if (e.key !== "Enter") return;
    e.preventDefault();
    const q = e.target.value.trim();
    if (!q) return;
    const first = document.querySelector("#pos-search-results .pos-search-item");
    if (first) first.click();
    else await runPosSmartSearch(q, true);
  });
  document.addEventListener("click", (e) => {
    const wrap = document.querySelector(".pos-search-wrap");
    if (wrap && !wrap.contains(e.target)) hidePosSearchResults();
  });
  document.getElementById("split-fill-cash")?.addEventListener("click", () => {
    const saleCur = posSaleCurrency();
    const payCur = posPayCurrency();
    const fxOn = !!document.getElementById("pos-fx-enable")?.checked && payCur !== saleCur;
    let total = cartTotalDue();
    let fillCur = saleCur;
    if (fxOn) {
      const conv = posConvertSaleToPay(total);
      if (conv == null) { toast("Укажите курс конвертации", "error"); return; }
      total = Math.round(conv * 100) / 100;
      fillCur = payCur;
    }
    document.querySelectorAll(".split-pay-input").forEach((inp) => {
      inp.value = inp.dataset.method === "cash" ? total : "";
      const curSel = inp.closest(".split-pay-row")?.querySelector(".split-pay-currency");
      if (curSel) curSel.value = fillCur;
    });
    updateSplitSummary();
  });
  document.getElementById("split-payments")?.addEventListener("input", (e) => {
    if (e.target.classList.contains("split-pay-input") || e.target.classList.contains("split-pay-currency")) {
      updateSplitSummary();
    }
  });
  document.getElementById("split-payments")?.addEventListener("change", (e) => {
    if (e.target.classList.contains("split-pay-currency")) updateSplitSummary();
  });
  document.getElementById("cart-discount")?.addEventListener("input", renderCart);
  document.getElementById("checkout-btn")?.addEventListener("click", checkout);
  document.getElementById("pos-fx-enable")?.addEventListener("change", () => {
    const rateInp = document.getElementById("pos-fx-rate");
    if (rateInp) rateInp.dataset.manual = "0";
    syncPosFxRateFromSettings(true);
    refreshPosFxUi();
    renderSplitPayments();
  });
  document.getElementById("pos-fx-currency")?.addEventListener("change", () => {
    const rateInp = document.getElementById("pos-fx-rate");
    if (rateInp) rateInp.dataset.manual = "0";
    syncPosFxRateFromSettings(true);
    refreshPosFxUi();
    renderSplitPayments();
  });
  document.getElementById("pos-fx-rate")?.addEventListener("input", () => {
    const inp = document.getElementById("pos-fx-rate");
    if (inp) inp.dataset.manual = "1";
    refreshPosFxUi();
  });
  document.getElementById("clear-cart-btn")?.addEventListener("click", () => { cart = []; renderCart(); });
  document.getElementById("pos-cash-refresh")?.addEventListener("click", loadPosCashRegister);
  document.getElementById("pos-shift-open")?.addEventListener("click", openShiftOpenModal);
  document.getElementById("shift-open-cancel")?.addEventListener("click", () => {
    document.getElementById("shift-open-modal")?.close();
  });
  document.getElementById("shift-open-fill-zero")?.addEventListener("click", () => {
    document.querySelectorAll("#shift-open-wallets input[data-open-amt]").forEach((inp) => {
      inp.value = "0";
    });
  });
  document.getElementById("shift-open-form")?.addEventListener("submit", submitShiftOpen);
  document.getElementById("pos-shift-close")?.addEventListener("click", openShiftCloseModal);
  document.getElementById("shift-close-cancel")?.addEventListener("click", () => {
    document.getElementById("shift-close-modal")?.close();
  });
  document.getElementById("shift-close-fill-expected")?.addEventListener("click", () => {
    document.querySelectorAll("#shift-close-wallets input[data-close-amt]").forEach((inp) => {
      inp.value = String(Math.max(0, +inp.dataset.expected || 0));
    });
  });
  document.getElementById("shift-close-form")?.addEventListener("submit", submitShiftClose);
  document.getElementById("unit-extra-cancel")?.addEventListener("click", () => {
    document.getElementById("unit-extra-modal")?.close();
  });
  document.getElementById("unit-extra-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = +document.getElementById("unit-extra-form").dataset.unitId;
    if (!id) return;
    try {
      await api(`/api/units/${id}/extra-cost`, {
        method: "PATCH",
        body: JSON.stringify({ extra_cost: Math.max(0, +document.getElementById("unit-extra-amount").value || 0) }),
      });
      document.getElementById("unit-extra-modal")?.close();
      toast("Расходы сохранены");
      loadWarehouseStock();
    } catch (err) { toast(err.message, "error"); }
  });
  fillPaySelect(document.getElementById("pos-exp-pay"));
  let posExpType = "expense";
  const syncPosExpTypeUi = () => {
    const isPayout = posExpType === "payout";
    document.getElementById("pos-exp-expense-fields")?.classList.toggle("hidden", isPayout);
    document.getElementById("pos-exp-payout-fields")?.classList.toggle("hidden", !isPayout);
    const cat = document.getElementById("pos-exp-category");
    const payee = document.getElementById("pos-exp-payee");
    const wh = document.getElementById("pos-exp-warehouse");
    if (cat) cat.required = !isPayout;
    if (payee) payee.required = isPayout;
    if (wh) wh.required = isPayout;
    const btn = document.getElementById("pos-exp-submit");
    if (btn) btn.textContent = isPayout ? "Добавить выплату" : "Добавить расход";
  };
  document.querySelectorAll("#pos-exp-type-tabs .seg").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#pos-exp-type-tabs .seg").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      posExpType = btn.dataset.expType || "expense";
      syncPosExpTypeUi();
    });
  });
  syncPosExpTypeUi();
  document.getElementById("pos-expense-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const isPayout = posExpType === "payout";
      const body = {
        kind: isPayout ? "payout" : "expense",
        amount: +document.getElementById("pos-exp-amount").value,
        expense_date: new Date().toISOString().slice(0, 10),
        description: document.getElementById("pos-exp-desc").value,
        payment_method_code: document.getElementById("pos-exp-pay").value,
      };
      if (isPayout) {
        body.payee = document.getElementById("pos-exp-payee").value.trim();
        body.warehouse_id = +document.getElementById("pos-exp-warehouse").value;
        body.category = "Выплата";
        if (!body.warehouse_id) throw new Error("Выберите склад");
        if (!body.payee) throw new Error("Укажите, кому выплатили");
      } else {
        body.category = document.getElementById("pos-exp-category").value.trim();
      }
      await api("/api/expenses", { method: "POST", body: JSON.stringify(body) });
      toast(isPayout ? "Выплата добавлена" : "Расход добавлен");
      document.getElementById("pos-expense-form").reset();
      syncPosExpTypeUi();
      fillPaySelect(document.getElementById("pos-exp-pay"));
      fillWarehouseSelect(document.getElementById("pos-exp-warehouse"), defaultWarehouseId(), { phonesOnly: true });
      loadPosCashRegister();
    } catch (err) { toast(err.message, "error"); }
  });
  fillPaySelect(document.getElementById("pos-in-pay"));
  document.querySelectorAll("#pos-in-type-tabs .seg").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#pos-in-type-tabs .seg").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      posInType = btn.dataset.inType || "counterparty";
      document.getElementById("pos-in-counterparty-block")?.classList.toggle("hidden", posInType !== "counterparty");
      document.getElementById("pos-in-debtor-block")?.classList.toggle("hidden", posInType !== "debtor");
      const cp = document.getElementById("pos-in-counterparty");
      if (cp) cp.required = posInType === "counterparty";
      if (posInType === "debtor") loadPosDebtorsSelect();
    });
  });
  document.getElementById("pos-in-debtor")?.addEventListener("change", onPosDebtorSelected);
  document.getElementById("pos-in-currency")?.addEventListener("change", updatePosInFxUI);
  document.getElementById("pos-inflow-form")?.addEventListener("submit", submitPosInflow);
  bindDebtorCheckout();
}

function formatSideBags(rows, field) {
  const bags = { USD: 0, TJS: 0 };
  for (const r of rows || []) {
    const code = String(r.code || "TJS").toUpperCase();
    bags[code] = (bags[code] || 0) + (+r[field] || 0);
  }
  return formatCurrencyBags(bags);
}

function inferWalletCurrency(b) {
  const ex = String(b?.currency_code || "").toUpperCase();
  if (ex === "USD" || ex === "TJS") return ex;
  const blob = `${b?.name || ""} ${b?.code || ""}`.toLowerCase();
  if (/доллар|dollar|usd|\$/.test(blob)) return "USD";
  if (/сомон|смн|\btjs\b|наличн/.test(blob) && !/доллар|dollar|usd/.test(blob)) return "TJS";
  return "";
}

/** One currency for bound wallets ($ or смн). Bags only for multi-currency wallets. */
function formatWalletField(b, field) {
  const cur = inferWalletCurrency(b);
  const rows = b?.by_currency || [];
  if (cur === "USD" || cur === "TJS") {
    const row = rows.find((r) => String(r.code).toUpperCase() === cur);
    const val = row ? +row[field] || 0 : 0;
    return fmtCurrency(val, currency_meta(cur));
  }
  return formatSideBags(rows, field);
}

let posCashWindow = { date_from: "", date_to: "", shift: null };

function formatAmountBags(bags) {
  if (!(bags || []).length) return fmtCurrency(0, currency_meta("TJS"));
  return (bags || []).map((b) => fmtCurrency(b.amount || 0, b)).join(" · ");
}

async function openPosCashDetail(kind, methodCode = "") {
  try {
    // Wallets = all-time; period KPIs = shift/today window
    const useAll = kind === "wallet";
    let url = `/api/pos/cash-register/detail?kind=${encodeURIComponent(kind)}&period=${useAll ? "all" : "auto"}`;
    if (!useAll && posCashWindow.date_from) {
      url += `&date_from=${encodeURIComponent(posCashWindow.date_from)}&date_to=${encodeURIComponent(posCashWindow.date_to || posCashWindow.date_from)}`;
    }
    if (methodCode) url += `&method_code=${encodeURIComponent(methodCode)}`;
    const r = await api(url);
    const titleEl = document.getElementById("kpi-detail-title");
    const sumEl = document.getElementById("kpi-detail-summary");
    const byWh = document.getElementById("kpi-detail-by-wh");
    const thead = document.getElementById("kpi-detail-thead");
    const tbody = document.getElementById("kpi-detail-tbody");
    if (titleEl) titleEl.textContent = r.title || "Детали кассы";
    if (byWh) { byWh.classList.add("hidden"); byWh.innerHTML = ""; }
    const s = r.summary || {};
    const curBags = s.by_currency || r.by_currency || [];
    if (sumEl) {
      if (kind === "profit") {
        const finBags = (r.by_currency || []).map((c) => ({
          code: c.code,
          revenue: c.gross_revenue,
          profit: c.shop_profit ?? c.net_profit,
        }));
        sumEl.innerHTML = `
          <div class="metric-row"><span>Выручка</span><div class="value value-multi">${formatSideBags(finBags, "revenue")}</div></div>
          <div class="metric-row"><span>Прибыль</span><div class="value value-multi">${formatSideBags(finBags, "profit")}</div></div>
          <div class="metric-row"><span>Продаж</span><strong>${s.sales_count || 0}</strong></div>`;
      } else {
        sumEl.innerHTML = `
          <div class="metric-row"><span>Приход (+)</span><div class="value value-multi" style="color:var(--success)">${formatSideBags(curBags, "plus")}</div></div>
          <div class="metric-row"><span>Расход (−)</span><div class="value value-multi" style="color:var(--danger, #c44)">${formatSideBags(curBags, "minus")}</div></div>
          <div class="metric-row"><span>Итого</span><div class="value value-multi">${formatSideBags(curBags, "net")}</div></div>
          <div class="metric-row"><span>Записей</span><strong>${s.lines_count || 0}</strong></div>`;
      }
    }
    if (thead) {
      thead.innerHTML = kind === "profit"
        ? "<tr><th colspan=\"5\">Детализация по валютам — в отчёте Финансы</th></tr>"
        : "<tr><th>Дата</th><th>+/−</th><th>Откуда / куда</th><th>Кто / способ</th><th>Сумма</th></tr>";
    }
    if (tbody) {
      if (kind === "profit") {
        tbody.innerHTML = (r.by_currency || []).map((c) => `
          <tr>
            <td colspan="2"><strong>${esc(c.name || c.code)}</strong></td>
            <td>выручка ${fmtCurrency(c.gross_revenue, c)}</td>
            <td colspan="2">прибыль ${fmtCurrency(c.shop_profit ?? c.net_profit, c)}</td>
          </tr>`).join("") || '<tr><td colspan="5" class="muted">Нет данных</td></tr>';
      } else {
        tbody.innerHTML = (r.lines || []).map((l) => {
          const money = fmtCurrency(l.amount, currency_meta(l.currency_code || "TJS"));
          const who = [l.who, l.method_name, l.ref].filter(Boolean).join(" · ");
          const note = [l.note].filter(Boolean).join("");
          return `<tr>
            <td>${esc((l.at || "").slice(0, 16))}</td>
            <td><strong style="color:${l.side === "+" ? "var(--success)" : "var(--danger, #c44)"}">${l.side}</strong></td>
            <td>${esc(l.source)}${note ? `<br><span class="hint">${esc(note)}</span>` : ""}</td>
            <td>${esc(who || "—")}</td>
            <td><strong>${money}</strong></td>
          </tr>`;
        }).join("") || '<tr><td colspan="5" style="text-align:center;color:var(--muted)">Нет движений за период</td></tr>';
      }
    }
    document.getElementById("kpi-detail-modal")?.showModal();
  } catch (err) {
    toast(err.message, "error");
  }
}

function syncPosShiftUi(shift) {
  const status = document.getElementById("pos-shift-status");
  const openBtn = document.getElementById("pos-shift-open");
  const closeBtn = document.getElementById("pos-shift-close");
  if (shift?.id) {
    const opened = (shift.opened_at || "").slice(0, 16).replace("T", " ");
    let openHint = "";
    try {
      const wallets = typeof shift.opening_wallets_json === "string"
        ? JSON.parse(shift.opening_wallets_json || "[]")
        : (shift.opening_wallets || []);
      const parts = (wallets || [])
        .filter((w) => +w.amount > 0)
        .map((w) => `${w.method_name || w.method_code} ${fmtCurrency(+w.amount, currency_meta(w.currency_code || "TJS"))}`);
      if (parts.length) openHint = ` · старт: ${parts.slice(0, 4).join(", ")}${parts.length > 4 ? "…" : ""}`;
      else if (+shift.opening_cash > 0) openHint = ` · старт нал ${fmt(+shift.opening_cash)}`;
    } catch { /* ignore */ }
    if (status) status.innerHTML = `<strong style="color:var(--success)">Смена открыта</strong> · ${esc(shift.user_name || "")} · с ${esc(opened)}${esc(openHint)}`;
    openBtn?.classList.add("hidden");
    closeBtn?.classList.remove("hidden");
  } else {
    if (status) status.innerHTML = `<strong style="color:var(--danger, #c44)">Смена не открыта</strong> — откройте смену, чтобы вести отчёт дня`;
    openBtn?.classList.remove("hidden");
    closeBtn?.classList.add("hidden");
  }
}

async function openShiftOpenModal() {
  const box = document.getElementById("shift-open-wallets");
  const modal = document.getElementById("shift-open-modal");
  if (!box || !modal) return;
  box.innerHTML = '<p class="muted">Загрузка кошельков…</p>';
  modal.showModal();
  try {
    const cash = await api("/api/pos/cash-register?period=all").catch(() => null);
    const list = (storeConfig.payment_methods || []).filter((m) => m.is_active !== 0);
    const balMap = {};
    for (const b of (cash?.wallets_all_time || cash?.balances || [])) {
      balMap[b.code] = b;
    }
    box.innerHTML = list.map((m) => {
      const bal = balMap[m.code] || {};
      const bound = (m.currency_code || inferWalletCurrency(bal) || "").toUpperCase();
      const currencies = bound === "USD" || bound === "TJS"
        ? [bound]
        : ["TJS", "USD"];
      const fields = currencies.map((cur) => {
        const row = (bal.by_currency || []).find((r) => String(r.code).toUpperCase() === cur);
        const prefill = row ? Math.max(0, +row.net || 0) : 0;
        const label = cur === "USD" ? "$" : "смн";
        return `<label class="shift-open-amt">
          <span>${label}</span>
          <input type="number" class="input" min="0" step="0.01" value="${prefill}"
            data-open-amt data-method="${esc(m.code)}" data-currency="${cur}">
        </label>`;
      }).join("");
      const typeHint = (m.method_type || "") === "cash" ? "наличные" : "безнал";
      return `<div class="shift-open-row" data-method="${esc(m.code)}">
        <div class="shift-open-name">
          <strong>${esc(m.name)}</strong>
          <small class="hint">${esc(typeHint)}${bound ? ` · ${bound}` : ""}</small>
        </div>
        <div class="shift-open-fields">${fields}</div>
      </div>`;
    }).join("") || '<p class="muted">Нет активных способов оплаты — добавьте в Настройках</p>';
  } catch (err) {
    box.innerHTML = `<p class="muted">${esc(err.message)}</p>`;
  }
}

async function submitShiftOpen(e) {
  e.preventDefault();
  const opening_wallets = [];
  document.querySelectorAll("#shift-open-wallets input[data-open-amt]").forEach((inp) => {
    const amount = Math.max(0, +inp.value || 0);
    if (!(amount > 0)) return;
    opening_wallets.push({
      method_code: inp.dataset.method,
      currency_code: inp.dataset.currency || "TJS",
      amount,
    });
  });
  try {
    await api("/api/shifts/open", {
      method: "POST",
      body: JSON.stringify({ opening_wallets, opening_cash: 0 }),
    });
    document.getElementById("shift-open-modal")?.close();
    toast(opening_wallets.length ? "Смена открыта со стартовыми суммами" : "Смена открыта");
    loadPosCashRegister();
  } catch (err) {
    toast(err.message, "error");
  }
}

function renderShiftWalletRows(containerId, rows, { inputAttr = "data-open-amt", showExpected = false } = {}) {
  const box = document.getElementById(containerId);
  if (!box) return;
  const byMethod = new Map();
  for (const r of rows || []) {
    const code = r.method_code || r.code;
    if (!byMethod.has(code)) {
      byMethod.set(code, {
        code,
        name: r.method_name || r.name || code,
        method_type: r.method_type || "",
        currencies: [],
      });
    }
    byMethod.get(code).currencies.push(r);
  }
  const list = [...byMethod.values()];
  box.innerHTML = list.map((m) => {
    const typeHint = (m.method_type || "") === "cash" ? "наличные" : "безнал";
    const fields = m.currencies.map((c) => {
      const cur = (c.currency_code || c.code || "TJS").toUpperCase();
      const label = cur === "USD" ? "$" : "смн";
      const expected = Math.max(0, +(c.expected ?? c.amount ?? c.net ?? 0) || 0);
      const prefill = showExpected ? expected : Math.max(0, +(c.amount ?? c.net ?? expected) || 0);
      const hint = showExpected
        ? `<small class="hint">ожид. ${fmtCurrency(expected, currency_meta(cur))}</small>`
        : "";
      return `<label class="shift-open-amt">
        <span>${label}</span>
        <input type="number" class="input" min="0" step="0.01" value="${prefill}"
          ${inputAttr} data-method="${esc(m.code)}" data-currency="${cur}" data-expected="${expected}">
        ${hint}
      </label>`;
    }).join("");
    return `<div class="shift-open-row" data-method="${esc(m.code)}">
      <div class="shift-open-name">
        <strong>${esc(m.name)}</strong>
        <small class="hint">${esc(typeHint)}</small>
      </div>
      <div class="shift-open-fields">${fields}</div>
    </div>`;
  }).join("") || '<p class="muted">Нет кошельков</p>';
}

async function openShiftCloseModal() {
  const modal = document.getElementById("shift-close-modal");
  const box = document.getElementById("shift-close-wallets");
  if (!modal || !box) return;
  box.innerHTML = '<p class="muted">Загрузка…</p>';
  modal.showModal();
  try {
    const cur = await api("/api/shifts/current");
    if (!cur.shift?.id) {
      modal.close();
      toast("Нет открытой смены", "error");
      return;
    }
    const sum = cur.summary || {};
    const summary = document.getElementById("shift-close-summary");
    if (summary) {
      summary.textContent = `Продаж: ${sum.sales_count || 0} · выручка смены: ${fmt(sum.total_revenue || 0)}`;
    }
    document.getElementById("shift-close-notes").value = "";
    document.getElementById("shift-close-form").dataset.shiftId = String(cur.shift.id);
    let rows = cur.expected_wallets || [];
    if (!rows.length) {
      // fallback: active methods with zeros
      rows = (storeConfig.payment_methods || []).flatMap((m) => {
        const bound = (m.currency_code || "").toUpperCase();
        const curs = bound === "USD" || bound === "TJS" ? [bound] : ["TJS", "USD"];
        return curs.map((currency_code) => ({
          method_code: m.code,
          method_name: m.name,
          method_type: m.method_type,
          currency_code,
          expected: 0,
        }));
      });
    }
    renderShiftWalletRows("shift-close-wallets", rows, {
      inputAttr: "data-close-amt",
      showExpected: true,
    });
  } catch (err) {
    box.innerHTML = `<p class="muted">${esc(err.message)}</p>`;
  }
}

async function submitShiftClose(e) {
  e.preventDefault();
  const id = +document.getElementById("shift-close-form")?.dataset.shiftId;
  if (!id) return;
  const actual_wallets = [];
  document.querySelectorAll("#shift-close-wallets input[data-close-amt]").forEach((inp) => {
    actual_wallets.push({
      method_code: inp.dataset.method,
      currency_code: inp.dataset.currency || "TJS",
      amount: Math.max(0, +inp.value || 0),
    });
  });
  try {
    const r = await api(`/api/shifts/${id}/close`, {
      method: "POST",
      body: JSON.stringify({
        actual_wallets,
        actual_cash: 0,
        actual_card: 0,
        notes: document.getElementById("shift-close-notes").value.trim(),
      }),
    });
    document.getElementById("shift-close-modal")?.close();
    const diffs = (r.wallet_differences || []).filter((d) => Math.abs(+d.difference || 0) >= 0.01);
    if (diffs.length) {
      const tip = diffs.slice(0, 3).map((d) =>
        `${d.method_name || d.method_code} ${d.currency_code}: ${fmtCurrency(+d.difference, currency_meta(d.currency_code))}`
      ).join(" · ");
      toast(`Смена закрыта · расхождения: ${tip}${diffs.length > 3 ? "…" : ""}`, "info");
    } else {
      const posts = r.cash_ledger_posts || [];
      toast(posts.length
        ? `Смена закрыта · в остатки кассы записано ${posts.length} корр.`
        : "Смена закрыта");
    }
    loadPosCashRegister();
  } catch (err) {
    toast(err.message, "error");
  }
}

async function loadPosCashRegister() {
  const kpi = document.getElementById("pos-cash-kpi");
  const tb = document.getElementById("pos-expenses-tbody");
  if (!kpi) return;
  try {
    const r = await api("/api/pos/cash-register?period=auto");
    posCashWindow = {
      date_from: r.date_from || "",
      date_to: r.date_to || "",
      shift: r.shift || null,
    };
    syncPosShiftUi(r.shift);
    const periodEl = document.getElementById("pos-cash-period-label");
    if (periodEl) periodEl.textContent = r.period_label || "";

    const tillBox = document.getElementById("pos-till-summary");
    if (tillBox) {
      const t = r.till || {};
      const cardTxt = formatAmountBags(t.card);
      tillBox.innerHTML = `
        <div class="pos-till-card accent-green" title="Наличные сомони в кассе">
          <div class="label">Наличные смн</div>
          <div class="value">${fmtCurrency(t.cash_tjs || 0, t.cash_tjs_meta || currency_meta("TJS"))}</div>
        </div>
        <div class="pos-till-card accent-blue" title="Наличные доллары в кассе">
          <div class="label">Наличные $</div>
          <div class="value">${fmtCurrency(t.cash_usd || 0, t.cash_usd_meta || currency_meta("USD"))}</div>
        </div>
        <div class="pos-till-card accent-warn" title="Карта / Alif / перевод и др.">
          <div class="label">Карта / безнал</div>
          <div class="value value-multi">${cardTxt}</div>
        </div>`;
    }

    const bags = r.by_currency || [];
    const finBags = (r.by_currency_finance || []).map((c) => ({
      code: c.code,
      profit: c.shop_profit ?? c.net_profit,
    }));
    kpi.innerHTML = `
      <div class="kpi accent-blue" title="Оплаты продаж за период"><div class="label">Продажи</div><div class="value value-multi">${formatAmountBags(r.sales)}</div></div>
      <div class="kpi accent-blue row-clickable" data-cash-kind="inflow" title="Ручные приходы"><div class="label">Приходы</div><div class="value value-multi">${formatAmountBags(r.manual_inflows)}</div></div>
      <div class="kpi accent-warn" title="Операционные расходы"><div class="label">Расходы</div><div class="value value-multi">${formatAmountBags(r.expenses_bags)}</div></div>
      <div class="kpi accent-warn" title="Выплаты"><div class="label">Выплаты</div><div class="value value-multi">${formatAmountBags(r.payouts_bags)}</div></div>
      <div class="kpi accent-green row-clickable" data-cash-kind="net" title="Приход − расход за период"><div class="label">Чистыми за период</div><div class="value value-multi">${formatSideBags(bags, "net")}</div></div>
      <div class="kpi row-clickable" data-cash-kind="profit" title="Товарная прибыль продаж"><div class="label">Прибыль</div><div class="value value-multi">${formatSideBags(finBags, "profit")}</div></div>`;
    kpi.querySelectorAll("[data-cash-kind]").forEach((el) => {
      el.addEventListener("click", () => openPosCashDetail(el.dataset.cashKind));
    });
    const balHeading = document.getElementById("pos-balances-heading");
    if (balHeading) {
      balHeading.textContent = r.balances_label
        || (r.shift ? "Сейчас в кассе (старт + приход − расход)" : "Сейчас в кошельках (весь период)");
    }
    const balBox = document.getElementById("pos-balances");
    if (balBox) {
      // При открытой смене balances = старт + приход − расход; иначе весь период.
      const wallets = r.balances || r.wallets_all_time || [];
      const shiftOpen = !!r.shift;
      balBox.innerHTML = wallets.map((b) => {
        const bound = inferWalletCurrency(b);
        const mainCls = bound ? "wallet-amt" : "value value-multi";
        const openParts = (b.by_currency || [])
          .filter((c) => +c.opening > 0.0001)
          .map((c) => `старт ${fmtCurrency(+c.opening, c)}`);
        const openHint = openParts.length
          ? `<small class="hint">${esc(openParts.join(" · "))}</small>`
          : "";
        const moveLabel = shiftOpen ? "движение" : "всего";
        return `
        <button type="button" class="pos-balance-row pos-balance-btn" data-method="${esc(b.code)}" title="Остаток в кассе — нажмите для деталей">
          <span>${esc(b.name)}${bound ? ` <small class="hint">(${bound === "USD" ? "$" : "смн"})</small>` : ""}</span>
          <strong class="${mainCls}">${formatWalletField(b, "net")}</strong>
          ${openHint}
          <small>${moveLabel}: +${formatWalletField(b, "inflow")} / −${formatWalletField(b, "outflow")}</small>
        </button>`;
      }).join("") || '<p class="muted">Нет данных</p>';
      balBox.querySelectorAll(".pos-balance-btn").forEach((btn) => {
        btn.addEventListener("click", () => openPosCashDetail("wallet", btn.dataset.method || ""));
      });
    }
    await loadPosCashLines();
  } catch (err) {
    kpi.innerHTML = `<p class="muted">${esc(err.message)}</p>`;
  }
}

async function loadPosCashLines(fromId) {
  const inSel = document.getElementById("pos-in-lines-period");
  const expSel = document.getElementById("pos-exp-lines-period");
  let period = "week";
  if (fromId === "pos-in-lines-period" && inSel) period = inSel.value;
  else if (fromId === "pos-exp-lines-period" && expSel) period = expSel.value;
  else period = inSel?.value || expSel?.value || "week";
  if (inSel) inSel.value = period;
  if (expSel) expSel.value = period;
  const inLbl = document.getElementById("pos-in-lines-label");
  const expLbl = document.getElementById("pos-exp-lines-label");
  if (inLbl) inLbl.textContent = "Загрузка…";
  if (expLbl) expLbl.textContent = "Загрузка…";
  try {
    const r = await api(`/api/pos/cash-lines?period=${encodeURIComponent(period)}`);
    const label = `${r.period_label || ""} · ${(r.expenses || []).length} расх. / ${(r.cash_inflows || []).length} прих.`;
    if (inLbl) inLbl.textContent = label;
    if (expLbl) expLbl.textContent = label;
    const tb = document.getElementById("pos-expenses-tbody");
    if (tb) {
      try {
        tb.innerHTML = (r.expenses || []).map((e) => {
          const who = e.kind === "payout" && e.payee ? e.payee : (e.category || "—");
          const wh = e.warehouse_name || (e.warehouse_id ? `#${e.warehouse_id}` : "общие");
          return `<tr>
            <td>${esc(e.expense_date)}</td>
            <td>${esc(who)}${e.kind === "payout" ? ` <small class="hint">выплата</small>` : ""}</td>
            <td>${esc(wh)}</td>
            <td><strong>${fmt(e.amount)}</strong></td>
            <td><button type="button" class="btn btn-danger btn-sm" onclick="deletePosExpense(${e.id})" title="Удалить">✕</button></td>
          </tr>`;
        }).join("") || '<tr><td colspan="5" style="text-align:center;color:var(--muted)">Нет записей за период</td></tr>';
      } catch (renderErr) {
        tb.innerHTML = `<tr><td colspan="5" class="muted">${esc(renderErr.message)}</td></tr>`;
      }
    }
    const inTb = document.getElementById("pos-inflows-tbody");
    if (inTb) {
      try {
        inTb.innerHTML = (r.cash_inflows || []).map((row) => {
          const src = row.source_type === "debtor"
            ? `Долг: ${row.counterparty_name || "—"}`
            : (row.counterparty_name || "Контрагент");
          let sum;
          try {
            sum = row.currency_code && row.currency_code !== (storeConfig.currency?.code || "TJS")
              ? `${fmtCurrency(row.amount, currency_meta(row.currency_code))} · ${fmt(row.amount_base)}`
              : fmt(row.amount_base ?? row.amount);
          } catch {
            sum = String(row.amount_base ?? row.amount ?? "—");
          }
          return `<tr>
            <td>${esc((row.created_at || "").slice(0, 16))}</td>
            <td>${esc(src)}</td>
            <td><strong>${sum}</strong></td>
            <td><button type="button" class="btn btn-danger btn-sm" onclick="deletePosInflow(${row.id})" title="Удалить">✕</button></td>
          </tr>`;
        }).join("") || '<tr><td colspan="4" style="text-align:center;color:var(--muted)">Нет записей за период</td></tr>';
      } catch (renderErr) {
        inTb.innerHTML = `<tr><td colspan="4" class="muted">${esc(renderErr.message)}</td></tr>`;
      }
    }
  } catch (err) {
    if (inLbl) inLbl.textContent = err.message;
    if (expLbl) expLbl.textContent = err.message;
    toast(err.message, "error");
  }
}
window.loadPosCashLines = loadPosCashLines;

window.deletePosExpense = async (id) => {
  if (!id || !confirm("Удалить этот расход / выплату?")) return;
  try {
    await api(`/api/expenses/${id}`, { method: "DELETE" });
    toast("Удалено");
    loadPosCashRegister();
  } catch (err) { toast(err.message, "error"); }
};

window.deletePosInflow = async (id) => {
  if (!id || !confirm("Удалить этот приход?")) return;
  try {
    await api(`/api/pos/cash-inflows/${id}`, { method: "DELETE" });
    toast("Удалено");
    loadPosCashRegister();
  } catch (err) { toast(err.message, "error"); }
};

async function loadPos() {
  if (!warehouses.length) await loadWarehouses();
  await refreshSession();
  fillWarehouseSelect(document.getElementById("pos-warehouse"), document.getElementById("pos-warehouse").value || defaultWarehouseId(), { phonesOnly: true });
  fillWarehouseSelect(document.getElementById("pos-exp-warehouse"), defaultWarehouseId(), { phonesOnly: true });
  fillPaySelect(document.getElementById("pos-exp-pay"));
  fillPaySelect(document.getElementById("pos-in-pay"));
  await loadProducts();
  await loadPosCashRegister();
  const curHint = document.getElementById("pos-currency-hint");
  if (curHint) {
    const cur = warehouseCurrency(posWhId());
    curHint.textContent = cur.code === "USD" ? "Цены в $" : "Цены в смн";
  }
  hidePosSearchResults();
  focusScanInput("pos-search");
}

async function loadProducts() {
  let cat = document.getElementById("pos-category")?.value || "";
  if (currentUser?.role === "accessories") cat = "accessory";
  const own = document.getElementById("pos-ownership")?.value || "";
  const wh = document.getElementById("pos-warehouse")?.value || "";
  let url = `/api/products?q=`;
  if (cat) url += `&category=${cat}`;
  if (own) url += `&ownership_type=${own}`;
  if (wh) url += `&warehouse_id=${wh}`;
  try {
    products = await api(url);
    localStorage.setItem(PRODUCTS_CACHE_KEY, JSON.stringify({ url, products, ts: Date.now() }));
  } catch (e) {
    if (isNetworkError(e)) {
      const cached = JSON.parse(localStorage.getItem(PRODUCTS_CACHE_KEY) || "null");
      if (cached?.products?.length) {
        products = cached.products;
        toast("Офлайн — показан сохранённый каталог");
      } else throw e;
    } else throw e;
  }
  renderPosProducts();
  renderCart();
}

function renderPosProducts() {
  /* каталог убран — продажа только через умный поиск */
}

function hidePosSearchResults() {
  const box = document.getElementById("pos-search-results");
  if (box) {
    box.classList.add("hidden");
    box.innerHTML = "";
  }
}

async function runPosSmartSearch(q, autoPick = false) {
  const box = document.getElementById("pos-search-results");
  if (!box) return;
  const whId = posWhId();
  try {
    const hit = await api(`/api/units/lookup?q=${encodeURIComponent(q)}&warehouse_id=${whId}`);
    const items = [];
    if (hit.match_type === "unit") {
      for (const u of hit.matches || []) {
        const otherWh = whId && +u.warehouse_id !== whId;
        items.push({
          kind: "unit",
          product_id: u.product_id,
          unit_id: u.id,
          warehouse_id: u.warehouse_id,
          name: u.product_name || u.model || "Устройство",
          meta: [
            u.imei || u.serial,
            u.product_color || u.color,
            u.memory,
            otherWh ? `склад: ${u.warehouse_name || u.warehouse_id}` : u.warehouse_name,
          ].filter(Boolean).join(" · "),
          price: u.sale_price,
          product: null,
          reserved: !!u.is_reserved,
          other_warehouse: otherWh,
          warehouse_name: u.warehouse_name || "",
        });
      }
    } else if (hit.match_type === "product") {
      for (const p of hit.matches || []) {
        const stock = whStock(p, whId);
        if (stock <= 0 && p.track_units) continue;
        items.push({
          kind: "product",
          product_id: p.id,
          unit_id: null,
          name: p.name,
          meta: [p.model, p.color, p.memory, stock ? `ост. ${stock}` : "нет на складе"].filter(Boolean).join(" · "),
          price: p.sale_price,
          product: p,
          reserved: false,
          out: stock <= 0,
        });
      }
    }
    if (!items.length) {
      box.innerHTML = `<div class="pos-search-empty">Ничего не найдено</div>`;
      box.classList.remove("hidden");
      return;
    }
    if (autoPick && items.length === 1 && !items[0].out) {
      await selectPosSearchItem(items[0]);
      return;
    }
    box.innerHTML = items.map((it, idx) => `
      <button type="button" class="pos-search-item${it.out ? " out" : ""}" data-idx="${idx}">
        <span class="psi-name">${esc(it.name)}${it.reserved ? ' <span class="tag">резерв</span>' : ""}${it.other_warehouse ? ' <span class="tag">др. склад</span>' : ""}</span>
        <span class="psi-price">${it.price != null ? posMoney(it.price) : ""}</span>
        <span class="psi-meta">${esc(it.meta || "")}</span>
      </button>`).join("");
    box.classList.remove("hidden");
    box.querySelectorAll(".pos-search-item").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const it = items[+btn.dataset.idx];
        if (!it || it.out) { toast("Нет в наличии", "error"); return; }
        await selectPosSearchItem(it);
      });
    });
  } catch (err) {
    box.innerHTML = `<div class="pos-search-empty">${esc(err.message)}</div>`;
    box.classList.remove("hidden");
  }
}

async function selectPosSearchItem(it) {
  hidePosSearchResults();
  const search = document.getElementById("pos-search");
  if (search) search.value = "";
  if (it.kind === "unit") {
    await addToCart(it.product_id, it.unit_id);
  } else {
    await addToCart(it.product_id, null, it.product);
  }
  scanBeep(true);
  focusScanInput("pos-search");
}

function updatePosInFxUI() {
  const sel = document.getElementById("pos-in-debtor");
  const opt = sel?.selectedOptions?.[0];
  const debtCur = (opt?.dataset?.currency || "TJS").toUpperCase();
  const payCur = (document.getElementById("pos-in-currency")?.value || "TJS").toUpperCase();
  const wrap = document.getElementById("pos-in-fx-wrap");
  const needFx = posInType === "debtor" && !!opt?.value && payCur !== debtCur;
  wrap?.classList.toggle("hidden", !needFx);
  if (needFx) {
    const rateEl = document.getElementById("pos-in-fx-rate");
    if (rateEl && !+rateEl.value) {
      const r = defaultUsdToTjsRate?.() ?? getRate("USD");
      if (r != null && r > 0) rateEl.value = r;
    }
  }
}

async function loadPosDebtorsSelect() {
  const sel = document.getElementById("pos-in-debtor");
  if (!sel) return;
  try {
    const [receivables, mutual] = await Promise.all([
      api("/api/receivables?status=open").catch(() => []),
      api("/api/mutual-entries?status=open").catch(() => []),
    ]);
    const saleOpts = (receivables || []).map((r) => {
      const cur = (r.currency_code || "TJS").toUpperCase();
      const due = +r.amount_due || 0;
      const label = `${r.customer_name || "Без имени"} — ${fmtCurrency(due, currency_meta(cur))}${r.products ? ` · ${String(r.products).slice(0, 36)}` : ""} · продажа`;
      return `<option value="r:${r.id}" data-due="${due}" data-currency="${cur}">${esc(label)}</option>`;
    });
    const mutualOpts = (mutual || [])
      .filter((m) => m.direction === "owe_us")
      .map((m) => {
        const cur = (m.currency_code || "TJS").toUpperCase();
        const due = +m.amount_due || 0;
        const note = m.product_note || m.notes || "";
        const label = `${m.person_name || "Без имени"} — ${fmtCurrency(due, currency_meta(cur))}${note ? ` · ${String(note).slice(0, 36)}` : ""} · займ`;
        return `<option value="m:${m.id}" data-due="${due}" data-currency="${cur}">${esc(label)}</option>`;
      });
    const all = [...mutualOpts, ...saleOpts];
    sel.innerHTML = `<option value="">Выберите должника…</option>` + all.join("");
    const hint = document.getElementById("pos-in-debtor-hint");
    if (hint) {
      hint.textContent = all.length
        ? "Займы и долги по продажам — сумма спишется с выбранного долга"
        : "Открытых долгов нет (взаиморасчёты с типом «нам должны» или продажи в долг)";
    }
    updatePosInFxUI();
  } catch (err) {
    sel.innerHTML = `<option value="">Ошибка загрузки</option>`;
  }
}

function onPosDebtorSelected() {
  const sel = document.getElementById("pos-in-debtor");
  const opt = sel?.selectedOptions?.[0];
  const due = +(opt?.dataset?.due || 0);
  const cur = (opt?.dataset?.currency || "TJS").toUpperCase();
  const amount = document.getElementById("pos-in-amount");
  const currencyEl = document.getElementById("pos-in-currency");
  if (due > 0 && amount) amount.value = due;
  if (currencyEl && cur) currencyEl.value = cur;
  const hint = document.getElementById("pos-in-debtor-hint");
  if (hint && due > 0) hint.textContent = `К погашению: ${fmtCurrency(due, currency_meta(cur))}`;
  updatePosInFxUI();
}

async function submitPosInflow(e) {
  e.preventDefault();
  const amount = +document.getElementById("pos-in-amount").value;
  const currency_code = document.getElementById("pos-in-currency").value;
  const payment_method_code = document.getElementById("pos-in-pay").value;
  const notes = document.getElementById("pos-in-notes")?.value || "";
  if (!(amount > 0)) { toast("Укажите сумму", "error"); return; }
  try {
    if (posInType === "debtor") {
      const raw = document.getElementById("pos-in-debtor").value || "";
      if (!raw) { toast("Выберите должника", "error"); return; }
      const [kind, idStr] = raw.split(":");
      const id = +idStr;
      if (!id || (kind !== "r" && kind !== "m")) { toast("Выберите должника", "error"); return; }
      const opt = document.getElementById("pos-in-debtor")?.selectedOptions?.[0];
      const debtCur = (opt?.dataset?.currency || "TJS").toUpperCase();
      const body = {
        amount, currency_code, payment_method_code,
        source_type: "debtor", notes,
      };
      if (kind === "m") body.mutual_entry_id = id;
      else body.receivable_id = id;
      if (currency_code !== debtCur) {
        const fx = +document.getElementById("pos-in-fx-rate")?.value || 0;
        if (!(fx > 0)) { toast("Укажите курс: сколько сомони за 1 доллар", "error"); return; }
        body.fx_rate = fx;
      }
      await api("/api/pos/cash-inflow", { method: "POST", body: JSON.stringify(body) });
      toast("Оплата долга принята");
    } else {
      const counterparty_name = document.getElementById("pos-in-counterparty").value.trim();
      if (!counterparty_name) { toast("Укажите контрагента", "error"); return; }
      await api("/api/pos/cash-inflow", {
        method: "POST",
        body: JSON.stringify({
          amount, currency_code, payment_method_code,
          source_type: "counterparty", counterparty_name, notes,
        }),
      });
      toast("Приход записан");
    }
    document.getElementById("pos-inflow-form").reset();
    posInType = "counterparty";
    document.querySelectorAll("#pos-in-type-tabs .seg").forEach((b) => {
      b.classList.toggle("active", b.dataset.inType === "counterparty");
    });
    document.getElementById("pos-in-counterparty-block")?.classList.remove("hidden");
    document.getElementById("pos-in-debtor-block")?.classList.add("hidden");
    document.getElementById("pos-in-fx-wrap")?.classList.add("hidden");
    const cp = document.getElementById("pos-in-counterparty");
    if (cp) cp.required = true;
    loadPosCashRegister();
  } catch (err) {
    toast(err.message, "error");
  }
}


function switchPosWarehouse(warehouseId, { clearCart = true } = {}) {
  const sel = document.getElementById("pos-warehouse");
  if (!sel) return false;
  const id = String(warehouseId);
  if (sel.value === id) return true;
  if (!clearCart) sel.dataset.keepCart = "1";
  sel.value = id;
  sel.dispatchEvent(new Event("change"));
  return sel.value === id;
}

async function addToCart(id, preselectedUnitId = null, productOverride = null) {
  let whId = +document.getElementById("pos-warehouse").value;
  let p = productOverride || products.find((x) => x.id === id);
  if (!p) {
    try { p = await api(`/api/products/${id}`); } catch { toast("Товар не найден", "error"); return; }
  }
  if (!products.find((x) => x.id === p.id)) products.push(p);
  const stock = whStock(p, whId);
  if (stock <= 0 && !preselectedUnitId) { toast("Нет в наличии на складе", "error"); return; }
  if (p.track_units) {
    if (preselectedUnitId) {
      let picked;
      try {
        picked = await api(`/api/units/${preselectedUnitId}`);
      } catch {
        toast("Устройство недоступно", "error");
        return;
      }
      if (!picked || !["in_stock", "reserved"].includes(picked.status)) {
        toast("Устройство недоступно", "error");
        return;
      }
      if (+picked.warehouse_id !== whId) {
        if (cart.length) {
          toast(`Устройство на складе «${picked.warehouse_name || picked.warehouse_id}». Очистите чек или смените склад.`, "error");
          return;
        }
        if (!switchPosWarehouse(picked.warehouse_id, { clearCart: false })) {
          toast("Не удалось переключить склад", "error");
          return;
        }
        whId = +picked.warehouse_id;
        toast(`Склад: ${picked.warehouse_name || picked.warehouse_id}`);
      }
      const used = cart.flatMap((c) => c.unit_ids || []);
      if (used.includes(picked.id)) { toast("Уже в чеке", "error"); return; }
      let unitMeta = null;
      if (!picked.has_imei) {
        unitMeta = await promptUnitActivation(p, picked);
        if (!unitMeta) return;
      }
      cart.push({
        product_id: id, quantity: 1, product: p, unit_ids: [picked.id],
        unit_labels: [picked.imei || picked.serial || `#${picked.id}`],
        unit_metas: unitMeta ? [{ unit_id: picked.id, ...unitMeta }] : [],
        unit_price: +p.sale_price || 0,
      });
      renderCart();
      return;
    }
    pickImeiForProduct(p, whId).then((picked) => {
      if (!picked) return;
      const used = cart.flatMap((c) => c.unit_ids || []);
      if (used.includes(picked.id)) { toast("Этот IMEI уже в чеке", "error"); return; }
      cart.push({
        product_id: id, quantity: 1, product: p, unit_ids: [picked.id], unit_labels: [picked.label],
        unit_metas: picked.unitMeta ? [{ unit_id: picked.id, ...picked.unitMeta }] : [],
        unit_price: +p.sale_price || 0,
      });
      renderCart();
    });
    return;
  }
  const ex = cart.find((c) => c.product_id === id && !c.unit_ids?.length);
  const qty = ex ? ex.quantity : 0;
  if (qty >= stock) { toast(`Макс. ${stock} шт.`, "error"); return; }
  if (ex) ex.quantity++; else cart.push({ product_id: id, quantity: 1, product: p, unit_ids: [], unit_price: +p.sale_price || 0 });
  renderCart();
}

let unitActivateResolve = null;

async function promptUnitActivation(product, unit) {
  const defaultCustoms = product.customs_price || 0;
  return new Promise((resolve) => {
    unitActivateResolve = resolve;
    document.getElementById("unit-activate-title").textContent = product.name;
    document.getElementById("unit-activate-sub").textContent =
      `Серийник: ${unit.serial || "#" + unit.id}${unit.has_imei ? " · IMEI уже есть" : " · IMEI не указан"}`;
    const imeiInp = document.getElementById("ua-imei");
    const laterCb = document.getElementById("ua-later");
    const customsCb = document.getElementById("ua-customs");
    const customsPrice = document.getElementById("ua-customs-price");
    imeiInp.value = unit.imei || "";
    imeiInp.disabled = !!unit.has_imei;
    laterCb.checked = false;
    laterCb.disabled = !!unit.has_imei;
    customsCb.checked = !!product.customs_cleared;
    customsPrice.value = defaultCustoms || 0;
    laterCb.onchange = () => {
      imeiInp.disabled = laterCb.checked || !!unit.has_imei;
      if (laterCb.checked) imeiInp.value = "";
    };
    document.getElementById("unit-activate-modal").showModal();
  });
}

document.getElementById("unit-activate-cancel")?.addEventListener("click", () => {
  document.getElementById("unit-activate-modal").close();
  unitActivateResolve?.(null);
  unitActivateResolve = null;
});

document.getElementById("unit-activate-form")?.addEventListener("submit", (e) => {
  e.preventDefault();
  const later = document.getElementById("ua-later").checked;
  const imei = document.getElementById("ua-imei").value.trim();
  if (!later && !imei) { toast("Введите IMEI или отметьте «активировать позже»", "error"); return; }
  const meta = {
    imei: later ? "" : imei,
    activate_later: later ? 1 : 0,
    customs_cleared: document.getElementById("ua-customs").checked ? 1 : 0,
    customs_price: +document.getElementById("ua-customs-price").value || 0,
  };
  document.getElementById("unit-activate-modal").close();
  unitActivateResolve?.(meta);
  unitActivateResolve = null;
});

async function pickImeiForProduct(product, whId) {
  const units = await api(`/api/products/${product.id}/units?warehouse_id=${whId}&status=in_stock`);
  const used = new Set(cart.flatMap((c) => c.unit_ids || []));
  const available = units.filter((u) => !used.has(u.id));
  if (!available.length) { toast("Нет доступных устройств", "error"); return null; }
  const pickOne = async (u) => {
    const label = u.imei || u.serial || `#${u.id}`;
    let unitMeta = null;
    if (!u.has_imei && !u.imei) {
      unitMeta = await promptUnitActivation(product, u);
      if (!unitMeta) return null;
    } else if (!u.customs_cleared && product.category === "phone") {
      unitMeta = await promptUnitActivation(product, u);
      if (!unitMeta) return null;
    }
    return { id: u.id, label, unitMeta };
  };
  if (available.length === 1) return pickOne(available[0]);
  return new Promise((resolve) => {
    imeiPickerResolve = async (picked) => {
      if (!picked) { resolve(null); return; }
      const u = available.find((x) => x.id === picked.id);
      resolve(u ? pickOne(u) : null);
    };
    document.getElementById("imei-picker-title").textContent = `Устройство: ${product.name}`;
    document.getElementById("imei-picker-list").innerHTML = available.map((u) =>
      `<button type="button" class="imei-pick-btn" data-id="${u.id}">
        <strong>${esc(u.imei || u.serial || `#${u.id}`)}</strong>
        ${!u.has_imei ? '<span class="tag unit-no-imei-tag">без IMEI</span>' : ""}
        ${u.serial && u.imei ? `<span>${esc(u.serial)}</span>` : ""}
      </button>`
    ).join("");
    document.getElementById("imei-picker-list").querySelectorAll(".imei-pick-btn").forEach((btn) => {
      btn.onclick = () => {
        document.getElementById("imei-picker-modal").close();
        imeiPickerResolve({ id: +btn.dataset.id });
        imeiPickerResolve = null;
      };
    });
    document.getElementById("imei-picker-modal").showModal();
  });
}

document.getElementById("imei-picker-cancel")?.addEventListener("click", () => {
  document.getElementById("imei-picker-modal").close();
  imeiPickerResolve?.(null);
  imeiPickerResolve = null;
});

function renderCart() {
  const whId = +document.getElementById("pos-warehouse")?.value;
  const box = document.getElementById("cart-items");
  const empty = document.getElementById("cart-empty");
  const count = cart.reduce((s, c) => s + c.quantity, 0);
  document.getElementById("cart-count").textContent = count;
  if (count > 0) {
    const badge = document.getElementById("cart-count");
    badge.style.transform = "scale(1.2)";
    setTimeout(() => { badge.style.transform = ""; }, 200);
  }
  if (!cart.length) {
    box.innerHTML = "";
    empty.classList.remove("hidden");
    document.getElementById("checkout-btn").disabled = true;
    document.getElementById("cart-subtotal").textContent = posMoney(0);
    document.getElementById("cart-total").textContent = posMoney(0);
    refreshPosFxUi();
    return;
  }
  empty.classList.add("hidden");
  let sub = 0;
  box.innerHTML = cart.map((c, idx) => {
    const price = lineUnitPrice(c);
    const catalog = +c.product.sale_price || 0;
    const custom = Math.abs(price - catalog) > 0.0001;
    const line = price * c.quantity;
    sub += line;
    const imeiLabel = c.unit_labels?.length
      ? `<div class="ci-imei">${c.unit_labels.map((l, i) => {
          const m = c.unit_metas?.[i];
          const pending = m?.activate_later ? ' <span class="tag unit-no-imei-tag">IMEI позже</span>' : "";
          const cust = m?.customs_cleared ? ` · таможня ${posMoney(m.customs_price)}` : "";
          return esc(l) + pending + cust;
        }).join("<br>")}</div>`
      : "";
    const qtyCtrl = c.unit_ids?.length
      ? `<span class="ci-qty-static">${c.quantity}</span>`
      : `<div class="ci-qty"><button onclick="changeQty(${c.product_id},-1)">−</button>${c.quantity}<button onclick="changeQty(${c.product_id},1)">+</button></div>`;
    return `<div class="cart-item">
      <div><div class="ci-name">${esc(c.product.name)}</div>
      <span class="tag tag-${c.product.ownership_type === "consignment" ? "cons" : "own"}" style="font-size:.6rem">${ownLabel(c.product.ownership_type)}</span>${imeiLabel}</div>
      ${qtyCtrl}
      <div class="ci-price-wrap">
        <span class="ci-price-label">Цена</span>
        <div class="ci-price-row">
          <input type="number" class="input sm ci-price${custom ? " is-custom" : ""}" min="0.01" step="0.01"
            value="${price}" title="Цена продажи (прайс ${posMoney(catalog)})"
            onchange="setCartPrice(${idx}, this.value)" oninput="setCartPrice(${idx}, this.value, true)">
          <button type="button" class="btn btn-ghost btn-sm ci-price-reset" title="По прайсу" onclick="resetCartPrice(${idx})">↺</button>
        </div>
      </div>
      <strong class="ci-line-sum">${posMoney(line)}</strong>
      ${c.unit_ids?.length ? `<button class="btn btn-ghost btn-sm" onclick="removeCartLine(${idx})">×</button>` : `<span></span>`}
    </div>`;
  }).join("");
  const disc = +document.getElementById("cart-discount").value || 0;
  document.getElementById("cart-subtotal").textContent = posMoney(sub);
  document.getElementById("cart-total").textContent = posMoney(Math.max(0, sub - disc));
  renderSplitPayments();
  refreshPosFxUi();
  document.getElementById("checkout-btn").disabled = cart.length === 0;
}

window.setCartPrice = (idx, value, soft = false) => {
  const c = cart[idx];
  if (!c) return;
  const n = +value;
  if (!Number.isFinite(n) || n <= 0) {
    if (!soft) toast("Укажите цену больше 0", "error");
    return;
  }
  c.unit_price = n;
  if (soft) {
    // update line sum without full re-render (keep focus)
    const row = document.querySelectorAll("#cart-items .cart-item")[idx];
    if (row) {
      const sum = row.querySelector(".ci-line-sum");
      if (sum) sum.textContent = posMoney(lineSubtotal(c));
      const inp = row.querySelector(".ci-price");
      const catalog = +c.product.sale_price || 0;
      if (inp) inp.classList.toggle("is-custom", Math.abs(n - catalog) > 0.0001);
    }
    const sub = cart.reduce((s, x) => s + lineSubtotal(x), 0);
    const disc = +document.getElementById("cart-discount").value || 0;
    document.getElementById("cart-subtotal").textContent = posMoney(sub);
    document.getElementById("cart-total").textContent = posMoney(Math.max(0, sub - disc));
    refreshPosFxUi();
    return;
  }
  renderCart();
};

window.resetCartPrice = (idx) => {
  const c = cart[idx];
  if (!c) return;
  c.unit_price = +c.product.sale_price || 0;
  renderCart();
};

window.removeCartLine = (idx) => {
  cart.splice(idx, 1);
  renderCart();
};

window.changeQty = (id, d) => {
  const whId = +document.getElementById("pos-warehouse").value;
  const item = cart.find((c) => c.product_id === id && !c.unit_ids?.length);
  if (!item) return;
  item.quantity += d;
  const p = products.find((x) => x.id === id);
  const stock = whStock(p, whId);
  if (item.quantity <= 0) cart = cart.filter((c) => c !== item);
  else if (p && item.quantity > stock) { item.quantity = stock; toast(`Макс. ${stock}`, "error"); }
  renderCart();
};

let debtorModalResolve = null;

function promptDebtorModal(total, paid, currencyCode = null) {
  return new Promise((resolve) => {
    debtorModalResolve = resolve;
    const due = Math.max(0, total - paid);
    const money = (n) => currencyCode ? fmtCurrency(n, currency_meta(currencyCode)) : posMoney(n);
    document.getElementById("debtor-modal-hint").textContent =
      `К оплате ${money(total)}, оплачено ${money(paid)}. В долг: ${money(due)}. Укажите клиента.`;
    document.getElementById("debtor-name").value = "";
    document.getElementById("debtor-phone").value = "";
    document.getElementById("debtor-modal").showModal();
  });
}

function bindDebtorCheckout() {
  document.getElementById("debtor-cancel")?.addEventListener("click", () => {
    document.getElementById("debtor-modal").close();
    debtorModalResolve?.(null);
    debtorModalResolve = null;
  });
  document.getElementById("debtor-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = document.getElementById("debtor-name").value.trim();
    const phone = document.getElementById("debtor-phone").value.trim();
    if (!name) { toast("Укажите имя клиента", "error"); return; }
    document.getElementById("debtor-modal").close();
    debtorModalResolve?.({ name, phone });
    debtorModalResolve = null;
  });
}

async function checkout() {
  const discount = +document.getElementById("cart-discount").value || 0;
  const warehouse_id = +document.getElementById("pos-warehouse").value;
  const total = cartTotalDue();
  const saleCur = posSaleCurrency();
  const payCur = posPayCurrency();
  const fxOn = !!document.getElementById("pos-fx-enable")?.checked && payCur !== saleCur;
  try {
    const paymentsRaw = collectSplitPayments();
    if (fxOn) {
      const rate = posFxRateSaleToPay();
      if (rate == null || rate <= 0) {
        toast(`Укажите курс 1 ${saleCur} → ${payCur}`, "error");
        return;
      }
    }
    let paidSale = 0;
    for (const p of paymentsRaw) {
      const conv = posConvertToSale(p.amount, p.currency_code || saleCur);
      if (conv == null) {
        toast("Не удалось пересчитать оплату по курсу", "error");
        return;
      }
      paidSale += conv;
    }
    if (paidSale <= 0 && total > 0) { toast("Укажите суммы оплаты", "error"); return; }
    let debtor_name = "";
    let debtor_phone = "";
    if (total - paidSale > 0.01) {
      const debtor = await promptDebtorModal(total, paidSale, saleCur);
      if (!debtor) return;
      debtor_name = debtor.name;
      debtor_phone = debtor.phone;
    } else if (Math.abs(total - paidSale) > 0.01) {
      toast("Сумма оплат не совпадает с итогом", "error");
      return;
    }
    const fxRate = fxOn ? posFxRateSaleToPay() : null;
    const payload = {
      items: cart.map((c) => ({
        product_id: c.product_id,
        quantity: c.quantity,
        unit_price: lineUnitPrice(c),
        unit_ids: c.unit_ids || [],
        units: (c.unit_metas || []).map((m) => ({
          unit_id: m.unit_id,
          imei: m.imei || "",
          activate_later: m.activate_later || 0,
          customs_cleared: m.customs_cleared || 0,
          customs_price: m.customs_price || 0,
        })),
      })),
      discount,
      payments: paymentsRaw,
      warehouse_id,
      debtor_name,
      debtor_phone,
      pay_currency: fxOn ? payCur : "",
      fx_rate: fxRate || undefined,
    };
    let sale;
    try {
      sale = await api("/api/sales", { method: "POST", body: JSON.stringify(payload) });
    } catch (e) {
      if (isNetworkError(e)) {
        enqueueOfflineSale(payload);
        cart = [];
        document.getElementById("cart-discount").value = "0";
        const fx = document.getElementById("pos-fx-enable");
        if (fx) fx.checked = false;
        renderCart();
        updateTopbar();
        toast("Продажа сохранена офлайн — отправится при связи");
        return;
      }
      throw e;
    }
    cart = [];
    document.getElementById("cart-discount").value = "0";
    const fx = document.getElementById("pos-fx-enable");
    if (fx) fx.checked = false;
    const rateInp = document.getElementById("pos-fx-rate");
    if (rateInp) rateInp.dataset.manual = "0";
    renderCart();
    await loadProducts();
    await refreshSession();
    showReceipt(sale);
    loadPosCashRegister();
    if (total - paidSale > 0.01) loadDebtorsPage();
    toast("Продажа проведена");
  } catch (e) { toast(e.message, "error"); }
}

function printReceiptHtml(html) {
  const w = window.open("", "_blank");
  if (!w) return;
  w.document.write(`<html><head><title>Чек</title><style>
    body{font-family:Arial,sans-serif;max-width:320px;margin:24px auto;font-size:14px}
    .rt{text-align:center;font-weight:700;font-size:1.1rem;margin-bottom:.5rem}
    .receipt-meta{text-align:center;color:#555;font-size:.85rem}
    .receipt-line{display:flex;justify-content:space-between;gap:8px;margin:.35rem 0}
    .receipt-total{text-align:right;font-weight:700;font-size:1.1rem;margin:.75rem 0}
    .receipt-payments{margin-top:.5rem;border-top:1px dashed #ccc;padding-top:.5rem}
    .receipt-pay-row{display:flex;justify-content:space-between;margin:.2rem 0}
    hr{border:none;border-top:1px solid #ddd;margin:.75rem 0}
  </style></head><body>${html}</body></html>`);
  w.document.close();
  w.print();
}

function showReceipt(sale) {
  document.getElementById("receipt-content").innerHTML = renderReceiptHtml(sale);
  document.getElementById("receipt-modal").showModal();
}
el("receipt-close")?.addEventListener("click", () => el("receipt-modal")?.close());
el("receipt-print")?.addEventListener("click", () => {
  printReceiptHtml(el("receipt-content")?.innerHTML || "");
});

/* ── Sales ── */
function bindSales() {
  document.getElementById("refresh-sales").onclick = loadSales;
  ["sales-from", "sales-to", "sales-ownership", "sales-warehouse"].forEach((id) => {
    document.getElementById(id).addEventListener("change", loadSales);
  });
  document.getElementById("sales-search")?.addEventListener("input", debounce(loadSales, 320));
  document.getElementById("sale-detail-close").onclick = () => document.getElementById("sale-detail-modal").close();
  document.getElementById("sale-detail-print").onclick = () => {
    if (lastSaleDetail) printReceiptHtml(renderReceiptHtml(lastSaleDetail));
  };
  document.getElementById("sales-download-template")?.addEventListener("click", downloadSalesImportTemplate);
  document.getElementById("sales-import-file")?.addEventListener("change", onSalesImportFileSelected);
  document.getElementById("sales-import-form")?.addEventListener("submit", submitSalesImport);
  document.getElementById("sales-toggle-all-detail")?.addEventListener("click", toggleAllSalesDetail);
}

let salesImportFile = null;
let salesAllExpanded = false;

function onSalesImportFileSelected(e) {
  salesImportFile = e.target.files?.[0] || null;
  const nameEl = document.getElementById("sales-import-filename");
  const submitBtn = document.getElementById("sales-import-submit");
  if (nameEl) nameEl.textContent = salesImportFile ? salesImportFile.name : "Файл не выбран";
  if (submitBtn) submitBtn.disabled = !salesImportFile;
}

async function downloadSalesImportTemplate() {
  try {
    const headers = {};
    if (pin) headers["X-Pin"] = pin;
    const res = await fetch("/api/import/sales/template", { headers });
    if (res.status === 401) {
      pin = "";
      localStorage.removeItem(PIN_KEY);
      showLogin();
      throw new Error("Неверный PIN — войдите снова");
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(typeof err.detail === "string" ? err.detail : "Не удалось скачать шаблон");
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "telestore_sales_import.xlsx";
    a.click();
    URL.revokeObjectURL(url);
    toast("Шаблон продаж скачан");
  } catch (err) {
    toast(err.message, "error");
  }
}

async function submitSalesImport(e) {
  e.preventDefault();
  if (!salesImportFile) {
    toast("Выберите файл Excel или CSV", "error");
    return;
  }
  const resultEl = document.getElementById("sales-import-result");
  const submitBtn = document.getElementById("sales-import-submit");
  if (submitBtn) submitBtn.disabled = true;
  try {
    const headers = {};
    if (pin) headers["X-Pin"] = pin;
    const fd = new FormData();
    fd.append("file", salesImportFile);
    const res = await fetch("/api/import/sales", { method: "POST", headers, body: fd });
    if (res.status === 401) {
      pin = "";
      localStorage.removeItem(PIN_KEY);
      showLogin();
      throw new Error("Неверный PIN — войдите снова");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(typeof data.detail === "string" ? data.detail : "Ошибка импорта");
    }
    const errLines = (data.errors || []).slice(0, 8);
    const more = (data.errors || []).length > 8 ? `<br>…и ещё ${data.errors.length - 8}` : "";
    if (resultEl) {
      resultEl.classList.remove("hidden", "has-errors");
      resultEl.innerHTML = `
        <strong>Импорт завершён</strong><br>
        Чеков: ${data.created_sales || 0} · Позиций: ${data.created_lines || 0}
        ${errLines.length ? `<br><span style="color:var(--danger)">Предупреждения:<br>${errLines.map(esc).join("<br>")}${more}</span>` : ""}`;
      if (!errLines.length) resultEl.classList.remove("has-errors");
      else resultEl.classList.add("has-errors");
    }
    toast(`Импорт: ${data.created_sales || 0} продаж`);
    salesImportFile = null;
    const fileInput = document.getElementById("sales-import-file");
    if (fileInput) fileInput.value = "";
    onSalesImportFileSelected({ target: { files: [] } });
    loadSales();
    if (currentPage === "dashboard") loadDashboard();
    if (currentPage === "analytics") loadAnalytics();
  } catch (err) {
    toast(err.message, "error");
    if (resultEl) {
      resultEl.classList.remove("hidden");
      resultEl.classList.add("has-errors");
      resultEl.textContent = err.message;
    }
  } finally {
    if (submitBtn) submitBtn.disabled = !salesImportFile;
  }
}

function renderSaleItemsBlock(sale) {
  const meta = `${sale.created_at || ""}${sale.user_name ? ` · ${esc(sale.user_name)}` : ""}`;
  const rows = (sale.items || []).map((i) => `<tr>
      <td>${esc(i.product_name)}</td>
      <td style="font-size:.8rem">${i.units?.length ? i.units.map((u) => esc(u.imei || u.serial || "—") + (u.imei_pending ? " ⏳" : "")).join("<br>") : "—"}</td>
      <td><span class="tag tag-${i.ownership_type === "consignment" ? "cons" : "own"}">${ownLabel(i.ownership_type)}</span>${i.ownership_type === "consignment" && i.supplier_name ? `<br><span class="muted" style="font-size:.75rem">${esc(i.supplier_name)}</span>` : ""}</td>
      <td>${i.quantity}</td><td>${saleFmt(sale, i.subtotal)}</td>
      <td>${i.ownership_type === "consignment" && i.supplier_due ? `${saleFmt(sale, i.supplier_due)} <span class="muted" style="font-size:.75rem">пост.</span>` : saleFmt(sale, i.shop_profit)}</td>
    </tr>`).join("");
  return `
    <p class="sale-detail-meta">${meta}</p>
    <table class="data-table sale-detail-table"><thead><tr><th>Товар</th><th>IMEI</th><th>Тип</th><th>Кол-во</th><th>Сумма</th><th>Прибыль / пост.</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="6" style="text-align:center;color:var(--muted)">Нет позиций</td></tr>'}</tbody></table>
    <div class="sale-detail-total">Итого: ${saleFmt(sale, sale.total)}</div>`;
}

function collapseAllSalesDetails() {
  document.querySelectorAll(".sale-detail-row").forEach((el) => el.remove());
  document.querySelectorAll(".sale-row-open").forEach((el) => el.classList.remove("sale-row-open"));
  salesAllExpanded = false;
  const btn = document.getElementById("sales-toggle-all-detail");
  if (btn && btn.textContent === "Свернуть") btn.textContent = "Детализация";
}

async function toggleAllSalesDetail() {
  const btn = document.getElementById("sales-toggle-all-detail");
  if (!btn) return;
  if (salesAllExpanded) {
    collapseAllSalesDetails();
    return;
  }
  const rows = [...document.querySelectorAll("#sales-tbody tr.sale-row")];
  if (!rows.length) return;
  btn.disabled = true;
  const prevText = btn.textContent;
  btn.textContent = "Загрузка…";
  try {
    const sales = await Promise.all(rows.map((r) => api(`/api/sales/${r.dataset.saleId}`)));
    rows.forEach((row, i) => {
      const sale = sales[i];
      const detailRow = document.createElement("tr");
      detailRow.className = "sale-detail-row";
      detailRow.dataset.detailFor = String(sale.id);
      detailRow.innerHTML = `<td colspan="8"><div class="sale-inline-detail">${renderSaleItemsBlock(sale)}</div></td>`;
      row.after(detailRow);
      row.classList.add("sale-row-open");
    });
    salesAllExpanded = true;
    btn.textContent = "Свернуть";
  } catch (e) {
    toast(e.message, "error");
    collapseAllSalesDetails();
    btn.textContent = prevText;
  } finally {
    btn.disabled = false;
  }
}

async function loadSales() {
  if (!warehouses.length) await loadWarehouses();
  const whSel = document.getElementById("sales-warehouse");
  if (whSel && !whSel.dataset.ready) {
    const cur = whSel.value;
    whSel.innerHTML = '<option value="">Все склады</option>' +
      phoneWarehouses().map((w) => `<option value="${w.id}">${esc(w.name)}</option>`).join("");
    if (cur) whSel.value = cur;
    whSel.dataset.ready = "1";
  }
  const from = document.getElementById("sales-from").value;
  const to = document.getElementById("sales-to").value;
  const own = document.getElementById("sales-ownership").value;
  const wh = document.getElementById("sales-warehouse")?.value || "";
  const search = document.getElementById("sales-search")?.value?.trim() || "";
  let url = `/api/sales?limit=200`;
  if (from) url += `&date_from=${encodeURIComponent(from)}`;
  if (to) url += `&date_to=${encodeURIComponent(to)}`;
  if (own) url += `&ownership_type=${encodeURIComponent(own)}`;
  if (wh) url += `&warehouse_id=${encodeURIComponent(wh)}`;
  if (search) url += `&q=${encodeURIComponent(search)}`;
  const data = await api(url);
  const tb = document.getElementById("sales-tbody");
  const detailBtn = document.getElementById("sales-toggle-all-detail");
  const isOwner = !currentUser || currentUser.role === "owner";
  salesAllExpanded = false;
  if (detailBtn) detailBtn.textContent = "Детализация";
  const countHint = data.total != null ? ` · найдено ${data.total}` : "";
  if (!data.items.length) {
    tb.innerHTML = `<tr><td colspan="8" style="text-align:center;color:var(--muted)">Нет продаж${countHint}</td></tr>`;
    if (detailBtn) detailBtn.disabled = true;
    return;
  }
  if (detailBtn) detailBtn.disabled = false;
  tb.innerHTML = data.items.map((s) => {
    const debt = s.amount_due > 0.01
      ? `<span class="tag tag-cons" title="${esc(s.debtor_name || "")}">${saleFmt(s, s.amount_due)}</span>`
      : "—";
    const returnBtn = isOwner
      ? `<button class="btn btn-ghost btn-sm" style="color:var(--danger)" onclick="returnSale(${s.id})" title="Возврат на склад">↩</button>`
      : "";
    return `
    <tr class="sale-row" data-sale-id="${s.id}">
      <td><strong>#${s.id}</strong></td>
      <td>${s.created_at?.slice(0, 10) || s.created_at}</td>
      <td>${esc(s.warehouse_name || "—")}</td>
      <td>${esc(s.user_name || "—")}</td>
      <td><strong>${saleFmt(s, s.total)}</strong></td>
      <td style="font-size:.85rem">${formatPaySummary(s)}</td>
      <td>${debt}</td>
      <td class="sales-actions">
        <button class="btn btn-ghost btn-sm" onclick="showSale(${s.id})">Детали</button>
        <button class="btn btn-ghost btn-sm" onclick="printSaleReceipt(${s.id})">Чек</button>
        ${returnBtn}
      </td>
    </tr>`;
  }).join("");
}

window.printSaleReceipt = async (id) => {
  try {
    const sale = await api(`/api/sales/${id}`);
    printReceiptHtml(renderReceiptHtml(sale));
  } catch (e) { toast(e.message, "error"); }
};

window.showSale = async (id) => {
  const sale = await api(`/api/sales/${id}`);
  lastSaleDetail = sale;
  const isOwner = !currentUser || currentUser.role === "owner";
  const payHtml = sale.payments?.length
    ? `<div class="card" style="margin-top:1rem"><div class="card-header"><h3>Оплата</h3></div><div class="card-body">${sale.payments.map((p) =>
        `<div class="metric-row"><span>${payLabel(p.method_code)}</span><strong>${saleFmt(sale, p.amount)}</strong></div>`
      ).join("")}</div></div>`
    : `<p style="color:var(--muted)">${payLabel(sale.payment_method)} · ${saleFmt(sale, sale.total)}</p>`;
  const unitsExtra = sale.items.flatMap((i) => (i.units || []).filter((u) => u.customs_cleared || u.imei_pending)).length
    ? `<div class="card" style="margin-top:1rem"><div class="card-header"><h3>Устройства</h3></div><div class="card-body">${sale.items.flatMap((i) => (i.units || []).map((u) =>
        `<div class="metric-row"><span>${esc(u.imei || u.serial || "—")}</span><span>${u.customs_cleared ? `Таможня ${saleFmt(sale, u.customs_price)}` : ""}${u.imei_pending ? " · IMEI позже" : ""}</span></div>`
      )).join("")}</div></div>` : "";
  const rec = sale.receivable;
  const debtorHtml = rec && rec.status === "open" && rec.amount_due > 0.01
    ? `<div class="card" style="margin-top:1rem;border-color:var(--warning)"><div class="card-header"><h3>Дебиторка</h3></div><div class="card-body">
        <div class="metric-row"><span>${esc(rec.customer_name)}</span><strong>Долг ${saleFmt(sale, rec.amount_due)}</strong></div>
        <button type="button" class="btn btn-secondary btn-sm" onclick="document.getElementById('sale-detail-modal').close();navigate('debtors');openDebtorPayModal(${rec.id})">Принять оплату</button>
      </div></div>`
    : "";
  const creditorHtml = sale.supplier_due_total > 0
    ? `<div class="card" style="margin-top:1rem"><div class="card-header"><h3>Кредиторка</h3></div><div class="card-body">
        <div class="metric-row"><span>Поставщикам к выплате</span><strong>${saleFmt(sale, sale.supplier_due_total)}</strong></div>
        <p class="muted" style="font-size:.8rem;margin:.5rem 0 0">${(sale.supplier_names || []).map(esc).join(", ")}</p>
        ${isOwner ? `<button type="button" class="btn btn-secondary btn-sm" style="margin-top:.5rem" onclick="document.getElementById('sale-detail-modal').close();navigate('creditors')">Открыть кредиторку</button>` : ""}
      </div></div>`
    : "";
  document.getElementById("sale-detail-content").innerHTML = `
    <h3>Продажа #${sale.id}</h3>
    ${renderSaleItemsBlock(sale)}
    ${unitsExtra}
    ${payHtml}
    ${debtorHtml}
    ${creditorHtml}
    ${isOwner ? `<button class="btn btn-danger" style="margin-top:1rem" onclick="returnSale(${id})">↩ Возврат (товар на склад)</button>` : ""}`;
  document.getElementById("sale-detail-modal").showModal();
};

window.returnSale = async (id) => {
  if (!confirm("Оформить возврат? Товар вернётся на тот же склад, с которого продали. Долг клиента закроется.")) return;
  try {
    const res = await api(`/api/sales/${id}/void`, { method: "POST" });
    document.getElementById("sale-detail-modal")?.close();
    toast(res?.return_to_bu ? "Возврат: телефон на складе Б/У" : "Возврат оформлен");
    loadSales();
    if (currentPage === "debtors") loadDebtorsPage();
    if (currentPage === "creditors") loadCreditorsPage();
    if (currentPage === "dashboard") loadDashboard();
  } catch (e) { toast(e.message, "error"); }
};

window.voidSale = window.returnSale;

/* ── Catalog ── */
function bindCatalog() {
  ["catalog-search", "catalog-category", "catalog-ownership", "catalog-color", "catalog-sort"].forEach((id) => {
    const node = document.getElementById(id);
    node?.addEventListener(id === "catalog-search" ? "input" : "change", debounce(loadCatalog, 280));
  });
  loadCatalogColors();
  document.getElementById("catalog-detail-close")?.addEventListener("click", () => {
    document.getElementById("catalog-detail-modal").close();
  });
  document.getElementById("catalog-detail-edit")?.addEventListener("click", () => {
    document.getElementById("catalog-detail-modal").close();
    if (catalogDetailId) editProduct(catalogDetailId);
  });
}

async function loadCatalogColors() {
  const sel = document.getElementById("catalog-color");
  if (!sel) return;
  const cur = sel.value;
  try {
    const colors = await api("/api/products/meta/colors");
    sel.innerHTML = '<option value="">Все цвета</option>' +
      colors.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("");
    if (cur && colors.includes(cur)) sel.value = cur;
  } catch {
    /* ignore */
  }
}

async function loadCatalog() {
  const q = document.getElementById("catalog-search")?.value || "";
  const cat = document.getElementById("catalog-category")?.value || "";
  const own = document.getElementById("catalog-ownership")?.value || "";
  const color = document.getElementById("catalog-color")?.value || "";
  const sort = document.getElementById("catalog-sort")?.value || "name";
  let url = `/api/products?q=${encodeURIComponent(q)}`;
  if (cat) url += `&category=${cat}`;
  if (own) url += `&ownership_type=${own}`;
  if (color) url += `&color=${encodeURIComponent(color)}`;
  catalogProducts = await api(url);
  const items = sortCatalogItems(catalogProducts, sort);
  const grid = document.getElementById("catalog-grid");
  const empty = document.getElementById("catalog-empty");
  const stats = document.getElementById("catalog-stats");
  const phones = items.filter((p) => p.category === "phone").length;
  const acc = items.filter((p) => p.category === "accessory").length;
  const inStock = items.filter((p) => p.stock > 0).length;
  stats.textContent = `${items.length} позиций · ${phones} телефонов · ${acc} аксессуаров · ${inStock} в наличии`;

  if (!items.length) {
    grid.innerHTML = "";
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");
  grid.innerHTML = items.map((p, i) => `
    <article class="catalog-card" style="animation-delay:${Math.min(i * 0.04, 0.4)}s" onclick="openCatalogDetail(${p.id})">
      <div style="position:relative">
        ${renderProductVisual(p)}
        <div class="catalog-card-badges">
          <span class="tag tag-${p.ownership_type === "consignment" ? "cons" : "own"}">${ownLabel(p.ownership_type)}</span>
          <span class="tag tag-${p.category}">${catLabel(p.category)}</span>
          ${p.track_units ? '<span class="tag tag-phone">IMEI</span>' : ""}
        </div>
      </div>
      <div class="catalog-card-body">
        <div class="catalog-card-title">${esc(productCatalogTitle(p))}</div>
        <div class="catalog-card-meta">${esc(p.brand || "—")}${p.model && !productCatalogTitle(p).toLocaleLowerCase("ru").includes(String(p.model).toLocaleLowerCase("ru")) ? ` · ${esc(p.model)}` : ""}${p.sku ? ` · ${esc(p.sku)}` : ""}</div>
        <div class="catalog-card-specs">${productSpecChips(p) || `<span class="spec-chip">${conditionLabel(p.condition)}</span>`}</div>
        <div class="catalog-card-footer">
          <div class="catalog-card-price">${fmt(p.sale_price)}</div>
          <span class="catalog-card-stock ${stockBadgeClass(p)}">${stockBadgeText(p)}</span>
        </div>
      </div>
    </article>`).join("");
}

window.openCatalogDetail = async (id) => {
  catalogDetailId = id;
  let p = catalogProducts.find((x) => x.id === id);
  if (!p) p = await api(`/api/products/${id}`);
  const whRows = Object.entries(p.stock_by_warehouse || {})
    .map(([wid, qty]) => {
      const w = warehouses.find((x) => x.id === +wid);
      return `<div class="catalog-detail-spec"><span>Склад</span><strong>${esc(w?.name || `#${wid}`)}: ${qty} шт.</strong></div>`;
    }).join("");
  const specs = [
    ["Модель", p.model], ["Цвет", p.color], ["Память", p.memory], ["RAM", p.ram],
    ["Размер", p.size], ["Состояние", conditionLabel(p.condition)],
    ["Артикул", p.sku], ["Штрихкод", p.barcode], ["Бренд", p.brand],
    ["Закупка", fmt(p.purchase_price)], ["Маржа", fmt(p.sale_price - p.purchase_price)],
    ["Таможня", p.customs_cleared ? `✓ ${fmt(p.customs_price)}` : "—"],
  ].filter(([, v]) => v && v !== "—" && v !== "0 ₽")
    .map(([k, v]) => `<div class="catalog-detail-spec"><span>${k}</span><strong>${typeof v === "string" && v.includes("₽") ? v : esc(String(v))}</strong></div>`)
    .join("");

  document.getElementById("catalog-detail-content").innerHTML = `
    <div class="catalog-detail-visual">${renderProductVisual(p, "detail")}</div>
    <div class="catalog-detail-info">
      <div style="display:flex;flex-wrap:wrap;gap:.35rem;margin-bottom:.5rem">
        <span class="tag tag-${p.ownership_type === "consignment" ? "cons" : "own"}">${ownLabel(p.ownership_type)}</span>
        <span class="tag tag-${p.category}">${catLabel(p.category)}</span>
        ${p.track_units ? '<span class="tag tag-phone">Учёт IMEI</span>' : ""}
      </div>
      <h3>${esc(productCatalogTitle(p))}</h3>
      <div class="catalog-detail-brand">${esc(p.brand || "")}${p.supplier_name ? ` · ${esc(p.supplier_name)}` : ""}</div>
      <div class="catalog-detail-price">${fmt(p.sale_price)}</div>
      <span class="catalog-card-stock ${stockBadgeClass(p)}">${stockBadgeText(p)}</span>
      <div class="catalog-detail-specs">${specs}${whRows}</div>
      ${p.specs_extra ? `<div class="catalog-detail-extra">${esc(p.specs_extra)}</div>` : ""}
    </div>`;
  document.getElementById("catalog-detail-modal").showModal();
};

/* ── Warehouses ── */
let inboundMode = "new";
let inboundExistingProduct = null;

function bindWarehouses() {
  document.getElementById("warehouse-cancel").onclick = () => document.getElementById("warehouse-modal").close();
  document.getElementById("warehouse-form").onsubmit = saveWarehouse;
  document.getElementById("stock-move-cancel").onclick = () => document.getElementById("stock-move-modal").close();
  document.getElementById("stock-move-form").onsubmit = submitStockMove;
  document.getElementById("wh-btn-inbound").onclick = () => openInboundModal();
  document.getElementById("wh-btn-outbound").onclick = () => openStockMoveModal("outbound");
  document.getElementById("wh-btn-transfer").onclick = () => openStockMoveModal("transfer");
  document.getElementById("inbound-cancel")?.addEventListener("click", () => document.getElementById("inbound-modal").close());
  document.getElementById("inbound-form")?.addEventListener("submit", submitInboundReceipt);
  document.querySelectorAll("#inbound-mode-tabs .seg").forEach((b) => {
    b.addEventListener("click", () => {
      document.querySelectorAll("#inbound-mode-tabs .seg").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      inboundMode = b.dataset.inboundMode;
      document.getElementById("inbound-panel-new").classList.toggle("hidden", inboundMode !== "new");
      document.getElementById("inbound-panel-existing").classList.toggle("hidden", inboundMode !== "existing");
      updateInboundFields();
    });
  });
  ["ib-category", "ib-condition", "ib-ownership"].forEach((id) => {
    document.getElementById(id)?.addEventListener("change", updateInboundFields);
  });
  document.getElementById("ib-existing-product")?.addEventListener("change", onInboundExistingSelect);
  document.getElementById("wh-show-total").onclick = () => showAllWarehousesStock();
  document.getElementById("wh-detail-back")?.addEventListener("click", closeWhDetailModal);
  document.getElementById("wh-detail-close")?.addEventListener("click", closeWhDetailModal);
  document.getElementById("wh-detail-search")?.addEventListener("input", debounce(() => applyWhDetailSearch(), 160));
  document.getElementById("wh-refresh-movements").onclick = loadWarehouseMovements;
  document.getElementById("transfer-doc-close").onclick = () => document.getElementById("transfer-doc-modal").close();
  document.getElementById("transfer-doc-print").onclick = () => printTransferDocument();
  document.getElementById("wh-download-template")?.addEventListener("click", downloadImportTemplate);
  document.getElementById("wh-import-file")?.addEventListener("change", onImportFileSelected);
  document.getElementById("wh-import-form")?.addEventListener("submit", submitProductsImport);
  document.querySelectorAll("#wh-main-tabs .seg").forEach((b) => {
    b.addEventListener("click", () => {
      document.querySelectorAll("#wh-main-tabs .seg").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      whViewMode = b.dataset.whView;
      loadWarehouseStock();
    });
  });
  document.getElementById("wh-sell-cancel")?.addEventListener("click", () => document.getElementById("wh-sell-modal").close());
  document.getElementById("wh-sell-form")?.addEventListener("submit", submitWhSell);
  document.getElementById("wh-sell-price")?.addEventListener("input", updateWhSellProfit);
  document.getElementById("wh-sell-paid")?.addEventListener("input", updateWhSellProfit);
}

async function loadWarehousesPage() {
  if (!warehouses.length) await loadWarehouses();
  selectedWarehouseId = null;
  whStockViewTotal = false;
  renderWarehouseList();
  populateImportWarehouseSelect();
  await loadWarehouseMovements();
}

window.showAllWarehousesStock = async () => {
  whStockViewTotal = true;
  selectedWarehouseId = null;
  whViewMode = "stock";
  renderWarehouseList();
  await loadWarehouseStock();
  openWhDetailModal();
};

function openWhDetailModal() {
  const search = document.getElementById("wh-detail-search");
  if (search) search.value = "";
  const modal = document.getElementById("wh-detail-modal");
  modal?.showModal();
  const wrap = document.getElementById("wh-stock-table-wrap");
  if (wrap) wrap.scrollLeft = 0;
  requestAnimationFrame(() => search?.focus());
}
function closeWhDetailModal() {
  document.getElementById("wh-detail-modal")?.close();
}

function applyWhDetailSearch() {
  const q = (document.getElementById("wh-detail-search")?.value || "").trim().toLowerCase();
  const digits = q.replace(/\D/g, "");
  const matchText = (text) => {
    const t = String(text || "").toLowerCase();
    if (!q) return true;
    if (t.includes(q)) return true;
    if (digits.length >= 3) {
      const td = t.replace(/\D/g, "");
      if (td.includes(digits)) return true;
    }
    return false;
  };
  // Stock / summary table
  document.querySelectorAll("#wh-stock-tbody tr").forEach((tr) => {
    tr.style.display = matchText(tr.textContent) ? "" : "none";
  });
  // Z-report / full Excel tables (all sections)
  document.querySelectorAll("#wh-z-report tbody tr, #wh-z-content tbody tr").forEach((tr) => {
    tr.style.display = matchText(tr.textContent) ? "" : "none";
  });
  // Keep horizontal scroll at start so first columns stay visible
  const wrap = document.getElementById("wh-stock-table-wrap");
  if (wrap && !q) wrap.scrollLeft = 0;
}

function populateImportWarehouseSelect() {
  const sel = document.getElementById("wh-import-warehouse");
  if (!sel) return;
  const pickId = selectedWarehouseId || defaultWarehouseId();
  sel.innerHTML = phoneWarehouses().map((w) =>
    `<option value="${w.id}"${w.id === pickId ? " selected" : ""}>${esc(w.name)}</option>`
  ).join("");
}

let importSelectedFile = null;

function onImportFileSelected(e) {
  importSelectedFile = e.target.files?.[0] || null;
  const nameEl = document.getElementById("wh-import-filename");
  const submitBtn = document.getElementById("wh-import-submit");
  if (nameEl) nameEl.textContent = importSelectedFile ? importSelectedFile.name : "Файл не выбран";
  if (submitBtn) submitBtn.disabled = !importSelectedFile;
}

async function downloadImportTemplate() {
  try {
    const whId = document.getElementById("wh-import-warehouse")?.value || selectedWarehouseId || "";
    const headers = {};
    if (pin) headers["X-Pin"] = pin;
    const qs = whId ? `?warehouse_id=${encodeURIComponent(whId)}` : "";
    const res = await fetch(`/api/import/products/template${qs}`, { headers });
    if (res.status === 401) {
      pin = "";
      localStorage.removeItem(PIN_KEY);
      showLogin();
      throw new Error("Неверный PIN — войдите снова");
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(typeof err.detail === "string" ? err.detail : "Не удалось скачать шаблон");
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "telestore_import.xlsx";
    a.click();
    URL.revokeObjectURL(url);
    toast("Шаблон скачан");
  } catch (err) {
    toast(err.message, "error");
  }
}

async function submitProductsImport(e) {
  e.preventDefault();
  if (!importSelectedFile) {
    toast("Выберите файл Excel или CSV", "error");
    return;
  }
  const whId = document.getElementById("wh-import-warehouse")?.value;
  const resultEl = document.getElementById("wh-import-result");
  const submitBtn = document.getElementById("wh-import-submit");
  if (submitBtn) submitBtn.disabled = true;
  try {
    const headers = {};
    if (pin) headers["X-Pin"] = pin;
    const fd = new FormData();
    fd.append("file", importSelectedFile);
    const qs = whId ? `?warehouse_id=${encodeURIComponent(whId)}` : "";
    const res = await fetch(`/api/import/products${qs}`, { method: "POST", headers, body: fd });
    if (res.status === 401) {
      pin = "";
      localStorage.removeItem(PIN_KEY);
      showLogin();
      throw new Error("Неверный PIN — войдите снова");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(typeof data.detail === "string" ? data.detail : "Ошибка импорта");
    }
    const errLines = (data.errors || []).slice(0, 8);
    const more = (data.errors || []).length > 8 ? `<br>…и ещё ${data.errors.length - 8}` : "";
    if (resultEl) {
      resultEl.classList.remove("hidden", "has-errors");
      resultEl.innerHTML = `
        <strong>Импорт завершён</strong><br>
        Новых товаров: ${data.created_products || 0} · Устройств: ${data.created_units || 0} · Добавлено на склад: ${data.stock_added || 0}
        ${errLines.length ? `<br><span style="color:var(--danger)">Предупреждения:<br>${errLines.map(esc).join("<br>")}${more}</span>` : ""}`;
      if (!errLines.length) resultEl.classList.remove("has-errors");
      else resultEl.classList.add("has-errors");
    }
    toast(`Импорт: +${data.created_products || 0} товаров, +${data.stock_added || 0} на склад`);
    importSelectedFile = null;
    const fileInput = document.getElementById("wh-import-file");
    if (fileInput) fileInput.value = "";
    onImportFileSelected({ target: { files: [] } });
    await loadWarehouses();
    products = [];
    if (currentPage === "warehouses") {
      renderWarehouseList();
      await loadWarehouseStock();
    }
  } catch (err) {
    toast(err.message, "error");
    if (resultEl) {
      resultEl.classList.remove("hidden");
      resultEl.classList.add("has-errors");
      resultEl.textContent = err.message;
    }
  } finally {
    if (submitBtn) submitBtn.disabled = !importSelectedFile;
  }
}

function renderWarehouseList() {
  const tb = document.getElementById("wh-list-tbody");
  tb.innerHTML = phoneWarehouses().map((w) => `
    <tr class="wh-row${!whStockViewTotal && w.id === selectedWarehouseId ? " wh-row-active" : ""}" data-id="${w.id}" onclick="selectWarehouse(${w.id})">
      <td><strong>${esc(w.name)}</strong>${w.is_default ? ' <span class="tag tag-own" style="font-size:.6rem">по умолч.</span>' : ""}</td>
      <td>${dash(w.address)}</td>
      <td>${esc((w.currency?.code || w.currency_code || "—"))}</td>
      <td onclick="event.stopPropagation()">
        <button class="btn btn-ghost btn-sm" onclick="editWarehouse(${w.id})">✎</button>
        <button class="btn btn-danger" onclick="deleteWarehouse(${w.id})">✕</button>
      </td>
    </tr>`).join("") || '<tr><td colspan="4" style="text-align:center;color:var(--muted)">Нет складов</td></tr>';
}

window.selectWarehouse = async (id) => {
  selectedWarehouseId = id;
  whStockViewTotal = false;
  whViewMode = "stock";
  document.querySelectorAll("#wh-main-tabs .seg").forEach((x) => x.classList.toggle("active", x.dataset.whView === "stock"));
  renderWarehouseList();
  openWhDetailModal();
  await loadWarehouseStock();
};

function renderWhStockTotals(totals) {
  const el = document.getElementById("wh-stock-totals");
  if (!el) return;
  if (!totals || (totals.value == null && !totals.value_usd && !totals.value_tjs)) {
    el.classList.add("hidden");
    el.innerHTML = "";
    return;
  }
  const usd = currency_meta("USD");
  const tjs = currency_meta("TJS");
  const count = (totals.units_count || 0) + (totals.qty_items || 0);
  el.innerHTML = `
    <div class="wst-label">Итого остаток на складе${count ? ` · ${count} шт.` : ""}</div>
    <div class="wst-item"><strong>${fmtCurrency(totals.value_usd ?? 0, usd)}</strong><span>в долларах</span></div>
    <div class="wst-item"><strong>${fmtCurrency(totals.value_tjs ?? 0, tjs)}</strong><span>в сомони</span></div>
    ${totals.currency_code && totals.currency_code !== "USD" && totals.currency_code !== "TJS"
      ? `<div class="wst-item"><strong>${fmtCurrency(totals.value ?? 0, totals.currency || currency_meta(totals.currency_code))}</strong><span>валюта склада</span></div>`
      : ""}`;
  el.classList.remove("hidden");
}

function hideWhStockTotals() {
  const el = document.getElementById("wh-stock-totals");
  if (!el) return;
  el.classList.add("hidden");
  el.innerHTML = "";
}

async function loadWarehouseStock() {
  const tb = document.getElementById("wh-stock-tbody");
  const title = document.getElementById("wh-stock-title");
  const thead = document.getElementById("wh-stock-thead");
  const tableWrap = document.getElementById("wh-stock-table-wrap");
  const zEl = document.getElementById("wh-z-report");
  const tabs = document.getElementById("wh-main-tabs");
  const hasWh = selectedWarehouseId && !whStockViewTotal;
  document.getElementById("wh-btn-inbound").disabled = !hasWh;
  document.getElementById("wh-btn-outbound").disabled = !hasWh;
  document.getElementById("wh-btn-transfer").disabled = !hasWh;

  if (whStockViewTotal) {
    title.textContent = "Сводка по всем складам";
    tabs?.classList.add("hidden");
    zEl?.classList.add("hidden");
    tableWrap?.classList.remove("hidden");
    if (thead) thead.innerHTML = "<tr><th>Модель</th><th>Цвет</th><th>Кол-во</th><th>Себест.</th></tr>";
    const items = await api("/api/stock/total");
    tb.innerHTML = items.map((p) => `
      <tr>
        <td><strong>${esc(p.name)}</strong></td>
        <td>${dash(p.color)}</td>
        <td><strong>${p.stock}</strong></td>
        <td>${fmt(p.purchase_price)}</td>
      </tr>`).join("") || '<tr><td colspan="4" style="text-align:center;color:var(--muted)">Нет остатков</td></tr>';
    try {
      const funds = await api("/api/reports/funds");
      renderWhStockTotals({
        value_usd: funds.totals?.stock_usd,
        value_tjs: funds.totals?.stock_tjs,
        units_count: (funds.warehouses || []).reduce((s, w) => s + (w.units_count || 0), 0),
        qty_items: (funds.warehouses || []).reduce((s, w) => s + (w.qty_items || 0), 0),
        currency_code: "USD",
      });
    } catch {
      hideWhStockTotals();
    }
    applyWhDetailSearch();
    return;
  }

  const wh = warehouses.find((w) => w.id === selectedWarehouseId);
  const kind = warehouseKind(selectedWarehouseId);
  const curTag = wh?.currency?.code === "USD" ? " $" : " смн";
  title.textContent = wh ? `${wh.name} · ${wh.currency?.symbol || curTag.trim()}` : "Склад";
  tabs?.classList.toggle("hidden", !hasWh);
  const stockTab = document.getElementById("wh-tab-stock");
  if (stockTab) {
    stockTab.textContent = kind === "used" ? "Остатки" : kind === "partnership" ? "Партнерство" : "Новые товары";
  }

  if (whViewMode === "zreport" && hasWh) {
    tableWrap?.classList.add("hidden");
    zEl?.classList.remove("hidden");
    await loadWhZReport();
    return;
  }
  zEl?.classList.add("hidden");
  tableWrap?.classList.remove("hidden");

  if (!selectedWarehouseId) {
    tb.innerHTML = '<tr><td colspan="10" style="text-align:center;color:var(--muted)">Выберите склад</td></tr>';
    hideWhStockTotals();
    return;
  }

  const cols = whStockColumns(kind);
  if (thead) thead.innerHTML = `<tr>${cols.map((c) => `<th>${c}</th>`).join("")}</tr>`;

  const data = await api(`/api/warehouses/${selectedWarehouseId}/devices`);
  whDevicesCache = data.items || [];
  const colSpan = cols.length;
  tb.innerHTML = whDevicesCache.map((u) => {
    const arrival = u.arrival_date || u.created_at?.slice(0, 10) || "—";
    const extra = +(u.customs_price || u.extra_cost || 0);
    const comment = u.client_name || u.notes || "—";
    const sellBtn = `<button class="btn btn-primary btn-sm" onclick="openWhSellModal(${u.id})">Продать</button>`;
    const extraBtn = `<button type="button" class="btn btn-ghost btn-sm" onclick="openUnitExtraModal(${u.id})" title="Изменить расходы">${extra ? whMoney(extra) : "＋ 0"}</button>`;
    if (kind === "used") {
      return `<tr>
        <td>${esc(arrival)}</td>
        <td><strong>${esc(u.model)}</strong></td>
        <td>${u.battery_capacity != null ? u.battery_capacity + "%" : "—"}</td>
        <td>${esc(u.imei || u.serial || "—")}</td>
        <td>${dash(u.memory)}</td>
        <td>${dash(u.color)}</td>
        <td>${whMoney(u.purchase_price)}</td>
        <td>${extraBtn}</td>
        <td style="font-size:.8rem">${esc(comment)}</td>
        <td>${sellBtn}</td>
      </tr>`;
    }
    return `<tr>
      <td>${esc(arrival)}</td>
      <td><strong>${esc(u.model)}</strong></td>
      <td>${esc(u.region || "—")}</td>
      <td>${esc(u.imei || "—")}</td>
      <td>${dash(u.memory)}</td>
      <td>${dash(u.color)}</td>
      <td>${whMoney(u.purchase_price)}</td>
      <td>${extraBtn}</td>
      <td>${esc(u.supplier_name || "—")}</td>
      <td>${sellBtn}</td>
    </tr>`;
  }).join("") || `<tr><td colspan="${colSpan}" style="text-align:center;color:var(--muted)">Нет остатков</td></tr>`;
  renderWhStockTotals(data.totals);
  applyWhDetailSearch();
}

async function loadWhZReport() {
  const el = document.getElementById("wh-z-report");
  if (!el || !selectedWarehouseId) return;
  const kind = warehouseKind(selectedWarehouseId);
  const now = new Date();
  const defaultYear = now.getFullYear();
  const defaultMonth = now.getMonth() + 1;
  if (!el.dataset.inited) {
    el.dataset.inited = "1";
    el.innerHTML = `
      <div class="toolbar" style="margin-bottom:0.75rem;flex-wrap:wrap">
        <label>Период<select id="wh-z-period" class="select sm-select">
          <option value="all" selected>Весь период (как Excel)</option>
          <option value="custom">Месяц</option>
        </select></label>
        <span id="wh-z-month-wrap" class="hidden">
          <label>Месяц<select id="wh-z-month" class="select sm-select">
            ${[1,2,3,4,5,6,7,8,9,10,11,12].map((m)=>{const mn=['','Янв','Фев','Мар','Апр','Май','Июн','Июл','Авг','Сен','Окт','Ноя','Дек'];return `<option value="${m}"${m===defaultMonth?' selected':''}>${mn[m]}</option>`;}).join('')}
          </select></label>
          <label>Год<input type="number" id="wh-z-year" class="input sm" value="${defaultYear}" min="2020" max="2035" style="width:5rem"></label>
        </span>
        <button type="button" id="wh-z-refresh" class="btn btn-secondary btn-sm">Показать</button>
        <label class="import-file-label" style="margin-left:auto">
          <span class="btn btn-ghost btn-sm">Импорт Excel</span>
          <input type="file" id="wh-z-import-file" accept=".xlsx" hidden>
        </label>
      </div>
      <div id="wh-z-content"></div>`;
    document.getElementById("wh-z-refresh")?.addEventListener("click", loadWhZReport);
    document.getElementById("wh-z-period")?.addEventListener("change", () => {
      document.getElementById("wh-z-month-wrap")?.classList.toggle("hidden", document.getElementById("wh-z-period")?.value !== "custom");
    });
    document.getElementById("wh-z-import-file")?.addEventListener("change", importWhZExcel);
  }
  const period = document.getElementById("wh-z-period")?.value || "all";
  const year = +document.getElementById("wh-z-year")?.value || defaultYear;
  const month = +document.getElementById("wh-z-month")?.value || defaultMonth;
  const url = period === "custom"
    ? `/api/warehouses/${selectedWarehouseId}/z-report?period=custom&year=${year}&month=${month}`
    : `/api/warehouses/${selectedWarehouseId}/z-report?period=all`;
  const r = await api(url);
  const isUsed = kind === "used";
  const whFmt = (n) => fmtCurrency(n, r.currency || warehouseCurrency(selectedWarehouseId));
  const curLabel = (r.currency || warehouseCurrency(selectedWarehouseId))?.code === "USD" ? "$" : "смн";
  const zRow = (l, sold) => {
    const profit = l.profit != null ? whFmt(l.profit) : (sold ? "—" : whFmt(-(l.purchase_price + l.extra_cost)));
    if (isUsed) {
      return `<tr>
        <td>${esc(l.arrival_date)}</td>
        <td><strong>${esc(l.product_name)}</strong></td>
        <td>${l.battery != null ? l.battery + "%" : "—"}</td>
        <td>${esc(l.imei)}</td>
        <td>${esc(l.memory)}</td>
        <td>${esc(l.color)}</td>
        <td>${whFmt(l.purchase_price)}</td>
        <td>${l.extra_cost ? whFmt(l.extra_cost) : "—"}</td>
        <td>${l.sale_price ? whFmt(l.sale_price) : "—"}</td>
        <td>${esc(l.sale_date || "—")}</td>
        <td><strong>${profit}</strong></td>
        <td style="font-size:.75rem">${esc(l.comments || "")}</td>
      </tr>`;
    }
    return `<tr>
      <td>${esc(l.arrival_date)}</td>
      <td><strong>${esc(l.product_name)}</strong></td>
      <td>${esc(l.condition || "new")}</td>
      <td>${esc(l.region || "—")}</td>
      <td>${esc(l.imei)}</td>
      <td>${esc(l.memory)}</td>
      <td>${esc(l.color)}</td>
      <td>${whFmt(l.purchase_price)}</td>
      <td>${l.extra_cost ? whFmt(l.extra_cost) : "—"}</td>
      <td>${l.sale_price ? whFmt(l.sale_price) : "—"}</td>
      <td>${esc(l.sale_date || "—")}</td>
      <td><strong>${profit}</strong></td>
      <td style="font-size:.75rem">${esc(l.comments || "")}</td>
    </tr>`;
  };
  const head = isUsed
    ? "<tr><th>Приход</th><th>Наименование</th><th>Батар.</th><th>IMEI</th><th>Память</th><th>Цвет</th><th>Себест.</th><th>Расходы</th><th>Продажа</th><th>Дата прод.</th><th>Прибыль</th><th>Коммент.</th></tr>"
    : "<tr><th>Приход</th><th>Наименование</th><th>Сост.</th><th>Регион</th><th>IMEI</th><th>Память</th><th>Цвет</th><th>Себест.</th><th>Расходы</th><th>Продажа</th><th>Дата прод.</th><th>Прибыль</th><th>Коммент.</th></tr>";
  const cols = isUsed ? 12 : 13;
  document.getElementById("wh-z-content").innerHTML = `
    <div class="kpi-grid" style="margin-bottom:1rem">
      <div class="kpi accent-blue"><div class="label">Продаж за ${esc(r.period_label)}</div><div class="value">${r.sales_count}</div><div class="sub">${whFmt(r.revenue)} (${curLabel})</div></div>
      <div class="kpi accent-green"><div class="label">Прибыль</div><div class="value">${whFmt(r.profit)}</div></div>
      <div class="kpi"><div class="label">Остатков</div><div class="value">${r.stock_count || 0}</div><div class="sub">${whFmt(r.stock_value || 0)} себест.</div></div>
    </div>
    <h4 class="sub-heading">Продажи за период</h4>
    <div class="table-wrap z-report-table" style="max-height:320px;overflow:auto;margin-bottom:1rem">
      <table class="data-table"><thead>${head}</thead>
      <tbody>${(r.lines || []).map((l) => zRow(l, true)).join("") || `<tr><td colspan="${cols}">Нет продаж за период</td></tr>`}</tbody></table>
    </div>
    <h4 class="sub-heading">Остатки на складе</h4>
    <div class="table-wrap z-report-table" style="max-height:280px;overflow:auto">
      <table class="data-table"><thead>${head}</thead>
      <tbody>${(r.stock_lines || []).map((l) => zRow(l, false)).join("") || `<tr><td colspan="${cols}">Нет остатков</td></tr>`}</tbody></table>
    </div>`;
  try {
    const tot = await api(`/api/warehouses/${selectedWarehouseId}/stock-value`);
    renderWhStockTotals(tot);
  } catch {
    hideWhStockTotals();
  }
  applyWhDetailSearch();
}

async function importWhZExcel(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  if (!confirm("Перезаписать Z-отчёт из Excel? Импортированные строки складов (БУ, основной, партнерство) будут заменены. Склад «Аксессуары» не затрагивается.")) {
    e.target.value = "";
    return;
  }
  const affectCash = confirm(
    "Загрузить суммы Excel НА КАССУ?\n\n"
    + "ОК — да: продажи попадут в «Наличные смн / $ / карта»\n"
    + "Отмена — нет: только склад и Z-отчёт"
  );
  try {
    const fd = new FormData();
    fd.append("file", file);
    const headers = {};
    if (pin) headers["X-Pin"] = pin;
    const res = await fetch(
      `/api/import/z-register?replace=1&affect_cash=${affectCash ? "true" : "false"}`,
      { method: "POST", headers, body: fd },
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || `Ошибка ${res.status}`);
    }
    const r = await res.json();
    const summary = Object.entries(r.sheets || {}).map(([k, v]) => {
      let line = `${k}: ${v.created_units} шт, продано ${v.sold_units}`;
      if (v.skipped_duplicates) line += `, пропущено ${v.skipped_duplicates}`;
      return line;
    }).join("; ");
    const warn = Object.values(r.sheets || {}).flatMap((v) => v.errors || []).slice(0, 5);
    const cashNote = r.affects_cash ? " · на кассу: да" : " · на кассу: нет";
    toast(warn.length ? `Импорт: ${summary}${cashNote}. ${warn.join("; ")}` : `Импорт: ${summary}${cashNote}`, warn.length ? "info" : "success");
    e.target.value = "";
    loadWhZReport();
    if (whViewMode !== "zreport") loadWarehouseStock();
    if (currentPage === "pos") loadPosCashRegister();
  } catch (err) { toast(err.message, "error"); }
}

window.openWarehouseModal = (wh = null) => {
  try {
    if (el("warehouse-modal-title")) {
      el("warehouse-modal-title").textContent = wh ? "Редактирование склада" : "Новый склад";
    }
    if (el("wf-id")) el("wf-id").value = wh ? wh.id : "";
    if (el("wf-name")) el("wf-name").value = wh?.name || "";
    if (el("wf-address")) el("wf-address").value = wh?.address || "";
    if (el("wf-notes")) el("wf-notes").value = wh?.notes || "";
    if (el("wf-default")) el("wf-default").checked = !!wh?.is_default;
    const whType = wh?.warehouse_type || "new";
    if (el("wf-type")) el("wf-type").value = whType === "accessories" ? "new" : whType;
    const cur = (wh?.currency_code || wh?.currency?.code || "").toUpperCase();
    if (el("wf-currency")) {
      el("wf-currency").value = cur || (whType === "used" ? "TJS" : "USD");
    }
    showModal("warehouse-modal");
  } catch (err) {
    console.error("openWarehouseModal", err);
    toast(err.message || "Не удалось открыть форму склада", "error");
  }
};

window.editWarehouse = (id) => {
  const wh = warehouses.find((w) => w.id === id);
  if (wh) openWarehouseModal(wh);
};

async function saveWarehouse(e) {
  e.preventDefault();
  const id = document.getElementById("wf-id").value;
  const body = {
    name: document.getElementById("wf-name").value.trim(),
    address: document.getElementById("wf-address").value,
    notes: document.getElementById("wf-notes").value,
    is_default: document.getElementById("wf-default").checked,
    warehouse_type: document.getElementById("wf-type")?.value || "new",
    currency_code: document.getElementById("wf-currency")?.value || "",
  };
  try {
    if (id) await api(`/api/warehouses/${id}`, { method: "PUT", body: JSON.stringify(body) });
    else await api("/api/warehouses", { method: "POST", body: JSON.stringify(body) });
    document.getElementById("warehouse-modal").close();
    toast("Сохранено");
    await loadWarehouses();
    if (currentPage === "warehouses") loadWarehousesPage();
  } catch (err) { toast(err.message, "error"); }
}

window.deleteWarehouse = async (id) => {
  if (!confirm("Удалить склад?")) return;
  try {
    await api(`/api/warehouses/${id}`, { method: "DELETE" });
    toast("Удалено");
    if (selectedWarehouseId === id) selectedWarehouseId = null;
    await loadWarehouses();
    loadWarehousesPage();
  } catch (e) { toast(e.message, "error"); }
};

function isUsedCondition(c) {
  return c === "used" || c === "refurbished";
}

function updateInboundFieldsForWarehouse() {
  const kind = warehouseKind(selectedWarehouseId);
  document.getElementById("ib-receipt-kind").value = kind;
  document.getElementById("ib-new-fields")?.classList.toggle("hidden", kind === "used");
  document.getElementById("ib-used-fields")?.classList.toggle("hidden", kind !== "used");
  document.getElementById("inbound-device-block")?.classList.remove("hidden");
  document.getElementById("ib-battery-row")?.classList.toggle("hidden", kind !== "used");
  document.getElementById("ib-qty-row")?.classList.add("hidden");
  document.getElementById("ib-existing-qty-row")?.classList.add("hidden");
}

function updateInboundFields() {
  updateInboundFieldsForWarehouse();
}

function unitLandedCost(u) {
  if (!u) return 0;
  return (+u.purchase_price || 0) + (+u.customs_price || +u.extra_cost || 0);
}

window.openUnitExtraModal = (unitId) => {
  const u = whDevicesCache.find((x) => x.id === unitId);
  if (!u) return;
  const form = document.getElementById("unit-extra-form");
  if (!form) return;
  form.dataset.unitId = String(unitId);
  const meta = document.getElementById("unit-extra-meta");
  if (meta) meta.textContent = `${u.model || "—"} · IMEI ${u.imei || "—"} · себест. ${whMoney(u.purchase_price)}`;
  document.getElementById("unit-extra-amount").value = String(+(u.customs_price || u.extra_cost || 0));
  document.getElementById("unit-extra-modal")?.showModal();
};

window.openWhSellModal = (unitId) => {
  sellUnitTarget = whDevicesCache.find((u) => u.id === unitId);
  if (!sellUnitTarget) return;
  const extra = +(sellUnitTarget.customs_price || sellUnitTarget.extra_cost || 0);
  document.getElementById("wh-sell-meta").innerHTML = `
    <div class="metric-row"><span>${esc(sellUnitTarget.model)}</span><strong>${esc(sellUnitTarget.imei || "")}</strong></div>
    <div class="metric-row"><span>Себестоимость</span><strong>${whMoney(sellUnitTarget.purchase_price)}</strong></div>
    ${extra ? `<div class="metric-row"><span>Расходы</span><strong>${whMoney(extra)}</strong></div>` : ""}
    <div class="metric-row"><span>Всё вложено</span><strong>${whMoney(unitLandedCost(sellUnitTarget))}</strong></div>`;
  document.getElementById("wh-sell-price").value = sellUnitTarget.sale_price > 0 ? sellUnitTarget.sale_price : "";
  const paidEl = document.getElementById("wh-sell-paid");
  if (paidEl) paidEl.value = sellUnitTarget.sale_price > 0 ? sellUnitTarget.sale_price : "";
  document.getElementById("wh-sell-debtor-fields")?.classList.add("hidden");
  document.getElementById("wh-sell-debtor-name").value = "";
  document.getElementById("wh-sell-debtor-phone").value = "";
  fillPaySelect(document.getElementById("wh-sell-pay"));
  updateWhSellProfit();
  document.getElementById("wh-sell-modal").showModal();
};

function updateWhSellProfit() {
  if (!sellUnitTarget) return;
  const price = +document.getElementById("wh-sell-price").value || 0;
  const paid = +document.getElementById("wh-sell-paid")?.value || price;
  const profit = price - unitLandedCost(sellUnitTarget);
  const debtBlock = document.getElementById("wh-sell-debtor-fields");
  if (debtBlock) debtBlock.classList.toggle("hidden", price - paid <= 0.01);
  document.getElementById("wh-sell-profit").textContent = price > 0
    ? `Прибыль: ${whMoney(profit)}${price - paid > 0.01 ? ` · в долг ${whMoney(price - paid)}` : ""}`
    : "Укажите цену продажи";
}

async function submitWhSell(e) {
  e.preventDefault();
  if (!sellUnitTarget) return;
  const sale_price = +document.getElementById("wh-sell-price").value;
  const paid_amount = +document.getElementById("wh-sell-paid")?.value;
  const paid = Number.isFinite(paid_amount) ? paid_amount : sale_price;
  if (sale_price <= 0) { toast("Укажите цену продажи", "error"); return; }
  const debtor_name = document.getElementById("wh-sell-debtor-name")?.value.trim() || "";
  const debtor_phone = document.getElementById("wh-sell-debtor-phone")?.value.trim() || "";
  if (sale_price - paid > 0.01 && !debtor_name) {
    toast("Укажите имя и телефон должника", "error");
    return;
  }
  try {
    await api("/api/warehouse/quick-sell", {
      method: "POST",
      body: JSON.stringify({
        unit_id: sellUnitTarget.id,
        sale_price,
        paid_amount: paid,
        payment_method: document.getElementById("wh-sell-pay").value,
        debtor_name,
        debtor_phone,
      }),
    });
    document.getElementById("wh-sell-modal").close();
    toast(`Продано! Прибыль: ${whMoney(sale_price - unitLandedCost(sellUnitTarget))}`);
    loadWarehouseStock();
    if (currentPage === "pos") loadPosCashRegister();
    if (currentPage === "products-consignment") loadConsProducts();
    if (currentPage === "dashboard") loadDashboard();
    if (currentPage === "debtors") loadDebtorsPage();
    if (whViewMode === "zreport") loadWhZReport();
  } catch (err) {
    toast(err.message, "error");
  }
}

function fillPaySelect(sel) {
  if (!sel) return;
  sel.innerHTML = (storeConfig.payment_methods || []).map((m) =>
    `<option value="${esc(m.code)}">${esc(m.name)}</option>`
  ).join("") || '<option value="cash">Наличные</option>';
}

async function onInboundExistingSelect() {
  const id = +document.getElementById("ib-existing-product").value;
  if (!id) {
    inboundExistingProduct = null;
    document.getElementById("ib-existing-meta").innerHTML = "";
    updateInboundFields();
    return;
  }
  inboundExistingProduct = await api(`/api/products/${id}`);
  document.getElementById("ib-existing-meta").innerHTML = `
    <div class="metric-row"><span>Закупка (карточка)</span><strong>${whMoney(inboundExistingProduct.purchase_price)}</strong></div>
    <div class="metric-row"><span>Цена продажи</span><strong>${whMoney(inboundExistingProduct.sale_price)}</strong></div>
    <div class="metric-row"><span>Состояние</span><strong>${conditionLabel(inboundExistingProduct.condition)}</strong></div>
    <div class="metric-row"><span>Категория</span><strong>${catLabel(inboundExistingProduct.category)}</strong></div>`;
  const pe = document.getElementById("ib-purchase-existing");
  if (pe) pe.value = inboundExistingProduct.purchase_price || "";
  updateInboundFields();
}

async function openInboundModal() {
  if (!selectedWarehouseId) return;
  const wh = warehouses.find((w) => w.id === selectedWarehouseId);
  const kind = warehouseKind(selectedWarehouseId);
  document.getElementById("inbound-wh-label").textContent = `Склад: ${wh?.name || selectedWarehouseId} · ${kind === "used" ? "Б/У" : "Новые"}`;
  inboundMode = "new";
  document.getElementById("inbound-panel-new").classList.remove("hidden");
  document.getElementById("inbound-panel-existing").classList.add("hidden");
  ["ib-name", "ib-color", "ib-memory", "ib-imei", "ib-serial", "ib-notes", "ib-supplier", "ib-region", "ib-client",
    "ib-name-used", "ib-color-used", "ib-memory-used"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
  document.getElementById("ib-purchase").value = "";
  document.getElementById("ib-purchase-used").value = "";
  const extraUsed = document.getElementById("ib-extra-used");
  if (extraUsed) extraUsed.value = "0";
  const extraEx = document.getElementById("ib-extra-existing");
  if (extraEx) extraEx.value = "0";
  document.getElementById("ib-battery").value = "";
  document.getElementById("ib-arrival").value = new Date().toISOString().slice(0, 10);
  document.getElementById("ib-ownership").value = kind === "used" ? "own" : "own";
  updateInboundFieldsForWarehouse();
  document.getElementById("inbound-modal").showModal();
  focusScanInput("ib-imei");
}

async function submitInboundReceipt(e) {
  e.preventDefault();
  const kind = warehouseKind(selectedWarehouseId);
  const batteryRaw = document.getElementById("ib-battery").value;
  const battery = batteryRaw === "" ? null : +batteryRaw;
  if (!document.getElementById("ib-imei").value.trim()) { toast("Укажите IMEI", "error"); return; }
  if (kind === "used" && battery == null) { toast("Укажите ёмкость батареи", "error"); return; }

  let body;
  if (inboundMode === "existing") {
    const productId = +document.getElementById("ib-existing-product").value;
    if (!productId) { toast("Выберите товар", "error"); return; }
    const pe = document.getElementById("ib-purchase-existing");
    const unitPurchase = pe && pe.value !== "" ? +pe.value : null;
    const unitExtra = Math.max(0, +document.getElementById("ib-extra-existing")?.value || 0);
    body = {
      warehouse_id: selectedWarehouseId,
      mode: "existing",
      product_id: productId,
      imei: document.getElementById("ib-imei").value.trim(),
      serial: document.getElementById("ib-serial").value.trim(),
      battery_capacity: battery,
      notes: document.getElementById("ib-notes").value.trim(),
      arrival_date: document.getElementById("ib-arrival").value,
      quantity: 1,
      unit_purchase_price: unitPurchase != null && unitPurchase > 0 ? unitPurchase : undefined,
      unit_extra_cost: unitExtra,
    };
  } else {
    const name = kind === "used"
      ? document.getElementById("ib-name-used").value.trim()
      : document.getElementById("ib-name").value.trim();
    if (!name) { toast("Укажите модель", "error"); return; }
    const purchase = kind === "used"
      ? +document.getElementById("ib-purchase-used").value
      : +document.getElementById("ib-purchase").value;
    const unitExtra = kind === "used"
      ? Math.max(0, +document.getElementById("ib-extra-used")?.value || 0)
      : 0;
    body = {
      warehouse_id: selectedWarehouseId,
      mode: "new",
      imei: document.getElementById("ib-imei").value.trim(),
      serial: document.getElementById("ib-serial").value.trim(),
      battery_capacity: battery,
      notes: document.getElementById("ib-notes").value.trim(),
      client_name: kind === "used" ? document.getElementById("ib-client").value.trim() : "",
      region: kind === "new" ? document.getElementById("ib-region").value.trim() : "",
      arrival_date: document.getElementById("ib-arrival").value,
      quantity: 1,
      unit_purchase_price: purchase,
      unit_extra_cost: unitExtra,
      product: {
        name,
        category: "phone",
        ownership_type: document.getElementById("ib-ownership").value,
        supplier_name: document.getElementById("ib-supplier").value.trim(),
        color: kind === "used" ? document.getElementById("ib-color-used").value.trim() : document.getElementById("ib-color").value.trim(),
        memory: kind === "used" ? document.getElementById("ib-memory-used").value.trim() : document.getElementById("ib-memory").value.trim(),
        condition: kind === "used" ? "used" : kind === "partnership" ? "partnership" : "new",
        purchase_price: purchase,
        sale_price: Math.max(purchase, 1),
        customs_price: unitExtra,
      },
    };
    if (body.product.ownership_type === "consignment" && !body.product.supplier_name) {
      toast("Укажите поставщика", "error");
      return;
    }
  }
  try {
    await api("/api/stock/inbound-receipt", { method: "POST", body: JSON.stringify(body) });
    document.getElementById("inbound-modal").close();
    toast("Товар принят на склад");
    scanBeep(true);
    loadWarehouseStock();
    loadWarehouseMovements();
    if (currentPage === "pos") loadProducts();
  } catch (err) {
    scanBeep(false);
    toast(err.message, "error");
  }
}

async function openStockMoveModal(type) {
  if (!selectedWarehouseId) return;
  document.getElementById("sm-type").value = type;
  const titles = { inbound: "Приход на склад", outbound: "Расход со склада", transfer: "Перемещение" };
  document.getElementById("stock-move-title").textContent = titles[type];
  document.getElementById("sm-to-label").classList.toggle("hidden", type !== "transfer");
  fillWarehouseSelect(document.getElementById("sm-to-warehouse"), null, { empty: true, emptyLabel: "— склад назначения —" });

  let productOptions;
  const stock = await api(`/api/warehouses/${selectedWarehouseId}/stock`);
  productOptions = stock.map((p) =>
    `<option value="${p.id}">${esc(p.name)} — ост: ${p.warehouse_quantity}</option>`
  ).join("");
  document.getElementById("sm-product").innerHTML = productOptions || '<option value="">Нет товаров</option>';
  document.getElementById("sm-qty").value = "1";
  document.getElementById("sm-notes").value = "";
  document.getElementById("stock-move-modal").showModal();
}

async function submitStockMove(e) {
  e.preventDefault();
  const type = document.getElementById("sm-type").value;
  const product_id = +document.getElementById("sm-product").value;
  const quantity = +document.getElementById("sm-qty").value;
  const notes = document.getElementById("sm-notes").value;
  if (!product_id) { toast("Выберите товар", "error"); return; }
  try {
    if (type === "transfer") {
      const to = +document.getElementById("sm-to-warehouse").value;
      if (!to) { toast("Выберите склад назначения", "error"); return; }
      const res = await api("/api/stock/transfer", {
        method: "POST",
        body: JSON.stringify({ product_id, from_warehouse_id: selectedWarehouseId, to_warehouse_id: to, quantity, notes }),
      });
      document.getElementById("stock-move-modal").close();
      toast("Перемещение проведено");
      if (res.transfer_document) showTransferDocument(res.transfer_document);
    } else {
      await api(`/api/stock/${type}`, {
        method: "POST",
        body: JSON.stringify({ warehouse_id: selectedWarehouseId, product_id, quantity, notes }),
      });
      document.getElementById("stock-move-modal").close();
      toast("Проведено");
    }
    loadWarehouseStock();
    loadWarehouseMovements();
    if (currentPage === "pos") loadProducts();
  } catch (err) { toast(err.message, "error"); }
}

function renderTransferDocHtml(d) {
  const specs = [d.product_model, d.product_color, d.product_memory].filter(Boolean).join(" · ");
  return `
    <div class="td-header">
      <div class="td-title">НАКЛАДНАЯ НА ПЕРЕМЕЩЕНИЕ</div>
      <div class="td-meta">№ ${d.id} · ${d.created_at}</div>
    </div>
    <table class="td-table">
      <tr><td class="td-lbl">Склад отправления</td><td><strong>${esc(d.from_warehouse_name)}</strong>${d.from_warehouse_address ? `<br><span class="td-sub">${esc(d.from_warehouse_address)}</span>` : ""}</td></tr>
      <tr><td class="td-lbl">Склад назначения</td><td><strong>${esc(d.to_warehouse_name)}</strong>${d.to_warehouse_address ? `<br><span class="td-sub">${esc(d.to_warehouse_address)}</span>` : ""}</td></tr>
      <tr><td class="td-lbl">Товар</td><td><strong>${esc(d.product_name)}</strong>${specs ? `<br><span class="td-sub">${esc(specs)}</span>` : ""}${d.product_sku ? `<br><span class="td-sub">Арт: ${esc(d.product_sku)}</span>` : ""}</td></tr>
      <tr><td class="td-lbl">Количество</td><td><strong>${d.quantity} шт.</strong></td></tr>
      ${d.notes ? `<tr><td class="td-lbl">Примечание</td><td>${esc(d.notes)}</td></tr>` : ""}
    </table>
    <div class="td-signatures">
      <div><span>Отпустил</span><div class="td-line"></div></div>
      <div><span>Принял</span><div class="td-line"></div></div>
    </div>`;
}

function showTransferDocument(doc) {
  document.getElementById("transfer-doc-content").innerHTML = renderTransferDocHtml(doc);
  document.getElementById("transfer-doc-modal").showModal();
}

window.printTransferById = async (id) => {
  try {
    const d = await api(`/api/stock/transfers/${id}/document`);
    const w = window.open("", "_blank");
    w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Накладная №${d.id}</title>
      <style>body{font-family:Arial,sans-serif;padding:32px;max-width:720px;margin:0 auto}
      .td-title{font-size:18px;font-weight:700;text-align:center;margin-bottom:4px}
      .td-meta{text-align:center;color:#666;margin-bottom:24px}
      table{width:100%;border-collapse:collapse;margin:16px 0}
      td{padding:8px;border-bottom:1px solid #ddd;vertical-align:top}
      .td-lbl{width:180px;color:#555}
      .td-sub{font-size:12px;color:#666}
      .td-signatures{display:flex;gap:48px;margin-top:48px}
      .td-signatures div{flex:1}
      .td-line{border-bottom:1px solid #000;margin-top:32px}</style></head><body>${renderTransferDocHtml(d)}</body></html>`);
    w.document.close();
    w.print();
  } catch (e) { toast(e.message, "error"); }
};

function printTransferDocument() {
  const html = document.getElementById("transfer-doc-content").innerHTML;
  const w = window.open("", "_blank");
  w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Накладная</title>
    <style>body{font-family:Arial,sans-serif;padding:32px;max-width:720px;margin:0 auto}
    .td-title{font-size:18px;font-weight:700;text-align:center}.td-meta{text-align:center;color:#666}
    table{width:100%;border-collapse:collapse;margin:16px 0}td{padding:8px;border-bottom:1px solid #ddd}
    .td-lbl{width:180px;color:#555}.td-sub{font-size:12px;color:#666}
    .td-signatures{display:flex;gap:48px;margin-top:48px}.td-signatures div{flex:1}
    .td-line{border-bottom:1px solid #000;margin-top:32px}</style></head><body>${html}</body></html>`);
  w.document.close();
  w.print();
}

async function loadWarehouseMovements() {
  let url = "/api/stock/movements?movement_type=transfer_out&limit=30";
  if (selectedWarehouseId && !whStockViewTotal) url += `&warehouse_id=${selectedWarehouseId}`;
  const rows = await api(url);
  const tb = document.getElementById("wh-movements-tbody");
  tb.innerHTML = rows.map((m) => `
    <tr>
      <td>${m.created_at}</td>
      <td>${esc(m.warehouse_name)}</td>
      <td>${esc(m.target_warehouse_name || "—")}</td>
      <td>${esc(m.product_name)}${m.product_model ? `<br><span style="font-size:.75rem;color:var(--muted)">${esc(m.product_model)}</span>` : ""}</td>
      <td>${m.quantity}</td>
      <td><button class="btn btn-ghost btn-sm" onclick="printTransferById(${m.id})">Печать</button></td>
    </tr>`).join("") || '<tr><td colspan="6" style="text-align:center;color:var(--muted)">Нет перемещений</td></tr>';
}

/* ── Trade-in ── */
function bindTradeIn() {
  document.getElementById("ti-given-warehouse").addEventListener("change", loadTiGivenProducts);
  document.getElementById("ti-given-product").addEventListener("change", () => updateTiSummary());
  ["ti-received-value", "ti-cash", "ti-card"].forEach((id) => {
    document.getElementById(id).addEventListener("input", updateTiSummary);
  });
  document.getElementById("trade-in-form").onsubmit = submitTradeIn;
  document.getElementById("ti-report-period").addEventListener("change", loadTiReport);
  document.getElementById("ti-print-report").onclick = printTiReport;
}

async function loadTradeInPage() {
  if (!warehouses.length) await loadWarehouses();
  fillWarehouseSelect(document.getElementById("ti-given-warehouse"), document.getElementById("ti-given-warehouse").value || defaultWarehouseId());
  fillWarehouseSelect(document.getElementById("ti-received-warehouse"), document.getElementById("ti-received-warehouse").value || defaultWarehouseId());
  await loadTiGivenProducts();
  await loadTiHistory();
  await loadTiReport();
}

async function loadTiReport() {
  const period = document.getElementById("ti-report-period").value;
  const r = await api(`/api/reports/trade-ins?period=${period}`);
  document.getElementById("ti-report-summary").innerHTML = `
    <div class="report-kpi" style="margin:0">
      <div class="report-box"><div class="lbl">Сделок</div><div class="val">${r.deals_count}</div></div>
      <div class="report-box"><div class="lbl">Зачёт (trade-in)</div><div class="val">${fmt(r.total_trade_credit)}</div></div>
      <div class="report-box"><div class="lbl">Наличные</div><div class="val">${fmt(r.total_cash)}</div></div>
      <div class="report-box"><div class="lbl">Карта</div><div class="val">${fmt(r.total_card)}</div></div>
      <div class="report-box"><div class="lbl">Деньги всего</div><div class="val" style="color:var(--success)">${fmt(r.total_money)}</div></div>
      <div class="report-box"><div class="lbl">Сумма сделок</div><div class="val">${fmt(r.total_deal_value)}</div></div>
    </div>`;
}

function printTiReport() {
  const period = document.getElementById("ti-report-period").selectedOptions[0].textContent;
  const summary = document.getElementById("ti-report-summary").innerHTML;
  const table = document.querySelector("#page-trade-in .data-table").outerHTML;
  const w = window.open("", "_blank");
  w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Отчёт по обменам</title>
    <style>body{font-family:Arial;padding:24px}h2{margin:0 0 8px}p{color:#666}
    table{border-collapse:collapse;width:100%;margin-top:16px;font-size:12px}
    th,td{border:1px solid #ccc;padding:6px;text-align:left}
    .report-kpi{display:flex;flex-wrap:wrap;gap:8px;margin:16px 0}
    .report-box{border:1px solid #ddd;padding:8px 12px;border-radius:6px;min-width:120px}
    .lbl{font-size:10px;color:#666;text-transform:uppercase}.val{font-size:16px;font-weight:700}</style>
    </head><body><h2>Отчёт по обменам (trade-in)</h2><p>Период: ${period}</p>${summary}${table}</body></html>`);
  w.document.close();
  w.print();
}

async function loadTiGivenProducts() {
  const whId = document.getElementById("ti-given-warehouse").value;
  const sel = document.getElementById("ti-given-product");
  if (!whId) {
    sel.innerHTML = '<option value="">— выберите склад —</option>';
    tiGivenProducts = [];
    updateTiSummary();
    return;
  }
  tiGivenProducts = await api(`/api/warehouses/${whId}/stock`);
  sel.innerHTML = tiGivenProducts.map((p) =>
    `<option value="${p.id}">${esc(p.name)} — ${fmt(p.sale_price)} (ост: ${p.track_units ? (p.units_by_warehouse?.[whId] ?? 0) : p.warehouse_quantity})</option>`
  ).join("") || '<option value="">Нет товаров на складе</option>';
  await updateTiSummary();
}

async function updateTiSummary() {
  const productId = +document.getElementById("ti-given-product").value;
  const p = tiGivenProducts.find((x) => x.id === productId);
  const priceEl = document.getElementById("ti-given-price");
  const summaryEl = document.getElementById("ti-pay-summary");
  const submitBtn = document.getElementById("ti-submit");
  const unitRow = document.getElementById("ti-given-unit-row");

  if (!p) {
    priceEl.classList.add("hidden");
    unitRow?.classList.add("hidden");
    summaryEl.textContent = "";
    submitBtn.disabled = true;
    return;
  }

  if (p.track_units) {
    unitRow?.classList.remove("hidden");
    const whId = +document.getElementById("ti-given-warehouse").value;
    const units = await api(`/api/products/${p.id}/units?warehouse_id=${whId}&status=in_stock`);
    const sel = document.getElementById("ti-given-unit");
    sel.innerHTML = units.map((u) =>
      `<option value="${u.id}">${esc(u.imei || u.serial || `#${u.id}`)}</option>`
    ).join("") || '<option value="">Нет IMEI на складе</option>';
    submitBtn.disabled = !units.length;
  } else {
    unitRow?.classList.add("hidden");
  }

  const total = p.sale_price;
  const received = +document.getElementById("ti-received-value").value || 0;
  const cash = +document.getElementById("ti-cash").value || 0;
  const card = +document.getElementById("ti-card").value || 0;
  const paid = received + cash + card;
  const diff = Math.abs(paid - total);

  priceEl.textContent = `Цена выдаваемого товара: ${fmt(total)}`;
  priceEl.classList.remove("hidden");
  summaryEl.textContent = `Итого оплата: ${fmt(paid)} из ${fmt(total)}${diff > 0.01 ? ` (разница ${fmt(diff)})` : " ✓"}`;
  summaryEl.style.color = diff > 0.01 ? "var(--danger)" : "var(--success)";
  submitBtn.disabled = diff > 0.01 || !productId || (p.track_units && !document.getElementById("ti-given-unit").value);
}

async function submitTradeIn(e) {
  e.preventDefault();
  const productId = +document.getElementById("ti-given-product").value;
  const p = tiGivenProducts.find((x) => x.id === productId);
  if (!p) return;

  const body = {
    given_product_id: productId,
    given_warehouse_id: +document.getElementById("ti-given-warehouse").value,
    received_name: document.getElementById("ti-received-name").value.trim(),
    received_brand: document.getElementById("ti-received-brand").value,
    received_model: document.getElementById("ti-received-model").value,
    received_color: document.getElementById("ti-received-color").value,
    received_size: document.getElementById("ti-received-size").value,
    received_memory: document.getElementById("ti-received-memory").value,
    received_ram: document.getElementById("ti-received-ram").value,
    received_specs_extra: document.getElementById("ti-received-specs").value,
    received_condition: document.getElementById("ti-received-condition").value,
    received_purchase_price: +document.getElementById("ti-received-purchase").value || 0,
    received_sale_price: +document.getElementById("ti-received-sale").value || 0,
    received_value: +document.getElementById("ti-received-value").value || 0,
    cash_amount: +document.getElementById("ti-cash").value || 0,
    card_amount: +document.getElementById("ti-card").value || 0,
    received_warehouse_id: +document.getElementById("ti-received-warehouse").value,
    received_imei: document.getElementById("ti-received-imei").value.trim(),
    received_serial: document.getElementById("ti-received-serial").value.trim(),
    notes: document.getElementById("ti-notes").value,
  };
  if (p.track_units) {
    body.given_unit_id = +document.getElementById("ti-given-unit").value || null;
    if (!body.given_unit_id) { toast("Выберите IMEI выдаваемого товара", "error"); return; }
  }

  try {
    await api("/api/trade-ins", { method: "POST", body: JSON.stringify(body) });
    toast("Обмен проведён");
    document.getElementById("trade-in-form").reset();
    document.getElementById("ti-received-condition").value = "used";
    await refreshSession();
    await loadTiGivenProducts();
    await loadTiHistory();
    await loadTiReport();
  } catch (err) { toast(err.message, "error"); }
}

async function loadTiHistory() {
  const data = await api("/api/trade-ins?limit=50");
  const tb = document.getElementById("ti-history-tbody");
  tb.innerHTML = data.items.map((t) => `
    <tr>
      <td>${t.created_at}</td>
      <td>${esc(t.given_product_name)}</td>
      <td>${esc(t.received_name)}<br><span style="font-size:.75rem;color:var(--muted)">${dash(t.received_model)} ${dash(t.received_color)}</span></td>
      <td>${fmt(t.received_value)}</td>
      <td>${fmt(t.cash_amount + t.card_amount)}</td>
      <td style="font-size:.75rem">${esc(t.given_warehouse_name)} → ${esc(t.received_warehouse_name)}</td>
    </tr>`).join("") || '<tr><td colspan="6" style="text-align:center;color:var(--muted)">Нет обменов</td></tr>';
}

function bindReservations() {
  document.getElementById("reserve-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api("/api/reservations", {
        method: "POST",
        body: JSON.stringify({
          unit_id: +document.getElementById("reserve-unit-id").value,
          client_name: document.getElementById("reserve-client").value.trim(),
          client_phone: document.getElementById("reserve-phone").value.trim(),
          notes: document.getElementById("reserve-notes").value.trim(),
          reserved_until: document.getElementById("reserve-until").value,
        }),
      });
      document.getElementById("reserve-modal").close();
      toast("Резерв создан");
      loadReservationsPage();
    } catch (err) { toast(err.message, "error"); }
  });
  document.getElementById("reserve-cancel")?.addEventListener("click", () => document.getElementById("reserve-modal").close());
}

async function loadReservationsPage() {
  const rows = await api("/api/reservations?status=active");
  document.getElementById("reservations-tbody").innerHTML = rows.map((r) => `
    <tr>
      <td>${esc(r.client_name)}</td>
      <td>${dash(r.client_phone)}</td>
      <td>${esc(r.product_name)} ${dash(r.product_color)}</td>
      <td>${dash(r.serial || r.imei)}</td>
      <td>${esc(r.warehouse_name)}</td>
      <td>${r.reserved_until}</td>
      <td>${esc(r.user_name)}</td>
      <td><button class="btn btn-ghost btn-sm" onclick="cancelReservation(${r.id})">Снять</button></td>
    </tr>`).join("") || '<tr><td colspan="8" style="text-align:center;color:var(--muted)">Нет активных резервов</td></tr>';
}

window.cancelReservation = async (id) => {
  if (!confirm("Снять резерв?")) return;
  try {
    await api(`/api/reservations/${id}`, { method: "DELETE" });
    toast("Резерв снят");
    loadReservationsPage();
  } catch (e) { toast(e.message, "error"); }
};

let usersCache = [];

/* ── Users ── */
function bindUsers() {
  document.getElementById("user-form").onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api("/api/users", {
        method: "POST",
        body: JSON.stringify({
          name: document.getElementById("user-name").value.trim(),
          pin: document.getElementById("user-pin").value.trim(),
          role: document.getElementById("user-role").value,
        }),
      });
      toast("Сотрудник добавлен");
      document.getElementById("user-form").reset();
      loadUsersPage();
    } catch (err) { toast(err.message, "error"); }
  };
  document.getElementById("user-edit-cancel").onclick = () => document.getElementById("user-edit-modal").close();
  document.getElementById("user-edit-form").onsubmit = async (e) => {
    e.preventDefault();
    const id = document.getElementById("ue-id").value;
    const body = {
      name: document.getElementById("ue-name").value.trim(),
      role: document.getElementById("ue-role").value,
      is_active: document.getElementById("ue-active").checked ? 1 : 0,
    };
    const newPin = document.getElementById("ue-pin").value.trim();
    if (newPin) body.pin = newPin;
    try {
      await api(`/api/users/${id}`, { method: "PUT", body: JSON.stringify(body) });
      document.getElementById("user-edit-modal").close();
      toast("Сохранено");
      loadUsersPage();
    } catch (err) { toast(err.message, "error"); }
  };
}

async function loadUsersPage() {
  usersCache = await api("/api/users");
  document.getElementById("users-tbody").innerHTML = usersCache.map((u) => `
    <tr>
      <td><strong>${esc(u.name)}</strong></td>
      <td>${ROLE_LABELS[u.role] || u.role}</td>
      <td>••••</td>
      <td>${u.is_active ? "Активен" : "Отключён"}</td>
      <td><button class="btn btn-ghost btn-sm" onclick="editUser(${u.id})">Изменить</button></td>
    </tr>`).join("");
}

window.editUser = (id) => {
  const u = usersCache.find((x) => x.id === id);
  if (!u) return;
  document.getElementById("ue-id").value = u.id;
  document.getElementById("ue-name").value = u.name;
  document.getElementById("ue-pin").value = "";
  document.getElementById("ue-role").value = u.role;
  document.getElementById("ue-active").checked = !!u.is_active;
  document.getElementById("user-edit-modal").showModal();
};

/* ── Products ── */
function bindProducts() {
  document.getElementById("own-search").addEventListener("input", debounce(loadOwnProducts, 300));
  document.getElementById("own-low-stock").addEventListener("change", loadOwnProducts);
  document.getElementById("cons-search").addEventListener("input", debounce(loadConsProducts, 300));
  document.getElementById("cons-supplier-filter").addEventListener("change", loadConsProducts);
  el("product-cancel")?.addEventListener("click", () => {
    clearProductImagePending();
    el("product-modal")?.close();
  });
  document.getElementById("product-form").addEventListener("submit", saveProduct);
  document.getElementById("pf-image-file")?.addEventListener("change", (e) => {
    handleProductImageFile(e.target.files?.[0]);
    e.target.value = "";
  });
  const preview = document.getElementById("pf-image-preview");
  preview?.addEventListener("dragover", (e) => { e.preventDefault(); preview.classList.add("drag-over"); });
  preview?.addEventListener("dragleave", () => preview.classList.remove("drag-over"));
  preview?.addEventListener("drop", (e) => {
    e.preventDefault();
    preview.classList.remove("drag-over");
    handleProductImageFile(e.dataTransfer?.files?.[0]);
  });
  document.getElementById("pf-image-remove")?.addEventListener("click", async (e) => {
    e.preventDefault();
    const id = document.getElementById("pf-id").value;
    if (id && !confirm("Удалить фото товара?")) return;
    clearProductImagePending();
    if (id) {
      try {
        await api(`/api/products/${id}/image`, { method: "DELETE" });
        toast("Фото удалено");
        if (currentPage === "catalog") {
      loadCatalog();
      loadCatalogColors();
    }
      } catch (err) { toast(err.message, "error"); return; }
    }
    setProductImagePreview({ category: document.getElementById("pf-category").value });
  });
  document.getElementById("pf-category")?.addEventListener("change", () => {
    const id = document.getElementById("pf-id").value;
    if (!pendingProductImageUrl && !id) setProductImagePreview({ category: document.getElementById("pf-category").value });
    else if (!pendingProductImageUrl && id) {
      const box = document.getElementById("pf-image-preview");
      if (box && !box.querySelector("img")) {
        box.className = `pf-image-preview ${productPhClass({ category: document.getElementById("pf-category").value })}`;
      }
    }
  });
  ["pf-purchase", "pf-sale", "pf-ownership"].forEach((id) => {
    document.getElementById(id)?.addEventListener("input", updateMarginHint);
    document.getElementById(id)?.addEventListener("change", updateMarginHint);
  });
}

function updateMarginHint() {
  const ownEl = el("pf-ownership");
  const purchaseEl = el("pf-purchase");
  const saleEl = el("pf-sale");
  const hint = el("pf-margin-hint");
  const pl = el("pf-purchase-label-text");
  if (!ownEl || !purchaseEl || !saleEl || !hint) return;
  const own = ownEl.value;
  const purchase = +purchaseEl.value || 0;
  const sale = +saleEl.value || 0;
  if (pl) pl.textContent = own === "consignment" ? "Сумма поставщику за ед." : "Закупочная цена";
  if (own === "consignment") {
    hint.textContent = `Комиссия магазина: ${fmt(sale - purchase)} (${pct(sale - purchase, sale)}%) · Поставщику: ${fmt(purchase)}`;
  } else {
    hint.textContent = `Маржа: ${fmt(sale - purchase)} (${pct(sale - purchase, sale)}%)`;
  }
}

function setProductFormMode(isEdit, p = null) {
  const stockRow = el("pf-stock-create-row");
  const minEditRow = el("pf-min-stock-edit-row");
  const whRow = el("pf-warehouse-row");
  const stockHint = el("pf-stock-hint");
  const stockInput = el("pf-stock");
  const minStockInput = el("pf-min-stock");
  const minStockEdit = el("pf-min-stock-edit");
  if (!stockRow || !minEditRow || !whRow) return;
  if (isEdit) {
    stockRow.classList.add("hidden");
    minEditRow.classList.remove("hidden");
    whRow.classList.add("hidden");
    stockHint?.classList.remove("hidden");
    if (stockInput) stockInput.disabled = true;
    if (minStockInput) minStockInput.disabled = true;
    if (minStockEdit) minStockEdit.disabled = false;
    if (minStockEdit) minStockEdit.value = p?.min_stock ?? 2;
    const parts = Object.entries(p?.stock_by_warehouse || {})
      .map(([wid, qty]) => {
        const w = warehouses.find((x) => x.id === +wid);
        return `${w?.name || `Склад #${wid}`}: ${qty}`;
      });
    if (stockHint) {
      stockHint.textContent = parts.length ? `Остатки по складам: ${parts.join(" · ")}` : `Общий остаток: ${p?.stock ?? 0}`;
    }
  } else {
    stockRow.classList.remove("hidden");
    minEditRow.classList.add("hidden");
    whRow.classList.remove("hidden");
    stockHint?.classList.add("hidden");
    if (stockInput) stockInput.disabled = false;
    if (minStockInput) minStockInput.disabled = false;
    if (minStockEdit) minStockEdit.disabled = true;
    fillWarehouseSelect(el("pf-warehouse"), defaultWarehouseId());
  }
}

function fillProductCardFields(p = {}) {
  const set = (id, val) => { const node = el(id); if (node) node.value = val; };
  const setCheck = (id, val) => { const node = el(id); if (node) node.checked = val; };
  set("pf-model", p.model || "");
  set("pf-color", p.color || "");
  set("pf-memory", p.memory || "");
  setCheck("pf-customs-cleared", !!p.customs_cleared);
  set("pf-customs-price", p.customs_price ?? 0);
  set("pf-specs-extra", p.specs_extra || "");
  set("pf-condition", p.condition || "new");
}

function productCardBody() {
  const v = (id) => el(id)?.value ?? "";
  const n = (id) => +el(id)?.value || 0;
  return {
    model: v("pf-model"),
    color: v("pf-color"),
    memory: v("pf-memory"),
    customs_cleared: el("pf-customs-cleared")?.checked ? 1 : 0,
    customs_price: n("pf-customs-price"),
    specs_extra: v("pf-specs-extra"),
    condition: v("pf-condition") || "new",
  };
}

async function loadOwnProducts() {
  const q = document.getElementById("own-search").value;
  const low = document.getElementById("own-low-stock").checked;
  let url = `/api/products?ownership_type=own&q=${encodeURIComponent(q)}`;
  if (low) url += "&low_stock=true";
  const items = await api(url);
  document.getElementById("own-tbody").innerHTML = items.map((p) => {
    const margin = p.sale_price - p.purchase_price;
    return `<tr>
      <td><strong>${esc(p.name)}</strong><br><span style="font-size:.75rem;color:var(--muted)">${esc(p.sku)}</span></td>
      <td>${dash(p.model)}</td>
      <td>${dash(p.color)}</td>
      <td>${dash(p.memory)}</td>
      <td><span class="tag tag-${p.category}">${catLabel(p.category)}</span></td>
      <td>${esc(p.brand)}</td>
      <td>${fmt(p.purchase_price)}</td>
      <td>${fmt(p.sale_price)}</td>
      <td>${fmt(margin)} (${pct(margin, p.sale_price)}%)</td>
      <td class="${p.stock <= p.min_stock ? "stock-low" : ""}">${p.stock}</td>
      <td>
        <button class="btn btn-ghost btn-sm" onclick="editProduct(${p.id})">✎</button>
        <button class="btn btn-danger" onclick="deleteProduct(${p.id})">✕</button>
      </td></tr>`;
  }).join("") || '<tr><td colspan="11" style="text-align:center;color:var(--muted)">Нет товаров</td></tr>';
}

async function loadConsProducts() {
  await loadSuppliers();
  const q = (document.getElementById("cons-search")?.value || "").toLowerCase();
  const sup = document.getElementById("cons-supplier-filter")?.value || "";
  if (!warehouses.length) await loadWarehouses();
  let items = [];
  try {
    const batches = await Promise.all(
      warehouses.map((w) => api(`/api/warehouses/${w.id}/devices`).catch(() => ({ items: [] })))
    );
    items = batches.flatMap((d) => (d.items || []).filter((u) => u.ownership_type === "consignment"));
  } catch { /* empty */ }
  if (sup) items = items.filter((u) => u.supplier_name === sup);
  if (q) items = items.filter((u) =>
    [u.model, u.color, u.memory, u.imei, u.supplier_name].some((x) => String(x || "").toLowerCase().includes(q))
  );
  const suppliers = [...new Set(items.map((u) => u.supplier_name).filter(Boolean))];
  const sel = document.getElementById("cons-supplier-filter");
  if (sel) {
    const cur = sel.value;
    sel.innerHTML = '<option value="">Все поставщики</option>' + suppliers.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join("");
    sel.value = cur;
  }
  document.getElementById("cons-tbody").innerHTML = items.map((u) => `
    <tr>
      <td><strong>${esc(u.model)}</strong></td>
      <td>${dash(u.color)}</td>
      <td>${dash(u.memory)}</td>
      <td>${esc(u.imei || "—")}</td>
      <td>${esc(u.supplier_name || "—")}</td>
      <td>${fmt(u.purchase_price)}</td>
      <td>${fmt(u.sale_price)}</td>
      <td><button class="btn btn-primary btn-sm" onclick="openWhSellModal(${u.id})">Продать</button></td>
    </tr>`).join("") || '<tr><td colspan="8" style="text-align:center;color:var(--muted)">Нет товаров под реализацию</td></tr>';
  whDevicesCache = [...whDevicesCache.filter((x) => x.ownership_type !== "consignment"), ...items];
}

window.openProductModal = (ownership) => {
  try {
    if (!el("product-modal")) {
      toast("Форма товара не загружена. Нажмите Ctrl+Shift+R для обновления страницы.", "error");
      return;
    }
    clearProductImagePending();
    setImageUploadBusy(false);
    const type = ownership === "consignment" ? "consignment" : "own";
    const title = el("product-modal-title");
    if (title) title.textContent = type === "consignment" ? "Товар под реализацию" : "Собственный товар";
    if (el("pf-id")) el("pf-id").value = "";
    if (el("pf-ownership")) el("pf-ownership").value = type;
    el("pf-supplier-row")?.classList.toggle("hidden", type !== "consignment");
    ["pf-name", "pf-purchase", "pf-sale", "pf-stock", "pf-supplier"].forEach((id) => {
      const node = el(id);
      if (node) node.value = id === "pf-stock" ? "0" : "";
    });
    fillProductCardFields();
    if (el("pf-min-stock")) el("pf-min-stock").value = "2";
    if (el("pf-category")) el("pf-category").value = "accessory";
    setProductFormMode(false);
    setProductImagePreview({ category: "accessory" });
    updateMarginHint();
    resetProductSaveBtn();
    if (!showModal("product-modal")) return;
  } catch (err) {
    console.error("openProductModal", err);
    toast(err.message || "Не удалось открыть форму товара", "error");
  }
};

window.editProduct = async (id) => {
  try {
    clearProductImagePending();
    setImageUploadBusy(false);
    const p = await api(`/api/products/${id}`);
    if (!p) return;
    document.getElementById("product-modal-title").textContent = "Карточка товара";
    document.getElementById("pf-id").value = p.id;
    document.getElementById("pf-ownership").value = p.ownership_type;
    document.getElementById("pf-supplier-row").classList.toggle("hidden", p.ownership_type !== "consignment");
    document.getElementById("pf-name").value = p.name;
    document.getElementById("pf-category").value = p.category;
    document.getElementById("pf-supplier").value = p.supplier_name || "";
    document.getElementById("pf-purchase").value = p.purchase_price ?? "";
    document.getElementById("pf-sale").value = p.sale_price ?? "";
    document.getElementById("pf-min-stock").value = p.min_stock;
    fillProductCardFields(p);
    setProductFormMode(true, p);
    setProductImagePreview(p);
    updateMarginHint();
    resetProductSaveBtn();
    showModal("product-modal");
  } catch (err) {
    console.error("editProduct", err);
    toast(err.message || "Не удалось открыть товар", "error");
  }
};

window.deleteProduct = async (id) => {
  if (!confirm("Удалить товар?")) return;
  try {
    await api(`/api/products/${id}`, { method: "DELETE" });
    toast("Удалено");
    loadOwnProducts();
    loadConsProducts();
    if (currentPage === "catalog") {
      loadCatalog();
      loadCatalogColors();
    }
    if (currentPage === "pos") loadProducts();
  } catch (e) { toast(e.message, "error"); }
};

async function saveProduct(e) {
  e.preventDefault();
  e.stopPropagation();
  const saveBtn = el("product-save-btn");
  const id = document.getElementById("pf-id").value;
  const name = document.getElementById("pf-name").value.trim();
  const ownership = document.getElementById("pf-ownership").value;
  const supplier = document.getElementById("pf-supplier").value.trim();
  const purchase = +document.getElementById("pf-purchase").value;
  const sale = +document.getElementById("pf-sale").value;

  if (!name) { toast("Укажите название товара", "error"); document.getElementById("pf-name").focus(); return; }
  if (ownership === "consignment" && !supplier) {
    toast("Укажите поставщика для товара под реализацию", "error");
    return;
  }
  if (Number.isNaN(purchase) || purchase < 0) { toast("Некорректная закупочная цена", "error"); return; }
  if (Number.isNaN(sale) || sale < 0) { toast("Некорректная цена продажи", "error"); return; }

  const body = {
    name,
    category: document.getElementById("pf-category").value,
    ownership_type: ownership,
    supplier_name: supplier,
    brand: "",
    sku: "",
    barcode: "",
    purchase_price: purchase,
    sale_price: sale,
    min_stock: id
      ? +document.getElementById("pf-min-stock-edit").value
      : +document.getElementById("pf-min-stock").value,
    ...productCardBody(),
  };
  if (!id) {
    body.stock = +document.getElementById("pf-stock").value || 0;
    body.warehouse_id = +document.getElementById("pf-warehouse").value;
    if (!body.warehouse_id) { toast("Выберите склад", "error"); return; }
  }

  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.textContent = "Сохранение…";
  }
  try {
    let productId = id;
    if (id) {
      await api(`/api/products/${id}`, { method: "PUT", body: JSON.stringify(body) });
    } else {
      const created = await api("/api/products", { method: "POST", body: JSON.stringify(body) });
      productId = created.id;
      document.getElementById("pf-id").value = productId;
    }
    if (pendingProductImage && productId) {
      setImageUploadBusy(true);
      const updated = await apiUpload(`/api/products/${productId}/image`, pendingProductImage);
      setProductImagePreview(updated);
      setImageUploadBusy(false);
    }
    clearProductImagePending();
    document.getElementById("product-modal").close();
    toast(id ? "Товар обновлён" : "Товар создан");
    loadOwnProducts();
    loadConsProducts();
    if (currentPage === "catalog") {
      loadCatalog();
      loadCatalogColors();
    }
    if (currentPage === "pos") loadProducts();
  } catch (err) {
    toast(err.message || "Ошибка сохранения", "error");
  } finally {
    resetProductSaveBtn();
    setImageUploadBusy(false);
  }
}

/* ── Accessories ── */
function bindAccessories() {
  document.querySelectorAll("#acc-view-tabs .seg").forEach((b) => {
    b.addEventListener("click", () => {
      document.querySelectorAll("#acc-view-tabs .seg").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      accViewMode = b.dataset.accView;
      document.getElementById("acc-panel-intake").classList.toggle("hidden", accViewMode !== "intake");
      document.getElementById("acc-panel-pos").classList.toggle("hidden", accViewMode !== "pos");
      document.getElementById("acc-panel-report").classList.toggle("hidden", accViewMode !== "report");
      if (accViewMode === "pos") loadAccPos();
      else if (accViewMode === "report") loadAccReport();
      else loadAccStock();
    });
  });
  document.getElementById("acc-inbound-form")?.addEventListener("submit", submitAccInbound);
  document.getElementById("acc-stock-search")?.addEventListener("input", debounce(loadAccStock, 300));
  document.getElementById("acc-pos-search")?.addEventListener("input", debounce(loadAccProducts, 250));
  document.getElementById("acc-checkout-btn")?.addEventListener("click", accCheckout);
  document.getElementById("acc-clear-cart")?.addEventListener("click", () => { accCart = []; renderAccCart(); });
  document.getElementById("acc-fill-cash")?.addEventListener("click", () => {
    const saleCur = accSaleCurrency();
    const payCur = accPayCurrency();
    const fxOn = !!document.getElementById("acc-fx-enable")?.checked && payCur !== saleCur;
    let total = accCartTotal();
    let fillCur = saleCur;
    if (fxOn) {
      const conv = accConvertSaleToPay(total);
      if (conv == null) { toast("Укажите курс конвертации", "error"); return; }
      total = Math.round(conv * 100) / 100;
      fillCur = payCur;
    }
    document.querySelectorAll(".acc-split-pay-input").forEach((inp) => {
      inp.value = inp.dataset.method === "cash" ? total : "";
      const curSel = inp.closest(".split-pay-row")?.querySelector(".split-pay-currency");
      if (curSel) curSel.value = fillCur;
    });
    updateAccSplitSummary();
  });
  document.getElementById("acc-split-payments")?.addEventListener("input", (e) => {
    if (e.target.classList.contains("acc-split-pay-input") || e.target.classList.contains("split-pay-currency")) {
      updateAccSplitSummary();
    }
  });
  document.getElementById("acc-split-payments")?.addEventListener("change", (e) => {
    if (e.target.classList.contains("split-pay-currency")) updateAccSplitSummary();
  });
  document.getElementById("acc-fx-enable")?.addEventListener("change", () => {
    const rateInp = document.getElementById("acc-fx-rate");
    if (rateInp) rateInp.dataset.manual = "0";
    syncAccFxRateFromSettings(true);
    refreshAccFxUi();
    renderAccSplitPayments();
  });
  document.getElementById("acc-fx-currency")?.addEventListener("change", () => {
    const rateInp = document.getElementById("acc-fx-rate");
    if (rateInp) rateInp.dataset.manual = "0";
    syncAccFxRateFromSettings(true);
    refreshAccFxUi();
    renderAccSplitPayments();
  });
  document.getElementById("acc-fx-rate")?.addEventListener("input", () => {
    const inp = document.getElementById("acc-fx-rate");
    if (inp) inp.dataset.manual = "1";
    refreshAccFxUi();
  });
  document.getElementById("acc-cash-refresh")?.addEventListener("click", loadAccCashRegister);
  document.getElementById("acc-report-refresh")?.addEventListener("click", loadAccReport);
  document.getElementById("acc-report-period")?.addEventListener("change", loadAccReport);
  fillPaySelect(document.getElementById("acc-exp-pay"));
  document.getElementById("acc-expense-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api("/api/expenses", { method: "POST", body: JSON.stringify({
        category: document.getElementById("acc-exp-category").value.trim(),
        amount: +document.getElementById("acc-exp-amount").value,
        expense_date: new Date().toISOString().slice(0, 10),
        description: document.getElementById("acc-exp-desc").value,
        payment_method_code: document.getElementById("acc-exp-pay").value,
        department: "accessories",
      }) });
      toast("Расход добавлен");
      document.getElementById("acc-expense-form").reset();
      loadAccCashRegister();
      if (accViewMode === "report") loadAccReport();
    } catch (err) { toast(err.message, "error"); }
  });
  document.getElementById("acc-import-file")?.addEventListener("change", onAccImportFile);
  document.getElementById("acc-import-submit")?.addEventListener("click", submitAccExcelImport);
}

let accImportFile = null;

function onAccImportFile(e) {
  accImportFile = e.target.files?.[0] || null;
  const nameEl = document.getElementById("acc-import-filename");
  const btn = document.getElementById("acc-import-submit");
  if (nameEl) nameEl.textContent = accImportFile ? accImportFile.name : "Файл не выбран";
  if (btn) btn.disabled = !accImportFile;
}

async function submitAccExcelImport() {
  if (!accImportFile) return;
  if (!confirm("Заменить остатки аксессуаров из Excel? Текущие Z-импорт остатки будут очищены.")) return;
  const btn = document.getElementById("acc-import-submit");
  const resultEl = document.getElementById("acc-import-result");
  if (btn) btn.disabled = true;
  try {
    const headers = {};
    if (pin) headers["X-Pin"] = pin;
    const fd = new FormData();
    fd.append("file", accImportFile);
    const res = await fetch("/api/accessories/import/excel?replace=1", { method: "POST", headers, body: fd });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(typeof data.detail === "string" ? data.detail : "Ошибка импорта");
    const imp = data.import || {};
    const msg = `Принято: ${imp.created_units || 0}, продано: ${imp.sold_units || 0}, строк: ${imp.total_rows || 0}`;
    if (resultEl) {
      resultEl.classList.remove("hidden");
      resultEl.innerHTML = `<span style="color:var(--success)">${esc(msg)}</span>`;
    }
    toast("Импорт аксессуаров выполнен");
    loadAccStock();
  } catch (err) {
    toast(err.message, "error");
  } finally {
    if (btn) btn.disabled = !accImportFile;
  }
}

async function loadAccessoriesPage() {
  if (!accWarehouseId) {
    const wh = await api("/api/accessories/warehouse");
    accWarehouseId = wh.id;
  }
  document.getElementById("acc-panel-intake").classList.toggle("hidden", accViewMode !== "intake");
  document.getElementById("acc-panel-pos").classList.toggle("hidden", accViewMode !== "pos");
  document.getElementById("acc-panel-report").classList.toggle("hidden", accViewMode !== "report");
  if (accViewMode === "pos") await loadAccPos();
  else if (accViewMode === "report") await loadAccReport();
  else await loadAccStock();
}

async function loadAccStock() {
  const q = document.getElementById("acc-stock-search")?.value || "";
  const items = await api(`/api/accessories/stock?q=${encodeURIComponent(q)}`);
  document.getElementById("acc-stock-tbody").innerHTML = items.map((p) => {
    const qty = p.warehouse_quantity ?? p.stock ?? 0;
    return `<tr>
      <td><strong>${esc(p.name)}</strong></td>
      <td>${dash(p.model)}</td>
      <td>${esc(p.supplier_name || "—")}</td>
      <td>${accMoney(p.purchase_price)}</td>
      <td><input type="number" class="input sm acc-price-inp" data-id="${p.id}" value="${p.sale_price}" min="0.01" step="0.01"></td>
      <td><strong>${qty}</strong></td>
      <td><button class="btn btn-ghost btn-sm" onclick="saveAccPrice(${p.id})">✓</button></td>
    </tr>`;
  }).join("") || '<tr><td colspan="7" style="text-align:center;color:var(--muted)">Нет товаров</td></tr>';
}

window.saveAccPrice = async (id) => {
  const inp = document.querySelector(`.acc-price-inp[data-id="${id}"]`);
  if (!inp) return;
  try {
    await api(`/api/accessories/products/${id}/price?sale_price=${+inp.value}`, { method: "PUT" });
    toast("Цена сохранена");
    loadAccProducts();
  } catch (e) { toast(e.message, "error"); }
};

async function submitAccInbound(e) {
  e.preventDefault();
  const saleVal = document.getElementById("acc-ib-sale").value;
  try {
    await api("/api/accessories/inbound", { method: "POST", body: JSON.stringify({
      name: document.getElementById("acc-ib-name").value.trim(),
      model: document.getElementById("acc-ib-model").value.trim(),
      quantity: +document.getElementById("acc-ib-qty").value,
      supplier_name: document.getElementById("acc-ib-supplier").value.trim(),
      purchase_price: +document.getElementById("acc-ib-purchase").value,
      sale_price: saleVal ? +saleVal : null,
    }) });
    toast("Принято на склад");
    document.getElementById("acc-inbound-form").reset();
    document.getElementById("acc-ib-qty").value = "1";
    loadAccStock();
  } catch (err) { toast(err.message, "error"); }
}

async function loadAccPos() {
  if (!accWarehouseId) {
    const wh = await api("/api/accessories/warehouse");
    accWarehouseId = wh.id;
  }
  renderAccSplitPayments();
  await loadAccProducts();
  await loadAccCashRegister();
  focusScanInput("acc-pos-search");
}

async function loadAccProducts() {
  const q = document.getElementById("acc-pos-search")?.value || "";
  accProducts = await api(`/api/accessories/stock?q=${encodeURIComponent(q)}`);
  const grid = document.getElementById("acc-pos-products");
  if (!accProducts.length) {
    grid.innerHTML = '<p style="padding:1rem;color:var(--muted)">Нет товаров</p>';
    return;
  }
  grid.innerHTML = accProducts.map((p) => {
    const stock = p.warehouse_quantity ?? 0;
    const out = stock <= 0;
    return `<div class="product-card ${out ? "out" : ""}" data-id="${p.id}">
      <div class="name">${esc(p.name)}</div>
      <div class="meta">${dash(p.model)} · ${esc(p.supplier_name || "")}</div>
      <div class="price">${accMoney(p.sale_price)}</div>
      <div class="meta">${out ? "Нет" : `Ост: ${stock}`}</div>
    </div>`;
  }).join("");
  grid.querySelectorAll(".product-card:not(.out)").forEach((c) => {
    c.addEventListener("click", () => accAddToCart(+c.dataset.id));
  });
  renderAccCart();
}

function accAddToCart(id) {
  const p = accProducts.find((x) => x.id === id);
  const stock = p?.warehouse_quantity ?? 0;
  if (!p || stock <= 0) return;
  const item = accCart.find((c) => c.product_id === id);
  if (item) {
    if (item.quantity >= stock) { toast(`Макс. ${stock}`, "error"); return; }
    item.quantity += 1;
  } else {
    accCart.push({ product_id: id, quantity: 1, product: p, unit_price: +p.sale_price || 0 });
  }
  renderAccCart();
}

function accLinePrice(c) {
  const v = c.unit_price;
  if (v != null && Number.isFinite(+v) && +v > 0) return +v;
  return +c.product?.sale_price || 0;
}

function accCartTotal() {
  return accCart.reduce((s, c) => s + accLinePrice(c) * c.quantity, 0);
}

function accSaleCurrency() {
  return (warehouseCurrency(accWarehouseId)?.code || "USD").toUpperCase();
}

function accPayCurrency() {
  if (!document.getElementById("acc-fx-enable")?.checked) return accSaleCurrency();
  return (document.getElementById("acc-fx-currency")?.value || accSaleCurrency()).toUpperCase();
}

function accFxRateSaleToPay() {
  const inp = document.getElementById("acc-fx-rate");
  if (inp && inp.value !== "" && +inp.value > 0) return +inp.value;
  return convertMoney(1, accSaleCurrency(), accPayCurrency());
}
function accConvertSaleToPay(amount) {
  const r = accFxRateSaleToPay();
  if (r == null || r <= 0) return null;
  return (+amount || 0) * r;
}
function accConvertToSale(amount, fromCur) {
  const sale = accSaleCurrency();
  const from = (fromCur || sale).toUpperCase();
  if (!from || from === sale) return +amount || 0;
  const pay = accPayCurrency();
  if (from === pay) {
    const r = accFxRateSaleToPay();
    if (r == null || r <= 0) return null;
    return (+amount || 0) / r;
  }
  return convertMoney(amount, from, sale);
}
function syncAccFxRateFromSettings(force = false) {
  const inp = document.getElementById("acc-fx-rate");
  if (!inp) return;
  if (!force && inp.dataset.manual === "1") return;
  const rate = convertMoney(1, accSaleCurrency(), accPayCurrency());
  if (rate != null && rate > 0) {
    inp.value = String(Math.round(rate * 10000) / 10000);
    inp.dataset.manual = "0";
  } else {
    inp.value = "";
  }
}

function refreshAccFxUi() {
  const enable = document.getElementById("acc-fx-enable");
  const fields = document.getElementById("acc-fx-fields");
  const sel = document.getElementById("acc-fx-currency");
  const hint = document.getElementById("acc-fx-rate-hint");
  const caption = document.getElementById("acc-fx-rate-caption");
  const totalEl = document.getElementById("acc-fx-total");
  const totalLabel = document.getElementById("acc-fx-total-label");
  if (!enable || !fields || !sel) return;
  const saleCur = accSaleCurrency();
  const opts = ["TJS", "USD"];
  const prev = sel.value;
  sel.innerHTML = opts.map((c) =>
    `<option value="${c}" ${c === saleCur ? "disabled" : ""}>${currencyLabel(c)}</option>`
  ).join("");
  const prefer = opts.find((c) => c !== saleCur) || opts[0];
  sel.value = opts.includes(prev) && prev !== saleCur ? prev : prefer;
  fields.classList.toggle("hidden", !enable.checked);
  if (!enable.checked) {
    if (hint) hint.textContent = "";
    updateAccSplitSummary();
    return;
  }
  const payCur = sel.value;
  if (caption) caption.textContent = `1 ${saleCur} = … ${payCur}`;
  syncAccFxRateFromSettings(false);
  const rate = accFxRateSaleToPay();
  if (hint) {
    if (rate == null) {
      hint.textContent = `Нет курса в настройках — введите курс вручную`;
      hint.style.color = "var(--danger)";
    } else {
      const custom = document.getElementById("acc-fx-rate")?.dataset.manual === "1";
      hint.textContent = custom
        ? `Свой курс: 1 ${saleCur} = ${(+rate).toFixed(4)} ${payCur}`
        : `Авто из настроек: 1 ${saleCur} = ${(+rate).toFixed(4)} ${payCur}`;
      hint.style.color = "";
    }
  }
  const dueWh = accCartTotal();
  const duePay = accConvertSaleToPay(dueWh);
  if (totalLabel) totalLabel.textContent = `К оплате (${payCur})`;
  if (totalEl) totalEl.textContent = duePay == null ? "—" : fmtCurrency(duePay, currency_meta(payCur));
  updateAccSplitSummary();
}

function renderAccSplitPayments() {
  const box = document.getElementById("acc-split-payments");
  if (!box) return;
  const methods = storeConfig.payment_methods?.length ? storeConfig.payment_methods : [
    { code: "cash", name: "Наличные" }, { code: "card", name: "Карта" },
  ];
  const prev = {};
  const prevCur = {};
  box.querySelectorAll(".acc-split-pay-input").forEach((inp) => {
    if (inp.value) prev[inp.dataset.method] = inp.value;
    const curSel = inp.closest(".split-pay-row")?.querySelector(".split-pay-currency");
    if (curSel) prevCur[inp.dataset.method] = curSel.value;
  });
  const saleCur = accSaleCurrency();
  const payCur = accPayCurrency();
  const fxOn = !!document.getElementById("acc-fx-enable")?.checked && payCur !== saleCur;
  const curOpts = fxOn
    ? [saleCur, payCur].filter((c, i, a) => a.indexOf(c) === i)
    : [saleCur];
  box.innerHTML = methods.map((m) => {
    const defCur = prevCur[m.code] || (fxOn ? payCur : saleCur);
    const curSelect = fxOn
      ? `<select class="select sm split-pay-currency" data-method="${esc(m.code)}" title="Валюта оплаты">
          ${curOpts.map((c) => `<option value="${c}" ${c === defCur ? "selected" : ""}>${currencyLabel(c)}</option>`).join("")}
        </select>`
      : "";
    return `<label class="split-pay-row">
      <span>${esc(m.name)}</span>
      <span class="split-pay-controls">
        <input type="number" class="input sm acc-split-pay-input" data-method="${esc(m.code)}" min="0" step="0.01" value="${prev[m.code] || ""}" placeholder="0">
        ${curSelect}
      </span>
    </label>`;
  }).join("");
}

function collectAccPayments() {
  const saleCur = accSaleCurrency();
  return [...document.querySelectorAll(".acc-split-pay-input")]
    .map((inp) => {
      const row = inp.closest(".split-pay-row");
      const curSel = row?.querySelector(".split-pay-currency");
      return {
        method_code: inp.dataset.method,
        amount: +inp.value || 0,
        currency_code: (curSel?.value || saleCur).toUpperCase(),
      };
    })
    .filter((p) => p.amount > 0);
}

function updateAccSplitSummary() {
  const saleCur = accSaleCurrency();
  const payCur = accPayCurrency();
  const fxOn = !!document.getElementById("acc-fx-enable")?.checked && payCur !== saleCur;
  const totalSale = accCartTotal();
  const payments = collectAccPayments();
  let paidSale = 0;
  let bad = false;
  for (const p of payments) {
    const conv = accConvertToSale(p.amount, p.currency_code || saleCur);
    if (conv == null) { bad = true; break; }
    paidSale += conv;
  }
  const moneySale = (n) => fmtCurrency(n, currency_meta(saleCur));
  const paidLabel = document.getElementById("acc-split-paid-label");
  const paidEl = document.getElementById("acc-split-paid");
  const rem = document.getElementById("acc-split-remain-wrap");
  if (bad) {
    if (paidEl) paidEl.textContent = "—";
    if (rem) {
      rem.classList.remove("hidden");
      const remEl = document.getElementById("acc-split-remain");
      if (remEl) remEl.textContent = "—";
    }
    return;
  }
  if (paidLabel) {
    paidLabel.innerHTML = fxOn
      ? `Оплачено (${saleCur}): <strong id="acc-split-paid">${moneySale(paidSale)}</strong>`
      : `Оплачено: <strong id="acc-split-paid">${moneySale(paidSale)}</strong>`;
  } else if (paidEl) {
    paidEl.textContent = moneySale(paidSale);
  }
  const remain = Math.max(0, totalSale - paidSale);
  if (rem) {
    rem.innerHTML = fxOn
      ? `Осталось (${saleCur}): <strong id="acc-split-remain">${moneySale(remain)}</strong>`
      : `Осталось: <strong id="acc-split-remain">${moneySale(remain)}</strong>`;
    rem.classList.toggle("hidden", Math.abs(totalSale - paidSale) < 0.01);
    rem.style.color = totalSale - paidSale > 0.01 ? "var(--danger)" : "var(--success)";
  }
}

function renderAccCart() {
  const box = document.getElementById("acc-cart-items");
  const empty = document.getElementById("acc-cart-empty");
  const count = accCart.reduce((s, c) => s + c.quantity, 0);
  document.getElementById("acc-cart-count").textContent = count;
  if (!accCart.length) {
    box.innerHTML = "";
    empty.classList.remove("hidden");
    document.getElementById("acc-checkout-btn").disabled = true;
    document.getElementById("acc-cart-subtotal").textContent = accMoney(0);
    document.getElementById("acc-cart-total").textContent = accMoney(0);
    refreshAccFxUi();
    return;
  }
  empty.classList.add("hidden");
  let sub = 0;
  box.innerHTML = accCart.map((c, idx) => {
    const price = accLinePrice(c);
    const catalog = +c.product.sale_price || 0;
    const custom = Math.abs(price - catalog) > 0.0001;
    const line = price * c.quantity;
    sub += line;
    return `<div class="cart-item">
      <div><div class="ci-name">${esc(c.product.name)}</div></div>
      <div class="ci-qty"><button type="button" onclick="accChangeQty(${idx},-1)">−</button>${c.quantity}<button type="button" onclick="accChangeQty(${idx},1)">+</button></div>
      <div class="ci-price-wrap">
        <span class="ci-price-label">Цена</span>
        <div class="ci-price-row">
          <input type="number" class="input sm ci-price${custom ? " is-custom" : ""}" min="0.01" step="0.01"
            value="${price}" title="Прайс ${accMoney(catalog)}"
            onchange="setAccCartPrice(${idx}, this.value)" oninput="setAccCartPrice(${idx}, this.value, true)">
          <button type="button" class="btn btn-ghost btn-sm ci-price-reset" title="По прайсу" onclick="resetAccCartPrice(${idx})">↺</button>
        </div>
      </div>
      <strong class="ci-line-sum">${accMoney(line)}</strong>
      <button class="btn btn-ghost btn-sm" onclick="accRemoveLine(${idx})">×</button>
    </div>`;
  }).join("");
  document.getElementById("acc-cart-subtotal").textContent = accMoney(sub);
  document.getElementById("acc-cart-total").textContent = accMoney(sub);
  renderAccSplitPayments();
  refreshAccFxUi();
  document.getElementById("acc-checkout-btn").disabled = false;
}

window.setAccCartPrice = (idx, value, soft = false) => {
  const c = accCart[idx];
  if (!c) return;
  const n = +value;
  if (!Number.isFinite(n) || n <= 0) {
    if (!soft) toast("Укажите цену больше 0", "error");
    return;
  }
  c.unit_price = n;
  if (soft) {
    const row = document.querySelectorAll("#acc-cart-items .cart-item")[idx];
    if (row) {
      const sum = row.querySelector(".ci-line-sum");
      if (sum) sum.textContent = accMoney(accLinePrice(c) * c.quantity);
      const inp = row.querySelector(".ci-price");
      if (inp) inp.classList.toggle("is-custom", Math.abs(n - (+c.product.sale_price || 0)) > 0.0001);
    }
    const sub = accCartTotal();
    document.getElementById("acc-cart-subtotal").textContent = accMoney(sub);
    document.getElementById("acc-cart-total").textContent = accMoney(sub);
    refreshAccFxUi();
    return;
  }
  renderAccCart();
};
window.resetAccCartPrice = (idx) => {
  const c = accCart[idx];
  if (!c) return;
  c.unit_price = +c.product.sale_price || 0;
  renderAccCart();
};

window.accChangeQty = (idx, d) => {
  const c = accCart[idx];
  if (!c) return;
  c.quantity += d;
  const stock = c.product.warehouse_quantity ?? 0;
  if (c.quantity <= 0) accCart.splice(idx, 1);
  else if (c.quantity > stock) { c.quantity = stock; toast(`Макс. ${stock}`, "error"); }
  renderAccCart();
};
window.accRemoveLine = (idx) => { accCart.splice(idx, 1); renderAccCart(); };

async function accCheckout() {
  const total = accCartTotal();
  const saleCur = accSaleCurrency();
  const payCur = accPayCurrency();
  const fxOn = !!document.getElementById("acc-fx-enable")?.checked && payCur !== saleCur;
  const paymentsRaw = collectAccPayments();
  if (fxOn) {
    const rate = accFxRateSaleToPay();
    if (rate == null || rate <= 0) {
      toast(`Укажите курс 1 ${saleCur} → ${payCur}`, "error");
      return;
    }
  }
  let paidSale = 0;
  for (const p of paymentsRaw) {
    const conv = accConvertToSale(p.amount, p.currency_code || saleCur);
    if (conv == null) {
      toast("Не удалось пересчитать оплату по курсу", "error");
      return;
    }
    paidSale += conv;
  }
  if (paidSale <= 0 && total > 0) { toast("Укажите оплату", "error"); return; }
  let debtor_name = "";
  let debtor_phone = "";
  if (total - paidSale > 0.01) {
    const debtor = await promptDebtorModal(total, paidSale, saleCur);
    if (!debtor) return;
    debtor_name = debtor.name;
    debtor_phone = debtor.phone;
  } else if (Math.abs(total - paidSale) > 0.01) {
    toast("Сумма оплат не совпадает с итогом", "error");
    return;
  }
  const fxRate = fxOn ? accFxRateSaleToPay() : null;
  try {
    await api("/api/sales", {
      method: "POST",
      body: JSON.stringify({
        items: accCart.map((c) => ({
          product_id: c.product_id,
          quantity: c.quantity,
          unit_price: accLinePrice(c),
        })),
        payments: paymentsRaw,
        warehouse_id: accWarehouseId,
        debtor_name,
        debtor_phone,
        pay_currency: fxOn ? payCur : "",
        fx_rate: fxRate || undefined,
      }),
    });
    accCart = [];
    const fx = document.getElementById("acc-fx-enable");
    if (fx) fx.checked = false;
    const rateInp = document.getElementById("acc-fx-rate");
    if (rateInp) rateInp.dataset.manual = "0";
    renderAccCart();
    await loadAccProducts();
    loadAccCashRegister();
    toast("Продажа проведена");
  } catch (e) { toast(e.message, "error"); }
}

async function loadAccCashRegister() {
  const kpi = document.getElementById("acc-cash-kpi");
  if (!kpi) return;
  try {
    const r = await api("/api/accessories/cash-register?period=day");
    const bags = r.by_currency || [];
    kpi.innerHTML = `
      <div class="kpi accent-blue"><div class="label">Приход</div><div class="value value-multi">${formatSideBags(bags, "inflow")}</div></div>
      <div class="kpi accent-warn"><div class="label">Расход</div><div class="value value-multi">${formatSideBags(bags, "outflow")}</div></div>
      <div class="kpi accent-green"><div class="label">Чистыми</div><div class="value value-multi">${formatSideBags(bags, "net")}</div></div>
      <div class="kpi"><div class="label">Прибыль (продажа $)</div><div class="value">${accMoney(r.profit)}</div></div>`;
    const bal = document.getElementById("acc-balances");
    if (bal) {
      bal.innerHTML = (r.inflows || []).map((b) =>
        `<div class="pos-balance-row"><span>${esc(b.name)}</span><strong>${moneyLine(b.amount, b.currency_code || "USD")}</strong></div>`
      ).join("") || "";
    }
    const tb = document.getElementById("acc-expenses-tbody");
    if (tb) {
      tb.innerHTML = (r.expense_lines || []).map((e) =>
        `<tr><td>${esc(e.expense_date)}</td><td>${esc(e.category)}</td><td>${accMoney(e.amount)}</td></tr>`
      ).join("") || '<tr><td colspan="3">Нет расходов</td></tr>';
    }
  } catch (err) {
    kpi.innerHTML = `<p class="muted">${esc(err.message)}</p>`;
  }
}

async function loadAccReport() {
  const period = document.getElementById("acc-report-period")?.value || "month";
  const r = await api(`/api/accessories/reports/finance?period=${period}`);
  document.getElementById("acc-report-content").innerHTML = `
    <div class="report-header"><h3>Аксессуары — финансы</h3><p>${r.period_label}</p></div>
    <div class="report-kpi">
      <div class="report-box"><div class="lbl">Выручка</div><div class="val">${accMoney(r.revenue)}</div><div class="sub">${r.sales_count} чеков · ${r.items_sold} шт</div></div>
      <div class="report-box"><div class="lbl">Себестоимость</div><div class="val">${accMoney(r.cogs)}</div></div>
      <div class="report-box"><div class="lbl">Прибыль продаж</div><div class="val">${accMoney(r.shop_profit)}</div></div>
      <div class="report-box"><div class="lbl">Расходы</div><div class="val">${accMoney(r.expenses)}</div></div>
      <div class="report-box"><div class="lbl">Чистая прибыль</div><div class="val" style="color:var(--success)">${accMoney(r.net_profit)}</div></div>
    </div>
    ${(r.expenses_by_category || []).length ? `<div class="card"><div class="card-header"><h3>Расходы по категориям</h3></div>
      <div class="card-body table-wrap"><table class="data-table"><thead><tr><th>Категория</th><th>Сумма</th></tr></thead><tbody>
        ${r.expenses_by_category.map((e) => `<tr><td>${esc(e.category)}</td><td>${accMoney(e.amount)}</td></tr>`).join("")}
      </tbody></table></div></div>` : ""}
    <div class="card" style="margin-top:1rem"><div class="card-header"><h3>Последние продажи</h3></div>
      <div class="table-wrap card-body"><table class="data-table">
        <thead><tr><th>Дата</th><th>Чек</th><th>Товар</th><th>Кол-во</th><th>Сумма</th><th>Прибыль</th></tr></thead>
        <tbody>${(r.recent_sales || []).map((s) => `<tr>
          <td>${esc(s.created_at?.slice(0, 16) || "")}</td><td>#${s.id}</td>
          <td>${esc(s.product_name)}</td><td>${s.quantity}</td>
          <td>${accMoney(s.subtotal)}</td><td><strong>${accMoney(s.shop_profit)}</strong></td>
        </tr>`).join("") || '<tr><td colspan="6">Нет продаж</td></tr>'}
        </tbody></table></div></div>`;
}

/* ── Suppliers ── */
function bindSuppliers() {
  document.getElementById("payment-form").onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api("/api/supplier-payments", {
        method: "POST",
        body: JSON.stringify({
          supplier_name: document.getElementById("pay-supplier").value,
          amount: +document.getElementById("pay-amount").value,
          notes: document.getElementById("pay-notes").value,
        }),
      });
      document.getElementById("pay-amount").value = "";
      document.getElementById("pay-notes").value = "";
      toast("Выплата зафиксирована");
      loadSuppliers();
    } catch (err) { toast(err.message, "error"); }
  };
}

async function loadSuppliers() {
  const [suppliers, payments] = await Promise.all([
    api("/api/suppliers"),
    api("/api/supplier-payments"),
  ]);
  document.getElementById("suppliers-tbody").innerHTML = suppliers.map((s) => `
    <tr>
      <td><strong>${esc(s.supplier_name)}</strong></td>
      <td>${s.products_count}</td>
      <td class="value-multi">${creditorBagsHtml(s, "accrued_due")}</td>
      <td class="value-multi">${creditorBagsHtml(s, "paid")}</td>
      <td class="value-multi ${creditorOpen(s) ? "stock-low" : ""}"><strong>${creditorBagsHtml(s, "balance")}</strong></td>
    </tr>`).join("") || '<tr><td colspan="5" style="text-align:center;color:var(--muted)">Нет поставщиков</td></tr>';

  const sel = document.getElementById("pay-supplier");
  sel.innerHTML = suppliers.map((s) => `<option value="${esc(s.supplier_name)}">${esc(s.supplier_name)} (долг ${creditorBagsHtml(s, "balance").replace(/<[^>]+>/g, " ").trim()})</option>`).join("");

  document.getElementById("payments-list").innerHTML = payments.slice(0, 20).map((p) => `
    <div class="pay-row"><span>${esc(p.supplier_name)} · ${p.created_at}</span><strong>−${moneyLine(p.amount, p.currency_code || "TJS")}</strong></div>
  `).join("") || '<p style="color:var(--muted);font-size:.8rem">Нет выплат</p>';
}



function cartTotalDue() {
  const sub = cart.reduce((s, c) => s + lineSubtotal(c), 0);
  const disc = +document.getElementById("cart-discount")?.value || 0;
  return Math.max(0, sub - disc);
}

function renderSplitPayments() {
  const box = document.getElementById("split-payments");
  if (!box) return;
  const methods = storeConfig.payment_methods?.length ? storeConfig.payment_methods : [
    { code: "cash", name: "Наличные" }, { code: "card", name: "Карта" },
    { code: "ds", name: "ДС" }, { code: "alif", name: "Alif" }, { code: "eskhata", name: "Эсхата" },
  ];
  const prev = {};
  const prevCur = {};
  box.querySelectorAll(".split-pay-input").forEach((inp) => {
    if (inp.value) prev[inp.dataset.method] = inp.value;
    const curSel = inp.closest(".split-pay-row")?.querySelector(".split-pay-currency");
    if (curSel) prevCur[inp.dataset.method] = curSel.value;
  });
  const saleCur = posSaleCurrency();
  const payCur = posPayCurrency();
  const fxOn = !!document.getElementById("pos-fx-enable")?.checked && payCur !== saleCur;
  const curOpts = fxOn
    ? [saleCur, payCur].filter((c, i, a) => a.indexOf(c) === i)
    : [saleCur];
  box.innerHTML = methods.map((m) => {
    const defCur = prevCur[m.code] || (fxOn ? payCur : saleCur);
    const curSelect = fxOn
      ? `<select class="select sm split-pay-currency" data-method="${esc(m.code)}" title="Валюта оплаты">
          ${curOpts.map((c) => `<option value="${c}" ${c === defCur ? "selected" : ""}>${currencyLabel(c)}</option>`).join("")}
        </select>`
      : "";
    return `<label class="split-pay-row">
      <span>${esc(m.name)}</span>
      <span class="split-pay-controls">
        <input type="number" class="input sm split-pay-input" data-method="${esc(m.code)}" min="0" step="0.01" value="${prev[m.code] || ""}" placeholder="0">
        ${curSelect}
      </span>
    </label>`;
  }).join("");
}

function updateSplitSummary() {
  const saleCur = posSaleCurrency();
  const payCur = posPayCurrency();
  const fxOn = !!document.getElementById("pos-fx-enable")?.checked && payCur !== saleCur;
  const totalSale = cartTotalDue();
  const payments = collectSplitPayments();
  let paidSale = 0;
  let bad = false;
  for (const p of payments) {
    const conv = posConvertToSale(p.amount, p.currency_code || saleCur);
    if (conv == null) { bad = true; break; }
    paidSale += conv;
  }
  const moneySale = (n) => fmtCurrency(n, currency_meta(saleCur));
  const paidEl = document.getElementById("split-paid-total");
  const remEl = document.getElementById("split-remain-total");
  const remWrap = document.getElementById("split-remain-label");
  const paidLabel = document.getElementById("split-paid-label");
  if (bad) {
    if (paidEl) paidEl.textContent = "—";
    if (remEl) remEl.textContent = "—";
    if (remWrap) remWrap.classList.remove("hidden");
    return;
  }
  if (paidLabel) {
    paidLabel.innerHTML = fxOn
      ? `Оплачено (${saleCur}): <strong id="split-paid-total">${moneySale(paidSale)}</strong>`
      : `Оплачено: <strong id="split-paid-total">${moneySale(paidSale)}</strong>`;
  } else if (paidEl) {
    paidEl.textContent = moneySale(paidSale);
  }
  const remain = Math.max(0, totalSale - paidSale);
  const remStrong = document.getElementById("split-remain-total");
  if (remWrap) {
    remWrap.innerHTML = fxOn
      ? `Осталось (${saleCur}): <strong id="split-remain-total">${moneySale(remain)}</strong>`
      : `Осталось: <strong id="split-remain-total">${moneySale(remain)}</strong>`;
    remWrap.classList.toggle("hidden", Math.abs(totalSale - paidSale) < 0.01);
    remWrap.style.color = totalSale - paidSale > 0.01 ? "var(--danger)" : "var(--success)";
  } else if (remStrong) {
    remStrong.textContent = moneySale(remain);
  }
}

function collectSplitPayments() {
  const saleCur = posSaleCurrency();
  return [...document.querySelectorAll(".split-pay-input")]
    .map((inp) => {
      const row = inp.closest(".split-pay-row");
      const curSel = row?.querySelector(".split-pay-currency");
      return {
        method_code: inp.dataset.method,
        amount: +inp.value || 0,
        currency_code: (curSel?.value || saleCur).toUpperCase(),
      };
    })
    .filter((p) => p.amount > 0);
}

function bindSettings() {
  document.getElementById("toggle-advanced-ui")?.addEventListener("change", (e) => {
    if (e.target.checked) localStorage.setItem(ADVANCED_UI_KEY, "1");
    else localStorage.removeItem(ADVANCED_UI_KEY);
    applySimpleNav();
    const page = currentPage;
    if (!canAccess(page) || (effectiveSimpleUi() && ADVANCED_PAGES.has(page))) {
      navigate(firstAllowedPage());
    } else {
      navigate(page);
    }
    toast(e.target.checked ? "Расширенный интерфейс включён" : "Простой режим");
  });
  document.getElementById("currency-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api("/api/settings/currency", { method: "PUT", body: JSON.stringify({
        base_currency: document.getElementById("set-currency-code").value.trim(),
        currency_symbol: document.getElementById("set-currency-symbol").value.trim(),
        currency_name: document.getElementById("set-currency-name").value.trim(),
      }) });
      toast("Валюта сохранена");
      const cfg = await fetch("/api/config").then((r) => r.json());
      if (cfg.currency) storeConfig.currency = cfg.currency;
      renderCart();
    } catch (err) { toast(err.message, "error"); }
  });
  document.getElementById("rate-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const code = document.getElementById("rate-code").value.trim().toUpperCase();
    const rateRaw = String(document.getElementById("rate-value").value || "").replace(",", ".");
    const rate = +rateRaw;
    const effEl = document.getElementById("rate-effective");
    let effective_at = (effEl?.value || "").trim();
    if (effective_at) {
      // datetime-local: 2026-07-29T15:00 or …:00:00
      effective_at = effective_at.replace("T", " ");
      if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(effective_at)) effective_at += ":00";
    } else {
      effective_at = ""; // backend → сейчас
    }
    if (!/^[A-Z]{3}$/.test(code)) {
      toast("Код валюты: 3 буквы, например USD", "error");
      return;
    }
    if (!(rate > 0)) {
      toast("Укажите курс числом больше 0 (например 9.3)", "error");
      return;
    }
    try {
      const saved = await api("/api/settings/exchange-rates", { method: "POST", body: JSON.stringify({
        currency_code: code,
        rate,
        effective_at,
        notes: document.getElementById("rate-notes").value,
      }) });
      toast(`Курс добавлен: 1 ${saved.currency_code} = ${saved.rate} с ${saved.effective_at}`);
      document.getElementById("rate-value").value = "";
      document.getElementById("rate-notes").value = "";
      loadSettingsPage();
    } catch (err) { toast(err.message, "error"); }
  });
  document.getElementById("paymethod-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api("/api/settings/payment-methods", { method: "POST", body: JSON.stringify({
        code: document.getElementById("pm-code").value.trim(),
        name: document.getElementById("pm-name").value.trim(),
        method_type: document.getElementById("pm-type").value,
      }) });
      toast("Способ оплаты добавлен");
      const cfg = await fetch("/api/config").then((r) => r.json());
      if (cfg.payment_methods) storeConfig.payment_methods = cfg.payment_methods;
      loadSettingsPage();
      renderSplitPayments();
    } catch (err) { toast(err.message, "error"); }
  });
  document.getElementById("expense-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api("/api/expenses", { method: "POST", body: JSON.stringify({
        category: document.getElementById("exp-category").value.trim(),
        amount: +document.getElementById("exp-amount").value,
        expense_date: document.getElementById("exp-date").value,
        description: document.getElementById("exp-desc").value,
        payment_method_code: document.getElementById("exp-pay").value,
      }) });
      toast("Расход добавлен");
      loadSettingsPage();
    } catch (err) { toast(err.message, "error"); }
  });
  document.getElementById("btn-wipe-catalog")?.addEventListener("click", wipeCatalogData);
  document.getElementById("expense-allocation-form")?.addEventListener("submit", saveExpenseAllocation);
}

async function wipeCatalogData() {
  if (!confirm("Удалить все товары, продажи и остатки? Склады и настройки сохранятся.")) return;
  try {
    await api("/api/store/wipe-catalog", { method: "POST" });
    toast("Каталог очищен — можно загружать свои товары");
    products = [];
    warehouses = [];
    await loadWarehouses();
    if (currentPage === "warehouses") loadWarehousesPage();
    if (currentPage === "dashboard") loadDashboard();
  } catch (err) {
    toast(err.message, "error");
  }
}

async function loadSettingsPage() {
  updateAdvancedUiToggle();
  const data = await api("/api/settings");
  document.getElementById("catalog-wipe-card")?.classList.toggle("hidden", currentUser?.role !== "owner");
  document.getElementById("expense-allocation-card")?.classList.toggle("hidden", currentUser?.role !== "owner");
  storeConfig.currency = data.currency;
  storeConfig.payment_methods = data.payment_methods.filter((m) => m.is_active);
  const rateMap = { [(data.currency?.code || "TJS").toUpperCase()]: 1 };
  for (const r of data.exchange_rates || []) {
    const code = String(r.currency_code || "").toUpperCase();
    const eff = String(r.effective_at || "");
    if (!code || rateMap[code] != null) continue; // first = latest (DESC)
    if (!eff || eff.startsWith(":") || eff.length < 10) continue;
    rateMap[code] = +r.rate;
  }
  storeConfig.exchange_rates = rateMap;
  document.getElementById("set-currency-code").value = data.currency.code || "";
  document.getElementById("set-currency-symbol").value = data.currency.symbol || "";
  document.getElementById("set-currency-name").value = data.currency.name || "";
  const latestIdByCode = {};
  for (const r of data.exchange_rates || []) {
    const code = String(r.currency_code || "").toUpperCase();
    const eff = String(r.effective_at || "");
    if (!code || latestIdByCode[code] != null) continue;
    if (!eff || eff.startsWith(":") || eff.length < 10) continue;
    latestIdByCode[code] = r.id;
  }
  document.getElementById("rates-tbody").innerHTML = (data.exchange_rates || []).map((r) => {
    const code = String(r.currency_code || "").toUpperCase();
    const eff = String(r.effective_at || "");
    const isJunk = !eff || eff.startsWith(":") || eff.length < 10;
    const isCurrent = !isJunk && latestIdByCode[code] === r.id && code !== String(data.currency?.code || "TJS").toUpperCase();
    return `<tr>
      <td>${esc(r.currency_code)}${isCurrent ? ' <span class="tag tag-own" style="font-size:.65rem">текущий</span>' : ""}${isJunk ? ' <span class="hint">(битая дата)</span>' : ""}</td>
      <td>${r.rate}</td>
      <td>${esc(r.effective_at || "—")}</td>
      <td style="white-space:nowrap">
        ${esc(r.notes || "")}
        <button type="button" class="btn btn-danger btn-sm" onclick="deleteExchangeRate(${r.id})" title="Удалить">✕</button>
      </td>
    </tr>`;
  }).join("") || '<tr><td colspan="4">Нет курсов</td></tr>';
  // default «действует с» = сейчас (локально), чтобы не ставили старый год по ошибке
  const effInput = document.getElementById("rate-effective");
  if (effInput && !effInput.value) {
    const d = new Date();
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    effInput.value = d.toISOString().slice(0, 16);
  }
  const rateCode = document.getElementById("rate-code");
  if (rateCode && !rateCode.value) rateCode.value = "USD";
  document.getElementById("paymethods-tbody").innerHTML = (data.payment_methods || []).map((m) =>
    `<tr><td>${esc(m.code)}</td><td>${esc(m.name)}</td><td>${esc(m.method_type)}</td><td>${m.is_active ? "✓" : "—"}</td></tr>`
  ).join("");
  const expPay = document.getElementById("exp-pay");
  if (expPay) expPay.innerHTML = data.payment_methods.filter((m) => m.is_active).map((m) =>
    `<option value="${esc(m.code)}">${esc(m.name)}</option>`).join("");
  const expenses = await api("/api/expenses?period=all");
  document.getElementById("expenses-tbody").innerHTML = expenses.map((e) =>
    `<tr><td>${esc(e.expense_date)}</td><td>${esc(e.category)}</td><td>${fmt(e.amount)}</td><td><button class="btn btn-danger btn-sm" onclick="deleteExpense(${e.id})">✕</button></td></tr>`
  ).join("") || '<tr><td colspan="4">Нет расходов</td></tr>';
  renderSplitPayments();
  await loadExpenseAllocationSettings();
}

async function loadExpenseAllocationSettings() {
  const box = document.getElementById("expense-allocation-rows");
  if (!box) return;
  if (!warehouses.length) await loadWarehouses();
  const whList = phoneWarehouses();
  let rules = [];
  try {
    const data = await api("/api/settings/expense-allocation");
    rules = data.rules || [];
  } catch { /* empty */ }
  const byWh = Object.fromEntries(rules.map((r) => [r.warehouse_id, r.pct]));
  const defaultPct = whList.length ? Math.round(100 / whList.length) : 0;
  box.innerHTML = whList.map((w) => `
    <label class="form-row-inline">${esc(w.name)}
      <input type="number" class="input sm exp-alloc-pct" data-wh-id="${w.id}" min="0" max="100" step="0.1"
        value="${byWh[w.id] ?? defaultPct}"> %
    </label>`).join("");
  box.querySelectorAll(".exp-alloc-pct").forEach((inp) => inp.addEventListener("input", updateExpenseAllocationSum));
  updateExpenseAllocationSum();
}

function updateExpenseAllocationSum() {
  const el = document.getElementById("expense-allocation-sum");
  if (!el) return;
  const sum = [...document.querySelectorAll(".exp-alloc-pct")].reduce((s, inp) => s + (+inp.value || 0), 0);
  const ok = Math.abs(sum - 100) < 0.5;
  el.textContent = `Сумма: ${sum.toFixed(1)}%${ok ? "" : " — должно быть 100%"}`;
  el.style.color = ok ? "var(--muted)" : "var(--danger)";
}

async function saveExpenseAllocation(e) {
  e.preventDefault();
  const rules = [...document.querySelectorAll(".exp-alloc-pct")].map((inp) => ({
    warehouse_id: +inp.dataset.whId,
    pct: +inp.value || 0,
  }));
  try {
    await api("/api/settings/expense-allocation", { method: "PUT", body: JSON.stringify({ rules }) });
    toast("Распределение сохранено");
  } catch (err) { toast(err.message, "error"); }
}

window.deleteExchangeRate = async (id) => {
  if (!confirm("Удалить этот курс?")) return;
  try {
    await api(`/api/settings/exchange-rates/${id}`, { method: "DELETE" });
    toast("Курс удалён");
    loadSettingsPage();
  } catch (err) {
    toast(err.message, "error");
  }
};

window.deleteExpense = async (id) => {
  if (!confirm("Удалить расход?")) return;
  try {
    await api(`/api/expenses/${id}`, { method: "DELETE" });
    toast("Расход откатан");
    if (document.getElementById("expense-lines-modal")?.open) {
      const title = document.getElementById("expense-lines-title")?.dataset || {};
      if (title.cat) await openExpenseCategoryDetail(title.cat, title.dept || "main");
      else document.getElementById("expense-lines-modal")?.close();
    }
    if (currentPage === "settings") loadSettingsPage();
    if (currentPage === "reports" && reportType === "opiu") loadReport();
  } catch (e) { toast(e.message, "error"); }
};

let expenseDetailCtx = { category: "", department: "main" };

async function openExpenseCategoryDetail(category, department = "main") {
  expenseDetailCtx = { category, department };
  const period = document.getElementById("report-period")?.value || "month";
  const from = document.getElementById("report-from")?.value || "";
  const to = document.getElementById("report-to")?.value || "";
  let url = `/api/expenses?period=${encodeURIComponent(period)}&category=${encodeURIComponent(category)}&department=${encodeURIComponent(department || "main")}`;
  if (from) url += `&date_from=${encodeURIComponent(from)}`;
  if (to) url += `&date_to=${encodeURIComponent(to)}`;
  const rows = await api(url);
  const total = rows.reduce((s, r) => s + (+r.amount || 0), 0);
  const deptLabel = department === "accessories" ? "Аксессуары" : "Основной";
  const titleEl = document.getElementById("expense-lines-title");
  if (titleEl) {
    titleEl.textContent = `Расход: ${category}`;
    titleEl.dataset.cat = category;
    titleEl.dataset.dept = department || "main";
  }
  const sub = document.getElementById("expense-lines-sub");
  if (sub) {
    sub.textContent = `${deptLabel} · ${rows.length} запис. · итого ${fmtCurrency(total, currency_meta("TJS"))}`;
  }
  const box = document.getElementById("expense-lines-content");
  if (box) {
    if (!rows.length) {
      box.innerHTML = '<p class="hint">Нет записей за выбранный период</p>';
    } else {
      box.innerHTML = `<table class="data-table">
        <thead><tr>
          <th>Дата расхода</th><th>Сумма</th><th>Оплата</th><th>Кто ввёл</th><th>Когда введено</th><th>Комментарий</th><th></th>
        </tr></thead>
        <tbody>${rows.map((e) => `<tr>
          <td>${esc(e.expense_date || "—")}</td>
          <td><strong>${fmtCurrency(e.amount, currency_meta("TJS"))}</strong></td>
          <td>${esc(e.payment_method_name || payLabel(e.payment_method_code) || e.payment_method_code || "—")}</td>
          <td>${esc(e.created_by || "—")}</td>
          <td>${esc((e.created_at || "").slice(0, 16) || "—")}</td>
          <td>${esc(e.description || "—")}</td>
          <td class="expense-line-actions">
            <button type="button" class="btn btn-danger btn-sm" data-rollback-exp="${e.id}" title="Откатить расход">Откат</button>
          </td>
        </tr>`).join("")}</tbody>
      </table>`;
      box.querySelectorAll("[data-rollback-exp]").forEach((btn) => {
        btn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          rollbackExpense(+btn.dataset.rollbackExp);
        });
      });
    }
  }
  document.getElementById("expense-lines-modal")?.showModal();
}

async function rollbackExpense(id) {
  if (!confirm("Откатить этот расход? Запись будет удалена из отчётов.")) return;
  try {
    await api(`/api/expenses/${id}`, { method: "DELETE" });
    toast("Расход откатан");
    await openExpenseCategoryDetail(expenseDetailCtx.category, expenseDetailCtx.department);
    if (currentPage === "reports") loadReport();
    if (currentPage === "settings") loadSettingsPage();
  } catch (e) { toast(e.message, "error"); }
}

window.openExpenseCategoryDetail = openExpenseCategoryDetail;
window.rollbackExpense = rollbackExpense;

/* ── Reports ── */
function bindReports() {
  document.querySelectorAll("#report-type .seg").forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll("#report-type .seg").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      reportType = b.dataset.rtype;
      document.getElementById("report-scope").style.display = (reportType === "finance" || reportType === "cashiers") ? "" : "none";
      document.getElementById("report-period").closest(".toolbar") && (document.getElementById("report-period").style.display = reportType === "balance" ? "none" : "");
      loadReport();
    };
  });
  document.querySelectorAll("#report-scope .seg").forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll("#report-scope .seg").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      reportScope = b.dataset.scope;
      loadReport();
    };
  });
  document.getElementById("load-report").onclick = loadReport;
  document.getElementById("report-detail-btn").onclick = openReportDetail;
  document.getElementById("report-detail-close")?.addEventListener("click", () => document.getElementById("report-detail-modal").close());
  document.getElementById("expense-lines-close")?.addEventListener("click", () => document.getElementById("expense-lines-modal")?.close());
  document.getElementById("report-detail-wh")?.addEventListener("change", openReportDetail);
  document.getElementById("report-period").onchange = loadReport;
  document.getElementById("report-warehouse")?.addEventListener("change", loadReport);
  document.getElementById("print-report").onclick = () => {
    const w = window.open("", "_blank");
    w.document.write(`<html><head><title>Отчёт</title><style>body{font-family:Arial;padding:24px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:6px}</style></head><body>${document.getElementById("report-content").innerHTML}${document.getElementById("report-combined").innerHTML}</body></html>`);
    w.print();
  };
}

function renderCurrencyBreakdown(byCurrency) {
  if (!byCurrency?.length) return "";
  return `<div class="card" style="margin-bottom:1rem"><div class="card-header"><h3>По валютам</h3></div><div class="card-body"><div class="report-kpi">
    ${byCurrency.map((c) => `
      <div class="report-box">
        <div class="lbl">${esc(c.name || c.code)}</div>
        <div class="val">${fmtCurrency(c.gross_revenue, c)}</div>
        <div class="sub">${c.sales_count} продаж · прибыль ${fmtCurrency(c.net_profit ?? c.shop_profit, c)}${c.operating_expenses ? ` · расходы ${fmtCurrency(c.operating_expenses, currency_meta("TJS"))}` : ""}${c.margin_pct != null ? ` · маржа ${c.margin_pct}%` : ""}</div>
        ${c.gross_profit != null ? `<div class="sub">валовая ${fmtCurrency(c.gross_profit, c)}</div>` : ""}
      </div>`).join("")}
  </div></div></div>`;
}

function renderExpensesByWarehouse(total, rows) {
  if (!total && !(rows || []).length) return "";
  const tjs = currency_meta("TJS");
  const whRows = (rows || []).filter((w) => w.amount > 0 || w.pct > 0);
  return `<div class="card"><div class="card-header"><h3>Расходы по складам</h3></div>
    <div class="card-body table-wrap"><table class="data-table">
      <thead><tr><th>Склад</th><th>Доля итога</th><th>Общие (%)</th><th>Выплаты</th><th>Итого</th></tr></thead>
      <tbody>
        <tr><td><strong>Общий расход</strong></td><td>100%</td><td></td><td></td><td><strong>${fmtCurrency(total, tjs)}</strong></td></tr>
        ${whRows.map((w) => `<tr>
          <td>${esc(w.warehouse_name)}</td>
          <td>${w.pct ?? 0}%</td>
          <td>${fmtCurrency(w.shared_amount || 0, tjs)}${w.pct_rule != null ? ` <small class="hint">(${w.pct_rule}%)</small>` : ""}</td>
          <td>${fmtCurrency(w.direct_amount || 0, tjs)}</td>
          <td>${fmtCurrency(w.amount, tjs)}</td>
        </tr>`).join("")}
      </tbody>
    </table>
    <p class="hint muted" style="margin-top:.65rem">% из настроек делит только общие расходы без склада. Выплаты с кассы ложатся на выбранный склад на 100%.</p>
  </div></div>`;
}

function renderFundsSnapshot(funds) {
  if (!funds) return "";
  const usd = currency_meta("USD");
  const tjs = currency_meta("TJS");
  const t = funds.totals || {};
  const rateUsd = funds.exchange_rates?.USD;
  const whRows = (funds.warehouses || []).map((w) => `
    <tr>
      <td><strong>${esc(w.warehouse_name)}</strong></td>
      <td>${esc(w.currency_code || "—")}</td>
      <td>${fmtCurrency(w.value_usd ?? 0, usd)}</td>
      <td>${fmtCurrency(w.value_tjs ?? 0, tjs)}</td>
      <td>${(w.units_count || 0) + (w.qty_items || 0)}</td>
    </tr>`).join("");
  const cashRows = (funds.cash_by_currency || []).map((c) => `
    <tr>
      <td><strong>${esc(c.name || c.code)}</strong></td>
      <td>${fmtCurrency(c.cash ?? 0, c)}</td>
      <td>${fmtCurrency(c.wallet ?? 0, c)}</td>
      <td><strong>${fmtCurrency(c.total ?? 0, c)}</strong></td>
    </tr>`).join("");
  return `
    <div class="card" style="margin-bottom:1rem">
      <div class="card-header"><h3>Сейчас: склады и касса</h3>
        <p class="hint" style="margin:0">На ${esc((funds.as_of || "").slice(0, 16))}${rateUsd ? ` · курс USD ${rateUsd}` : ""}</p>
      </div>
      <div class="card-body">
        <div class="report-kpi" style="margin-bottom:1rem">
          <div class="report-box"><div class="lbl">Товар на складах ($)</div><div class="val">${fmtCurrency(t.stock_usd ?? 0, usd)}</div></div>
          <div class="report-box"><div class="lbl">Товар на складах (смн)</div><div class="val">${fmtCurrency(t.stock_tjs ?? 0, tjs)}</div></div>
          <div class="report-box"><div class="lbl">Наличка $</div><div class="val">${fmtCurrency(t.cash_usd ?? 0, usd)}</div></div>
          <div class="report-box"><div class="lbl">Наличка смн</div><div class="val">${fmtCurrency(t.cash_tjs ?? 0, tjs)}</div></div>
          <div class="report-box"><div class="lbl">Кошелёк $</div><div class="val">${fmtCurrency(t.wallet_usd ?? 0, usd)}</div></div>
          <div class="report-box"><div class="lbl">Кошелёк смн</div><div class="val">${fmtCurrency(t.wallet_tjs ?? 0, tjs)}</div></div>
        </div>
        <h4 class="sub-heading">По складам (себестоимость остатка)</h4>
        <div class="table-wrap"><table class="data-table">
          <thead><tr><th>Склад</th><th>Валюта</th><th>В долларах</th><th>В сомони</th><th>Шт.</th></tr></thead>
          <tbody>${whRows || '<tr><td colspan="5">Нет складов</td></tr>'}</tbody>
        </table></div>
        <h4 class="sub-heading" style="margin-top:1rem">Касса: наличка и кошелёк</h4>
        <div class="table-wrap"><table class="data-table">
          <thead><tr><th>Валюта</th><th>Наличка</th><th>Кошелёк</th><th>Итого</th></tr></thead>
          <tbody>${cashRows || '<tr><td colspan="4">Нет данных</td></tr>'}</tbody>
        </table></div>
        <p class="hint muted" style="margin-top:.65rem">Кошелёк — карта, ДС, Alif, Эсхата, перевод. Наличка — только cash. Учитываются продажи, погашения долгов, расходы и оплаты поставщикам.</p>
      </div>
    </div>`;
}

function renderReportBlock(r, title) {
  const multiCur = (r.by_currency?.length || 0) > 1;
  const primary = r.by_currency?.[0];
  const money = (n) => (primary && multiCur ? "—" : (primary ? fmtCurrency(n, primary) : fmt(n)));
  return `
    <div class="report-header"><h3>${title}</h3><p>${r.period_label}</p></div>
    ${renderFundsSnapshot(r.funds)}
    ${multiCur ? renderCurrencyBreakdown(r.by_currency) : (r.by_currency?.length ? renderCurrencyBreakdown(r.by_currency) : "")}
    <div class="report-kpi">
      <div class="report-box"><div class="lbl">Выручка</div><div class="val">${money(r.gross_revenue)}</div></div>
      <div class="report-box"><div class="lbl">Продаж</div><div class="val">${r.sales_count}</div></div>
      <div class="report-box"><div class="lbl">Единиц</div><div class="val">${r.items_sold}</div></div>
      <div class="report-box"><div class="lbl">Прибыль магазина</div><div class="val" style="color:var(--success)">${money(r.shop_profit)}</div></div>
      <div class="report-box"><div class="lbl">Маржа</div><div class="val">${multiCur ? "—" : `${r.margin_pct}%`}</div></div>
      ${r.scope !== "consignment" ? `<div class="report-box"><div class="lbl">Себестоимость (свои)</div><div class="val">${money(r.own_cogs)}</div></div>` : ""}
      ${r.scope !== "own" ? `<div class="report-box"><div class="lbl">К оплате поставщикам</div><div class="val" style="color:var(--consignment)">${money(r.supplier_due)}</div></div>` : ""}
    </div>
    ${r.by_payment?.length ? `<div class="card"><div class="card-header"><h3>Оплата</h3></div><div class="card-body"><table class="data-table"><thead><tr><th>Способ</th><th>Чеков</th><th>Сумма</th></tr></thead><tbody>
      ${r.by_payment.map((p) => `<tr><td>${payLabel(p.method)}</td><td>${p.count}</td><td>${fmt(p.amount)}</td></tr>`).join("")}
    </tbody></table></div></div>` : ""}
    ${r.by_supplier?.length ? `<div class="card"><div class="card-header"><h3>По поставщикам</h3></div><div class="card-body"><table class="data-table"><thead><tr><th>Поставщик</th><th>Шт.</th><th>Выручка</th><th>Долг</th><th>Комиссия</th></tr></thead><tbody>
      ${r.by_supplier.map((s) => `<tr><td>${esc(s.supplier_name)}</td><td>${s.qty}</td><td>${fmt(s.revenue)}</td><td>${fmt(s.due)}</td><td>${fmt(s.profit)}</td></tr>`).join("")}
    </tbody></table></div></div>` : ""}`;
}

function renderCompareCard(r, cls, title) {
  const multi = (r.by_currency?.length || 0) > 1;
  const curBlock = multi ? r.by_currency.map((c) =>
    `<div class="metric-row"><span>${esc(c.code)}</span><strong>${fmtCurrency(c.gross_revenue, c)} / ${fmtCurrency(c.shop_profit, c)}</strong></div>`
  ).join("") : "";
  const p = r.by_currency?.[0];
  const m = (n) => p ? fmtCurrency(n, p) : fmt(n);
  return `<div class="compare-card ${cls}"><h4>${title}</h4>
    ${curBlock}
    <div class="metric-row"><span>Выручка</span><strong>${multi ? "см. валюты" : m(r.gross_revenue)}</strong></div>
    <div class="metric-row"><span>Прибыль</span><strong>${multi ? "см. валюты" : m(r.shop_profit)}</strong></div>
    <div class="metric-row"><span>Маржа</span><strong>${r.margin_pct}%</strong></div>
    <div class="metric-row"><span>Продаж</span><strong>${r.sales_count}</strong></div>
    ${cls !== "own" ? `<div class="metric-row"><span>Поставщикам</span><strong class="value-multi">${finFmt(r, "supplier_due")}</strong></div>` : ""}
    ${cls !== "cons" ? `<div class="metric-row"><span>Себестоимость</span><strong class="value-multi">${finFmt(r, "own_cogs")}</strong></div>` : ""}
  </div>`;
}

async function loadReport() {
  const period = document.getElementById("report-period").value;
  const from = document.getElementById("report-from").value;
  const to = document.getElementById("report-to").value;
  const whSel = document.getElementById("report-warehouse");
  if (whSel && whSel.options.length <= 1 && warehouses.length) {
    const cur = whSel.value;
    whSel.innerHTML = '<option value="">Все склады</option>' +
      warehouses.map((w) => `<option value="${w.id}">${esc(w.name)}</option>`).join("");
    whSel.value = cur || "";
  }
  const whId = whSel?.value || "";
  const combinedEl = document.getElementById("report-combined");
  const q = (base) => {
    let u = `${base}?period=${period}`;
    if (from) u += `&date_from=${from}`;
    if (to) u += `&date_to=${to}`;
    if (whId) u += `&warehouse_id=${whId}`;
    return u;
  };

  if (reportType === "opiu") {
    const r = await api(q("/api/reports/opiu"));
    combinedEl.classList.add("hidden");
    const multi = r.multi_currency;
    const money = (n, cur) => (multi && !cur ? "—" : fmtCurrency(n, cur || currency_meta("TJS")));
    document.getElementById("report-content").innerHTML = `
      <div class="report-header"><h3>ОПиУ${r.warehouse_name ? ` · ${esc(r.warehouse_name)}` : ""}</h3><p>${r.period_label || ""}</p></div>
      ${renderCurrencyBreakdown(r.by_currency)}
      <div class="report-kpi">
        <div class="report-box"><div class="lbl">Выручка</div><div class="val">${multi ? "см. валюты" : money(r.revenue, r.by_currency?.[0])}</div></div>
        <div class="report-box"><div class="lbl">Валовая прибыль</div><div class="val">${multi ? "см. валюты" : money(r.gross_profit, r.by_currency?.[0])}</div></div>
        <div class="report-box"><div class="lbl">Расходы</div><div class="val">${money(r.operating_expenses, currency_meta("TJS"))}</div></div>
        <div class="report-box"><div class="lbl">Чистая прибыль</div><div class="val" style="color:var(--success)">${multi ? "см. валюты" : money(r.net_profit, r.by_currency?.[0])}</div></div>
      </div>
      ${(r.expenses_by_category || []).length ? `<div class="card"><div class="card-header"><h3>Расходы по категориям</h3><p class="hint" style="margin:0">Нажмите строку, чтобы открыть записи и откатить</p></div><div class="card-body table-wrap"><table class="data-table"><thead><tr><th>Категория</th><th>Отдел</th><th>Сумма</th></tr></thead><tbody>
        ${r.expenses_by_category.map((e) => `<tr class="row-clickable" data-exp-cat="${esc(e.category)}" data-exp-dept="${esc(e.department || "main")}">
          <td>${esc(e.category)}</td>
          <td>${e.department === "accessories" ? "Аксессуары" : "Основной"}</td>
          <td>${fmtCurrency(e.amount, currency_meta("TJS"))}</td>
        </tr>`).join("")}
      </tbody></table></div></div>` : ""}
      ${renderExpensesByWarehouse(r.operating_expenses, r.expenses_by_warehouse)}`;
    document.querySelectorAll("#report-content tr.row-clickable[data-exp-cat]").forEach((tr) => {
      tr.addEventListener("click", () => openExpenseCategoryDetail(tr.dataset.expCat, tr.dataset.expDept || "main"));
    });
    return;
  }
  if (reportType === "dds") {
    const r = await api(q("/api/reports/dds"));
    combinedEl.classList.add("hidden");
    const bags = r.by_currency || [];
    document.getElementById("report-content").innerHTML = `
      <div class="report-header"><h3>ДДС${r.warehouse_name ? ` · ${esc(r.warehouse_name)}` : ""}</h3><p>${r.period_label || ""}</p></div>
      <div class="report-kpi">
        <div class="report-box"><div class="lbl">Поступления</div><div class="val value-multi">${formatSideBags(bags, "inflow")}</div></div>
        <div class="report-box"><div class="lbl">Выплаты</div><div class="val value-multi">${formatSideBags(bags, "outflow")}</div></div>
        <div class="report-box"><div class="lbl">Чистый поток</div><div class="val value-multi">${formatSideBags(bags, "net")}</div></div>
      </div>
      <p class="hint">Доллары и сомони считаются отдельно — без смешивания в одну сумму.</p>
      <div class="card"><div class="card-body"><table class="data-table"><thead><tr><th>Валюта</th><th>Приход</th><th>Расход</th><th>Итого</th></tr></thead><tbody>
        ${(bags.length ? bags : [{ code: "USD", inflow: 0, outflow: 0, net: 0 }, { code: "TJS", inflow: 0, outflow: 0, net: 0 }]).map((c) => `
          <tr>
            <td><strong>${esc(c.name || c.code)}</strong></td>
            <td>${fmtCurrency(c.inflow || 0, currency_meta(c.code))}</td>
            <td>${fmtCurrency(c.outflow || 0, currency_meta(c.code))}</td>
            <td><strong>${fmtCurrency(c.net || 0, currency_meta(c.code))}</strong></td>
          </tr>`).join("")}
      </tbody></table></div></div>`;
    return;
  }
  if (reportType === "balance") {
    const r = await api(whId ? `/api/reports/balance?warehouse_id=${whId}` : "/api/reports/balance");
    combinedEl.classList.add("hidden");
    const bags = r.by_currency || [];
    document.getElementById("report-content").innerHTML = `
      <div class="report-header"><h3>Баланс${r.warehouse_name ? ` · ${esc(r.warehouse_name)}` : ""}</h3></div>
      <p class="hint">Доллары и сомони отдельно — без смешивания.</p>
      <div class="report-kpi">
        <div class="report-box"><div class="lbl">Деньги</div><div class="val value-multi">${formatSideBags(bags, "cash")}</div></div>
        <div class="report-box"><div class="lbl">Дебиторка</div><div class="val value-multi">${formatSideBags(bags, "receivables")}</div></div>
        <div class="report-box"><div class="lbl">Запасы</div><div class="val value-multi">${formatSideBags(bags, "inventory")}</div></div>
        <div class="report-box"><div class="lbl">Поставщикам</div><div class="val value-multi">${formatSideBags(bags, "supplier_payables")}</div></div>
        <div class="report-box"><div class="lbl">Капитал</div><div class="val value-multi">${formatSideBags(bags, "equity")}</div></div>
      </div>
      <div class="card"><div class="card-body"><table class="data-table"><thead><tr><th>Валюта</th><th>Деньги</th><th>Дебиторка</th><th>Запасы</th><th>Поставщикам</th><th>Капитал</th></tr></thead><tbody>
        ${bags.map((c) => `
          <tr>
            <td><strong>${esc(c.name || c.code)}</strong></td>
            <td>${moneyLine(c.cash, c.code)}</td>
            <td>${moneyLine(c.receivables, c.code)}</td>
            <td>${moneyLine(c.inventory, c.code)}</td>
            <td>${moneyLine(c.supplier_payables, c.code)}</td>
            <td><strong>${moneyLine(c.equity, c.code)}</strong></td>
          </tr>`).join("")}
      </tbody></table></div></div>`;
    return;
  }
  if (reportType === "customs") {
    const r = await api(q("/api/reports/customs"));
    combinedEl.classList.add("hidden");
    document.getElementById("report-content").innerHTML = `
      <div class="report-header"><h3>Растаможка${r.warehouse_name ? ` · ${esc(r.warehouse_name)}` : ""}</h3><p>${r.period_label || ""}</p></div>
      <div class="report-kpi">
        <div class="report-box"><div class="lbl">Сумма таможни</div><div class="val">${fmt(r.total_customs)}</div></div>
        <div class="report-box"><div class="lbl">Устройств</div><div class="val">${r.units_count}</div></div>
      </div>
      <div class="card"><div class="card-body table-wrap"><table class="data-table"><thead><tr><th>Чек</th><th>Дата</th><th>Товар</th><th>IMEI</th><th>Сумма</th></tr></thead><tbody>
        ${(r.items||[]).map(x=>`<tr><td>#${x.sale_id}</td><td>${x.created_at}</td><td>${esc(x.product_name)}</td><td>${esc(x.imei||x.serial||"—")}</td><td>${fmt(x.customs_price)}</td></tr>`).join("")||"<tr><td colspan=5>Нет данных</td></tr>"}
      </tbody></table></div></div>`;
    return;
  }
  if (reportType === "cashiers") {
    const r = await api(q("/api/reports/cashiers"));
    combinedEl.classList.add("hidden");
    document.getElementById("report-content").innerHTML = `
      <div class="report-header"><h3>Отчёт по кассирам${r.warehouse_name ? ` · ${esc(r.warehouse_name)}` : ""}</h3><p>${r.period_label || ""}</p></div>
      <div class="card"><div class="card-body table-wrap"><table class="data-table">
        <thead><tr><th>Кассир</th><th>Продаж</th><th>Выручка</th><th>Прибыль</th><th>Оплаты</th></tr></thead>
        <tbody>${(r.cashiers || []).map((c) => `<tr>
          <td><strong>${esc(c.cashier_name)}</strong> <span class="hint">${esc(c.currency_code || "")}</span></td>
          <td>${c.sales_count}</td>
          <td>${moneyLine(c.revenue, c.currency_code)}</td>
          <td>${moneyLine(c.profit, c.currency_code)}</td>
          <td style="font-size:.85rem">${(c.by_payment || []).map((p) => `${esc(p.name)} ${moneyLine(p.amount, p.currency_code || c.currency_code)}`).join("<br>") || "—"}</td>
        </tr>`).join("") || '<tr><td colspan="5" style="text-align:center;color:var(--muted)">Нет данных</td></tr>'}
        </tbody></table></div></div>`;
    return;
  }

  if (reportScope === "trade_ins") {
    let url = `/api/reports/trade-ins?period=${period}`;
    if (from) url += `&date_from=${from}`;
    if (to) url += `&date_to=${to}`;
    if (whId) url += `&warehouse_id=${whId}`;
    const r = await api(url);
    combinedEl.classList.add("hidden");
    document.getElementById("report-content").innerHTML = `
      <div class="report-header"><h3>Отчёт по обменам (trade-in)</h3><p>${r.period_label}</p></div>
      <div class="report-kpi">
        <div class="report-box"><div class="lbl">Сделок</div><div class="val">${r.deals_count}</div></div>
        <div class="report-box"><div class="lbl">Зачёт старых телефонов</div><div class="val">${fmt(r.total_trade_credit)}</div></div>
        <div class="report-box"><div class="lbl">Наличные доплата</div><div class="val">${fmt(r.total_cash)}</div></div>
        <div class="report-box"><div class="lbl">Карта доплата</div><div class="val">${fmt(r.total_card)}</div></div>
        <div class="report-box"><div class="lbl">Деньги в кассу</div><div class="val" style="color:var(--success)">${fmt(r.total_money)}</div></div>
        <div class="report-box"><div class="lbl">Объём сделок</div><div class="val">${fmt(r.total_deal_value)}</div></div>
      </div>
      ${r.by_warehouse?.length ? `<div class="card"><div class="card-header"><h3>По складам выдачи</h3></div><div class="card-body"><table class="data-table"><thead><tr><th>Склад</th><th>Сделок</th><th>Деньги</th><th>Зачёт</th></tr></thead><tbody>
        ${r.by_warehouse.map((w) => `<tr><td>${esc(w.warehouse_name)}</td><td>${w.deals}</td><td>${fmt(w.money)}</td><td>${fmt(w.trade_credit)}</td></tr>`).join("")}
      </tbody></table></div></div>` : ""}
      <div class="card"><div class="card-header"><h3>Детализация</h3></div><div class="card-body table-wrap"><table class="data-table"><thead><tr>
        <th>Дата</th><th>Выдано</th><th>Принято</th><th>Зачёт</th><th>Наличные</th><th>Карта</th><th>Склады</th>
      </tr></thead><tbody>
        ${r.items.map((t) => `<tr>
          <td>${t.created_at}</td>
          <td>${esc(t.given_product_name)}</td>
          <td>${esc(t.received_name)}</td>
          <td>${fmt(t.received_value)}</td>
          <td>${fmt(t.cash_amount)}</td>
          <td>${fmt(t.card_amount)}</td>
          <td>${esc(t.given_warehouse_name)} → ${esc(t.received_warehouse_name)}</td>
        </tr>`).join("") || '<tr><td colspan="7">Нет данных</td></tr>'}
      </tbody></table></div></div>`;
    return;
  }

  let url = `/api/reports/finance?scope=${reportScope}&period=${period}`;
  if (from) url += `&date_from=${from}`;
  if (to) url += `&date_to=${to}`;
  if (whId) url += `&warehouse_id=${whId}`;

  if (reportScope === "all" && !from && !to) {
    let combUrl = `/api/reports/combined?period=${period}`;
    if (whId) combUrl += `&warehouse_id=${whId}`;
    const combined = await api(combUrl);
    document.getElementById("report-content").innerHTML = renderReportBlock(combined.all, "Общий финансовый отчёт");
    combinedEl.classList.remove("hidden");
    document.getElementById("compare-grid").innerHTML =
      renderCompareCard(combined.all, "all", "Итого") +
      renderCompareCard(combined.own, "own", "Собственные") +
      renderCompareCard(combined.consignment, "cons", "Реализация");
  } else {
    const r = await api(url);
    document.getElementById("report-content").innerHTML = renderReportBlock(r, `Отчёт: ${scopeLabel(reportScope)}`);
    combinedEl.classList.add("hidden");
  }
}

async function openReportDetail() {
  const period = document.getElementById("report-period").value;
  const from = document.getElementById("report-from").value;
  const to = document.getElementById("report-to").value;
  const kind = reportType === "finance" ? "finance" : reportType;
  if (!["opiu", "dds", "finance"].includes(kind)) {
    toast("Детализация доступна для ОПиУ, ДДС и Финансов", "info");
    return;
  }
  const whSel = document.getElementById("report-detail-wh");
  const mainWh = document.getElementById("report-warehouse")?.value || "";
  if (whSel && whSel.options.length <= 1) {
    whSel.innerHTML = '<option value="">Все склады</option>' +
      warehouses.map((w) => `<option value="${w.id}">${esc(w.name)}</option>`).join("");
  }
  if (whSel && mainWh && !whSel.value) whSel.value = mainWh;
  const whId = whSel?.value || "";
  let url = `/api/reports/detail?kind=${kind}&period=${period}`;
  if (from) url += `&date_from=${from}`;
  if (to) url += `&date_to=${to}`;
  if (whId) url += `&warehouse_id=${whId}`;
  const r = await api(url);
  document.getElementById("report-detail-title").textContent = `Детализация · ${r.period_label}`;
  const whRows = (r.warehouses || []).map((w) => `<tr>
    <td><strong>${esc(w.warehouse_name)}</strong></td>
    <td class="value-multi">${formatSideBags(w.by_currency || [], "revenue")}</td>
    <td class="value-multi">${formatSideBags(w.by_currency || [], "inflows")}</td>
    <td>${moneyLine(w.expenses_allocated, "TJS")} <small class="muted">(${w.pct}%)</small></td>
    <td class="value-multi"><strong>${formatSideBags(w.by_currency || [], "profit")}</strong></td>
  </tr>`).join("");
  document.getElementById("report-detail-content").innerHTML = `
    <div class="card" style="margin-bottom:1rem"><div class="card-header"><h3>По складам</h3></div>
      <div class="table-wrap card-body"><table class="data-table">
        <thead><tr><th>Склад</th><th>Выручка</th><th>Приход</th><th>Расход смн (доля)</th><th>Прибыль</th></tr></thead>
        <tbody>${whRows || '<tr><td colspan="5">Нет данных</td></tr>'}</tbody>
      </table></div>
    </div>
    <div class="grid-2">
      <div class="card"><div class="card-header"><h3>Приходы (продажи)</h3></div>
        <div class="table-wrap card-body" style="max-height:240px;overflow:auto"><table class="data-table">
          <thead><tr><th>Дата</th><th>Чек</th><th>Способ</th><th>Сумма</th><th>Склад</th></tr></thead>
          <tbody>${(r.inflow_lines||[]).map((l)=>`<tr><td>${esc(l.created_at?.slice(0,16)||"")}</td><td>#${l.sale_id}</td><td>${esc(l.name||l.method_code)}</td><td>${moneyLine(l.amount, l.currency_code)}</td><td>${esc(l.warehouse_name)}</td></tr>`).join("")||'<tr><td colspan="5">Нет данных</td></tr>'}
          </tbody></table></div>
      </div>
      <div class="card"><div class="card-header"><h3>Расходы</h3></div>
        <div class="table-wrap card-body" style="max-height:240px;overflow:auto"><table class="data-table">
          <thead><tr><th>Дата</th><th>Категория</th><th>Кто</th><th>Сумма</th><th></th></tr></thead>
          <tbody>${(r.expense_lines||[]).map((e)=>`<tr>
            <td>${esc(e.expense_date)}</td>
            <td>${esc(e.category)}</td>
            <td>${esc(e.created_by || (e.description === "Excel импорт ОПиУ" ? "Excel импорт" : "—"))}</td>
            <td>${moneyLine(e.amount, "TJS")}</td>
            <td><button type="button" class="btn btn-danger btn-sm" data-rollback-exp="${e.id}">Откат</button></td>
          </tr>`).join("")||'<tr><td colspan="5">Нет данных</td></tr>'}
          </tbody></table></div>
      </div>
    </div>
    ${(r.receivable_collections||[]).length ? `<div class="card" style="margin-top:1rem"><div class="card-header"><h3>Погашение долгов</h3></div>
      <div class="table-wrap card-body"><table class="data-table"><thead><tr><th>Дата</th><th>Клиент</th><th>Сумма</th></tr></thead><tbody>
        ${r.receivable_collections.map((p)=>`<tr><td>${esc(p.created_at?.slice(0,16)||"")}</td><td>${esc(p.customer_name)}</td><td>${moneyLine(p.amount, p.currency_code || p.pay_currency_code)}</td></tr>`).join("")}
      </tbody></table></div></div>` : ""}`;
  document.getElementById("report-detail-content")?.querySelectorAll("[data-rollback-exp]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await rollbackExpense(+btn.dataset.rollbackExp);
      openReportDetail();
    });
  });
  document.getElementById("report-detail-modal").showModal();
}

let payDebtorTarget = null;
let mutualPayTarget = null;

function mutualFmt(n, code) {
  return fmtCurrency(n, currency_meta(code || "TJS"));
}

/** Sum amounts into { USD, TJS, ... } bags — never mix currencies as raw numbers. */
function sumMoneyByCurrency(items, amountKey = "amount_due", currencyKey = "currency_code") {
  const bags = {};
  for (const it of items || []) {
    const code = String(it[currencyKey] || "TJS").toUpperCase() || "TJS";
    bags[code] = (bags[code] || 0) + (+it[amountKey] || 0);
  }
  return bags;
}

/** Always two lines: dollars and somoni (never mix as one number). */
function formatCurrencyBags(bags) {
  const usd = +(bags?.USD || 0);
  const tjs = +(bags?.TJS || 0);
  return `
    <div class="bag-line bag-usd"><span class="bag-label">Доллары</span> <strong>${fmtCurrency(usd, currency_meta("USD"))}</strong></div>
    <div class="bag-line bag-tjs"><span class="bag-label">Сомони</span> <strong>${fmtCurrency(tjs, currency_meta("TJS"))}</strong></div>`;
}

function defaultUsdToTjsRate() {
  const r = getRate("USD");
  return r != null && r > 0 ? r : null;
}

function debtorPayDebtCurrency() {
  const row = mutualPayTarget || payDebtorTarget;
  return String(row?.currency_code || "TJS").toUpperCase() || "TJS";
}

function updateDebtorPayFxUI() {
  const debtCur = debtorPayDebtCurrency();
  const payCur = (document.getElementById("debtor-pay-currency")?.value || debtCur).toUpperCase();
  const rateWrap = document.getElementById("debtor-pay-rate-wrap");
  const hint = document.getElementById("debtor-pay-convert-hint");
  const amount = +document.getElementById("debtor-pay-amount")?.value || 0;
  const needFx = payCur !== debtCur;
  rateWrap?.classList.toggle("hidden", !needFx);
  if (!hint) return;
  if (!amount) {
    hint.textContent = `Долг в ${currencyLabel(debtCur)}`;
    return;
  }
  if (!needFx) {
    hint.textContent = `К долгу спишется ${fmtCurrency(amount, currency_meta(debtCur))}`;
    return;
  }
  const rate = +document.getElementById("debtor-pay-fx-rate")?.value || 0;
  if (rate <= 0) {
    hint.textContent = "Укажите курс: сколько сомони за 1 доллар";
    return;
  }
  let reduction = 0;
  if (debtCur === "USD" && payCur === "TJS") reduction = amount / rate;
  else if (debtCur === "TJS" && payCur === "USD") reduction = amount * rate;
  else {
    hint.textContent = "Неподдерживаемая пара валют";
    return;
  }
  hint.textContent =
    `Принято ${fmtCurrency(amount, currency_meta(payCur))} · курс 1$ = ${rate} смн → к долгу −${fmtCurrency(reduction, currency_meta(debtCur))}`;
}

function resetMutualEntryForm() {
  document.getElementById("mutual-entry-form")?.reset();
  document.getElementById("mutual-edit-id").value = "";
  document.getElementById("mutual-entry-title").textContent = "Новая запись — взаиморасчёт";
  document.getElementById("mutual-entry-delete")?.classList.add("hidden");
}

function bindDebtors() {
  document.getElementById("debtors-filter")?.addEventListener("change", loadDebtorsPage);
  document.getElementById("debtors-refresh")?.addEventListener("click", loadDebtorsPage);
  document.getElementById("mutual-add-btn")?.addEventListener("click", () => {
    resetMutualEntryForm();
    document.getElementById("mutual-entry-modal")?.showModal();
  });
  document.getElementById("mutual-entry-cancel")?.addEventListener("click", () => {
    document.getElementById("mutual-entry-modal")?.close();
  });
  document.getElementById("mutual-entry-delete")?.addEventListener("click", async () => {
    const id = +document.getElementById("mutual-edit-id").value;
    if (!id) return;
    if (!confirm("Удалить запись и все её оплаты? Это нельзя отменить.")) return;
    try {
      await api(`/api/mutual-entries/${id}`, { method: "DELETE" });
      document.getElementById("mutual-entry-modal")?.close();
      toast("Запись удалена");
      loadDebtorsPage();
    } catch (err) { toast(err.message, "error"); }
  });
  document.getElementById("mutual-entry-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const editId = +document.getElementById("mutual-edit-id").value || 0;
    const payload = {
      person_name: document.getElementById("mutual-name").value.trim(),
      person_phone: document.getElementById("mutual-phone").value.trim(),
      direction: document.getElementById("mutual-direction").value,
      product_note: document.getElementById("mutual-product").value.trim(),
      amount: +document.getElementById("mutual-amount").value,
      currency_code: document.getElementById("mutual-currency").value,
      notes: document.getElementById("mutual-notes").value.trim(),
    };
    try {
      if (editId) {
        await api(`/api/mutual-entries/${editId}`, { method: "PUT", body: JSON.stringify(payload) });
        toast("Запись обновлена");
      } else {
        await api("/api/mutual-entries", { method: "POST", body: JSON.stringify(payload) });
        toast("Запись добавлена");
      }
      document.getElementById("mutual-entry-modal")?.close();
      loadDebtorsPage();
    } catch (err) { toast(err.message, "error"); }
  });
  document.getElementById("debtor-pay-cancel")?.addEventListener("click", () => {
    document.getElementById("debtor-pay-modal").close();
    payDebtorTarget = null;
    mutualPayTarget = null;
  });
  ["debtor-pay-amount", "debtor-pay-currency", "debtor-pay-fx-rate"].forEach((id) => {
    document.getElementById(id)?.addEventListener("input", updateDebtorPayFxUI);
    document.getElementById(id)?.addEventListener("change", updateDebtorPayFxUI);
  });
  document.getElementById("debtor-pay-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const amount = +document.getElementById("debtor-pay-amount").value;
    const payCur = (document.getElementById("debtor-pay-currency").value || "TJS").toUpperCase();
    const debtCur = debtorPayDebtCurrency();
    const fxRaw = +document.getElementById("debtor-pay-fx-rate").value;
    const body = {
      amount,
      payment_method_code: document.getElementById("debtor-pay-method").value,
      notes: document.getElementById("debtor-pay-notes").value,
      currency_code: payCur,
      fx_rate: payCur !== debtCur ? fxRaw : null,
    };
    if (payCur !== debtCur && !(fxRaw > 0)) {
      toast("Укажите курс: сколько сомони за 1 доллар", "error");
      return;
    }
    try {
      if (mutualPayTarget) {
        await api(`/api/mutual-entries/${mutualPayTarget.id}/pay`, { method: "POST", body: JSON.stringify(body) });
      } else if (payDebtorTarget) {
        await api(`/api/receivables/${payDebtorTarget.id}/pay`, { method: "POST", body: JSON.stringify(body) });
      } else return;
      document.getElementById("debtor-pay-modal").close();
      toast("Оплата принята");
      loadDebtorsPage();
      if (currentPage === "pos") loadPosCashRegister();
    } catch (err) { toast(err.message, "error"); }
  });
}

async function loadDebtorHistory(kind, id, title) {
  const panel = document.getElementById("debtor-history-panel");
  const tb = document.getElementById("debtor-history-tbody");
  if (!panel || !tb) return;
  document.getElementById("debtor-history-title").textContent = title;
  panel.classList.remove("hidden");
  tb.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--muted)">Загрузка…</td></tr>';
  const path = kind === "mutual"
    ? `/api/mutual-entries/${id}/payments`
    : `/api/receivables/${id}/payments`;
  const items = await api(path).catch(() => []);
  tb.innerHTML = items.map((p) => {
    const payCur = (p.pay_currency_code || "").toUpperCase();
    const payAmt = p.pay_amount != null ? +p.pay_amount : +p.amount;
    const reduction = +p.amount;
    const payPart = payCur
      ? fmtCurrency(payAmt, currency_meta(payCur))
      : fmt(payAmt);
    const ratePart = p.fx_rate ? `, курс 1$=${p.fx_rate}` : "";
    const reducePart = payCur && Math.abs(payAmt - reduction) > 0.005
      ? `<br><span class="hint">к долгу −${fmt(reduction)}${ratePart}</span>`
      : (ratePart ? `<br><span class="hint">${ratePart.slice(2)}</span>` : "");
    return `
    <tr>
      <td>${esc(p.created_at?.slice(0, 16) || "")}</td>
      <td>${payPart}${reducePart}</td>
      <td>${esc(payLabel(p.payment_method_code))}</td>
      <td>${esc(p.notes || "—")}</td>
    </tr>`;
  }).join("") || '<tr><td colspan="4" style="text-align:center;color:var(--muted)">Оплат пока нет</td></tr>';
}

async function loadDebtorsPage() {
  const status = document.getElementById("debtors-filter")?.value || "";
  let rUrl = "/api/receivables";
  let mUrl = "/api/mutual-entries";
  if (status) {
    rUrl += `?status=${status}`;
    mUrl += `?status=${status}`;
  }
  const [receivables, mutual, creditorsData] = await Promise.all([
    api(rUrl),
    api(mUrl),
    api("/api/creditors").catch(() => ({ creditors: [], total_balance: 0 })),
  ]);
  creditorsCache = creditorsData.creditors || [];
  const clientsOwe = [
    ...receivables.filter((d) => d.status === "open").map((d) => ({
      amount_due: d.amount_due,
      currency_code: d.currency_code || "TJS",
    })),
    ...mutual.filter((m) => m.direction === "owe_us" && m.status === "open").map((m) => ({
      amount_due: m.amount_due,
      currency_code: m.currency_code || "TJS",
    })),
  ];
  const weOwe = mutual
    .filter((m) => m.direction === "we_owe" && m.status === "open")
    .map((m) => ({ amount_due: m.amount_due, currency_code: m.currency_code || "TJS" }));
  const summaryEl = document.getElementById("debtors-summary");
  if (summaryEl) {
    const suppliersBag = { USD: 0, TJS: 0 };
    for (const b of creditorsData.by_currency || []) {
      suppliersBag[b.code] = (suppliersBag[b.code] || 0) + (+b.balance || 0);
    }
    summaryEl.innerHTML = `
      <div class="kpi accent-green"><div class="label">Клиенты должны</div><div class="value value-multi">${formatCurrencyBags(sumMoneyByCurrency(clientsOwe))}</div></div>
      <div class="kpi accent-warn"><div class="label">Мы должны людям</div><div class="value value-multi">${formatCurrencyBags(sumMoneyByCurrency(weOwe))}</div></div>
      <div class="kpi accent-blue"><div class="label">Поставщикам</div><div class="value value-multi">${formatCurrencyBags(suppliersBag)}</div></div>`;
  }
  const supplierRows = (status === "closed" ? [] : creditorsCache.filter((c) => (c.by_currency || []).some((b) => +b.balance > 0.01))).flatMap((c) => {
    const bags = (c.by_currency || []).filter((b) => +b.balance > 0.01);
    return bags.map((b) => ({
      kind: "supplier",
      id: `${c.supplier_name}::${b.code}`,
      name: c.supplier_name,
      phone: "—",
      product: `Реализация · ${c.sales_count || 0} продаж`,
      warehouse: "Поставщик",
      total: b.accrued_due,
      paid: b.paid,
      due: b.balance,
      status: "open",
      date: "",
      currency: b.code || "TJS",
      direction: "we_owe",
      supplier_name: c.supplier_name,
    }));
  });
  const rows = [
    ...receivables.map((d) => ({
      kind: "sale",
      id: d.id,
      name: d.customer_name,
      phone: d.customer_phone,
      product: d.products || "—",
      warehouse: d.warehouse_name,
      total: d.total_amount,
      paid: d.paid_amount,
      due: d.amount_due,
      status: d.status,
      date: d.created_at,
      currency: d.currency_code || "TJS",
      direction: "owe_us",
    })),
    ...mutual.map((m) => ({
      kind: "mutual",
      id: m.id,
      name: m.person_name,
      phone: m.person_phone,
      product: m.product_note || m.notes || "—",
      warehouse: m.direction === "we_owe" ? "Мы должны" : "Нам должны",
      total: m.amount,
      paid: m.paid_amount,
      due: m.amount_due,
      status: m.status,
      date: m.created_at,
      currency: m.currency_code,
      direction: m.direction,
    })),
    ...supplierRows,
  ].sort((a, b) => String(b.date).localeCompare(String(a.date)));
  document.getElementById("debtors-tbody").innerHTML = rows.map((d) => {
    const typeLabel = d.kind === "sale"
      ? `<span class="tag">Продажа</span>`
      : d.kind === "supplier"
      ? `<span class="tag">Поставщик</span>`
      : `<span class="tag">${d.direction === "we_owe" ? "Мы должны" : "Займ"}</span>`;
    const money = (n) => mutualFmt(n, d.currency || "TJS");
    const idArg = typeof d.id === "number" ? d.id : `'${String(d.id).replace(/'/g, "\\'")}'`;
    const supplierName = d.supplier_name || d.name;
    const actions = d.kind === "supplier"
      ? `<button type="button" class="btn btn-ghost btn-sm" onclick='openCreditorSalesModal(${JSON.stringify(supplierName)})'>Продажи</button>
         ${d.status === "open" ? `<button class="btn btn-primary btn-sm" onclick='openCreditorPayModal(${JSON.stringify(supplierName)})'>Выплатить</button>` : `<span class="tag">Закрыт</span>`}`
      : `<button type="button" class="btn btn-ghost btn-sm" onclick="showDebtHistory('${d.kind}', ${idArg})">История</button>
         ${d.kind === "mutual" ? `<button type="button" class="btn btn-secondary btn-sm" onclick="openMutualEditModal(${d.id})">Редактировать</button>` : ""}
         ${d.status === "open"
           ? `<button class="btn btn-primary btn-sm" onclick="openDebtorPayModal('${d.kind}', ${idArg})">Оплата</button>`
           : `<span class="tag">Закрыт</span>`}`;
    return `
    <tr>
      <td>${typeLabel}</td>
      <td><strong>${esc(d.name)}</strong></td>
      <td>${esc(d.phone || "—")}</td>
      <td>${esc(d.product)}${d.warehouse && d.kind === "sale" ? `<br><span class="hint">${esc(d.warehouse)}</span>` : ""}</td>
      <td>${money(d.total)}</td>
      <td>${money(d.paid)}</td>
      <td class="${d.due > 0 ? "stock-low" : ""}"><strong>${money(d.due)}</strong></td>
      <td>${esc(d.date?.slice(0, 10) || "")}</td>
      <td class="table-actions">${actions}</td>
    </tr>`;
  }).join("") || '<tr><td colspan="9" style="text-align:center;color:var(--muted)">Нет записей</td></tr>';
}

window.showDebtHistory = (kind, id) => {
  loadDebtorHistory(kind, id, kind === "mutual" ? "История оплат (займ)" : "История оплат (продажа)");
};

window.openMutualEditModal = async (id) => {
  const items = await api("/api/mutual-entries").catch(() => []);
  const row = items.find((d) => d.id === id);
  if (!row) { toast("Запись не найдена", "error"); return; }
  document.getElementById("mutual-edit-id").value = String(row.id);
  document.getElementById("mutual-entry-title").textContent = "Редактировать запись";
  document.getElementById("mutual-name").value = row.person_name || "";
  document.getElementById("mutual-phone").value = row.person_phone || "";
  document.getElementById("mutual-direction").value = row.direction || "owe_us";
  document.getElementById("mutual-product").value = row.product_note || "";
  document.getElementById("mutual-amount").value = row.amount;
  document.getElementById("mutual-currency").value = (row.currency_code || "TJS").toUpperCase();
  document.getElementById("mutual-notes").value = row.notes || "";
  document.getElementById("mutual-entry-delete")?.classList.remove("hidden");
  document.getElementById("mutual-entry-modal")?.showModal();
};

window.openDebtorPayModal = async (kind, id) => {
  payDebtorTarget = null;
  mutualPayTarget = null;
  let full;
  if (kind === "mutual") {
    const items = await api("/api/mutual-entries?status=open");
    full = items.find((d) => d.id === id) || (await api("/api/mutual-entries")).find((d) => d.id === id);
    mutualPayTarget = full;
  } else {
    full = (await api("/api/receivables")).find((d) => d.id === id);
    payDebtorTarget = full;
  }
  if (!full) return;
  const debtCur = String(full.currency_code || "TJS").toUpperCase() || "TJS";
  const dueLabel = mutualFmt(full.amount_due, debtCur);
  const who = full.customer_name || full.person_name;
  document.getElementById("debtor-pay-meta").innerHTML = `
    <div class="metric-row"><span>${esc(who)}</span><strong>Долг ${dueLabel}</strong></div>
    <p class="hint">Валюта долга: ${currencyLabel(debtCur)}. Если платят в другой валюте — укажите курс.</p>`;
  document.getElementById("debtor-pay-amount").value = full.amount_due;
  document.getElementById("debtor-pay-currency").value = debtCur;
  const rateEl = document.getElementById("debtor-pay-fx-rate");
  const defRate = defaultUsdToTjsRate();
  if (rateEl) rateEl.value = defRate != null ? defRate : "";
  document.getElementById("debtor-pay-notes").value = "";
  fillPaySelect(document.getElementById("debtor-pay-method"));
  updateDebtorPayFxUI();
  document.getElementById("debtor-pay-modal").showModal();
};

/* ── Creditors (кредиторка) ── */
let payCreditorTarget = null;
let creditorsCache = [];

function bindCreditors() {
  document.getElementById("creditors-refresh")?.addEventListener("click", loadCreditorsPage);
  document.getElementById("creditors-search")?.addEventListener("input", debounce(loadCreditorsPage, 280));
  document.getElementById("creditor-pay-cancel")?.addEventListener("click", () => {
    document.getElementById("creditor-pay-modal").close();
    payCreditorTarget = null;
  });
  document.getElementById("creditor-sales-close")?.addEventListener("click", () => {
    document.getElementById("creditor-sales-modal").close();
  });
  document.getElementById("creditor-pay-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!payCreditorTarget) return;
    try {
      await api("/api/supplier-payments", {
        method: "POST",
        body: JSON.stringify({
          supplier_name: payCreditorTarget.supplier_name,
          amount: +document.getElementById("creditor-pay-amount").value,
          payment_method_code: document.getElementById("creditor-pay-method").value,
          notes: document.getElementById("creditor-pay-notes").value,
        }),
      });
      document.getElementById("creditor-pay-modal").close();
      toast("Выплата зафиксирована");
      loadCreditorsPage();
      if (currentPage === "products-consignment") loadSuppliers();
      if (currentPage === "dashboard") loadDashboard();
    } catch (err) { toast(err.message, "error"); }
  });
}

function creditorOpen(c) {
  return (c?.by_currency || []).some((b) => +b.balance > 0.01);
}
function creditorDefaultPayAmount(c) {
  const bags = c?.by_currency || [];
  const tjs = bags.find((b) => b.code === "TJS");
  if (tjs && +tjs.balance > 0) return +tjs.balance;
  return +(bags.find((b) => +b.balance > 0)?.balance || 0);
}

async function loadCreditorsPage() {
  const data = await api("/api/creditors");
  creditorsCache = data.creditors || [];
  const q = (document.getElementById("creditors-search")?.value || "").trim().toLowerCase();
  const filtered = q
    ? creditorsCache.filter((c) => c.supplier_name.toLowerCase().includes(q))
    : creditorsCache;
  const openCount = creditorsCache.filter(creditorOpen).length;
  const totalEl = document.getElementById("creditors-total-balance");
  if (totalEl) totalEl.innerHTML = formatSideBags(data.by_currency || [], "balance");
  document.getElementById("creditors-open-count").textContent = openCount;
  document.getElementById("creditors-tbody").innerHTML = filtered.map((c) => `
    <tr>
      <td><strong>${esc(c.supplier_name)}</strong></td>
      <td class="value-multi">${creditorBagsHtml(c, "accrued_due")}</td>
      <td class="value-multi">${creditorBagsHtml(c, "paid")}</td>
      <td class="value-multi ${creditorOpen(c) ? "stock-low" : ""}"><strong>${creditorBagsHtml(c, "balance")}</strong></td>
      <td>${c.sales_count || 0}</td>
      <td>
        <button class="btn btn-ghost btn-sm" onclick="openCreditorSalesModal(${JSON.stringify(c.supplier_name)})">Продажи</button>
        ${creditorOpen(c) ? `<button class="btn btn-primary btn-sm" onclick="openCreditorPayModal(${JSON.stringify(c.supplier_name)})">Выплатить</button>` : ""}
      </td>
    </tr>`).join("") || '<tr><td colspan="6" style="text-align:center;color:var(--muted)">Нет поставщиков</td></tr>';
  document.getElementById("creditors-payments-list").innerHTML = (data.recent_payments || []).slice(0, 15).map((p) => `
    <div class="pay-row"><span>${esc(p.supplier_name)} · ${p.created_at?.slice(0, 10) || ""}</span><strong>−${moneyLine(p.amount, p.currency_code)}</strong></div>
  `).join("") || '<p style="color:var(--muted);font-size:.8rem">Нет выплат</p>';
}

window.openCreditorPayModal = (name) => {
  payCreditorTarget = creditorsCache.find((c) => c.supplier_name === name) || { supplier_name: name, by_currency: [] };
  document.getElementById("creditor-pay-meta").innerHTML = `
    <div class="metric-row"><span>${esc(payCreditorTarget.supplier_name)}</span><strong class="value-multi">Долг ${creditorBagsHtml(payCreditorTarget, "balance")}</strong></div>`;
  document.getElementById("creditor-pay-amount").value = Math.max(0, creditorDefaultPayAmount(payCreditorTarget));
  document.getElementById("creditor-pay-notes").value = "";
  fillPaySelect(document.getElementById("creditor-pay-method"));
  document.getElementById("creditor-pay-modal").showModal();
};

window.openCreditorSalesModal = async (name) => {
  const rows = await api(`/api/creditors/sales?supplier_name=${encodeURIComponent(name)}`);
  document.getElementById("creditor-sales-title").textContent = `Продажи — ${name}`;
  document.getElementById("creditor-sales-tbody").innerHTML = rows.map((r) => `
    <tr>
      <td>${esc(r.created_at?.slice(0, 10) || "")}</td>
      <td>#${r.sale_id}</td>
      <td>${esc(r.product_name)}</td>
      <td>${esc(r.warehouse_name || "—")}</td>
      <td>${moneyLine(r.subtotal, r.currency_code)}</td>
      <td><strong>${moneyLine(r.supplier_due, r.currency_code)}</strong></td>
      <td><button class="btn btn-ghost btn-sm" onclick="document.getElementById('creditor-sales-modal').close();showSale(${r.sale_id})">Детали</button></td>
    </tr>`).join("") || '<tr><td colspan="7" style="text-align:center;color:var(--muted)">Нет продаж</td></tr>';
  document.getElementById("creditor-sales-modal").showModal();
};

/* ── Analytics ── */
function bindAnalytics() {
  document.querySelectorAll("#analytics-scope .seg").forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll("#analytics-scope .seg").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      analyticsScope = b.dataset.scope;
      loadAnalytics();
    };
  });
  document.getElementById("analytics-period").onchange = loadAnalytics;
}

async function loadAnalytics() {
  const period = document.getElementById("analytics-period").value;
  const [summary, top, daily] = await Promise.all([
    api(`/api/analytics/summary?period=${period}&scope=${analyticsScope}`),
    api(`/api/analytics/top-products?period=${period}&scope=${analyticsScope}`),
    api(`/api/analytics/daily?days=30&scope=${analyticsScope}`),
  ]);

  const finBlock = (s) => ({ ...s, gross_revenue: s.revenue ?? s.gross_revenue, shop_profit: s.profit ?? s.shop_profit });

  document.getElementById("analytics-kpi").innerHTML = `
    ${summary.by_currency?.length ? `<div style="grid-column:1/-1">${renderCurrencyBreakdown(summary.by_currency)}</div>` : ""}
    <div class="kpi accent-blue"><div class="label">Выручка</div><div class="value">${finFmt(finBlock(summary), "gross_revenue")}</div><div class="sub">${summary.sales_count} продаж</div></div>
    <div class="kpi accent-green"><div class="label">Прибыль</div><div class="value">${finFmt(finBlock(summary), "shop_profit")}</div><div class="sub">маржа ${summary.margin_pct}%</div></div>
    <div class="kpi accent-warn"><div class="label">Расходы</div><div class="value">${fmtCurrency(summary.expenses || 0, currency_meta("TJS"))}</div><div class="sub">${(summary.expenses_by_category || []).length} категорий</div></div>
    ${analyticsScope !== "own" ? `<div class="kpi accent-cons"><div class="label">Поставщикам</div><div class="value value-multi">${finFmt(finBlock(summary), "supplier_due")}</div></div>` : ""}
    ${analyticsScope !== "consignment" ? `<div class="kpi"><div class="label">Себестоимость</div><div class="value value-multi">${finFmt(finBlock(summary), "own_cogs")}</div></div>` : ""}
    <div class="kpi"><div class="label">На складе</div><div class="value">${summary.products_count}</div><div class="sub">${(summary.stock_by_currency || []).map((s) => fmtCurrency(s.value, s)).join(" · ") || "—"} закупка</div></div>
    <div class="kpi accent-warn"><div class="label">Мало остатков</div><div class="value">${summary.low_stock_count}</div></div>
  `;

  // Aggregate daily by day for bar height (separate currencies in tooltip)
  const byDay = {};
  for (const d of daily) {
    const day = d.day;
    byDay[day] ||= { day, sales: 0, bags: {} };
    byDay[day].sales += +d.sales || 0;
    const code = (d.currency_code || "TJS").toUpperCase();
    byDay[day].bags[code] = (byDay[day].bags[code] || 0) + (+d.revenue || 0);
  }
  const dayRows = Object.values(byDay);
  const maxR = Math.max(...dayRows.map((d) => Object.values(d.bags).reduce((a, b) => a + b, 0)), 1);
  document.getElementById("daily-chart").innerHTML = dayRows.map((d) => {
    const sum = Object.values(d.bags).reduce((a, b) => a + b, 0);
    const h = Math.round((sum / maxR) * 150);
    const tip = Object.entries(d.bags).map(([c, v]) => `${c}: ${moneyLine(v, c)}`).join(" · ");
    return `<div class="bar-col" title="${d.day}: ${tip}"><div class="bar" style="height:${h}px"></div><span class="bl">${d.day.slice(5)}</span></div>`;
  }).join("") || '<div class="empty-state">Нет данных за выбранный период</div>';

  document.getElementById("top-products").innerHTML = top.length
    ? top.map((t) => `<div class="top-item"><span>${esc(t.name)} <span class="tag tag-${t.ownership_type === "consignment" ? "cons" : "own"}" style="font-size:.6rem">${t.qty} шт · ${(t.currency_code || "TJS").toUpperCase()}</span></span><span class="rev">${fmtCurrency(t.revenue, currency_meta(t.currency_code))}</span></div>`).join("")
    : '<div class="empty-state">Нет продаж за период</div>';

  if (analyticsScope === "all") {
    const [ownS, consS] = await Promise.all([
      api(`/api/analytics/summary?period=${period}&scope=own`),
      api(`/api/analytics/summary?period=${period}&scope=consignment`),
    ]);
    document.getElementById("scope-split").innerHTML = `
      <div class="split-row"><span class="tag tag-own">Свои</span> <span class="value-multi">${finFmt(finBlock(ownS), "gross_revenue")}</span></div>
      <div class="split-row"><span class="tag tag-cons">Реализация</span> <span class="value-multi">${finFmt(finBlock(consS), "gross_revenue")}</span></div>
      <div class="split-metrics">
        <div class="metric-row"><span>Прибыль (свои)</span><strong class="value-multi">${finFmt(finBlock(ownS), "shop_profit")}</strong></div>
        <div class="metric-row"><span>Комиссия (реализация)</span><strong class="value-multi">${finFmt(finBlock(consS), "shop_profit")}</strong></div>
      </div>`;
  } else {
    document.getElementById("scope-split").innerHTML = `<p class="scope-split-filter">Фильтр: ${scopeLabel(analyticsScope)}</p>
      <div class="metric-row"><span>Прибыль</span><strong class="value-multi">${finFmt(finBlock(summary), "shop_profit")}</strong></div>`;
  }
}

/* ── Stocktake ── */
let stocktakeData = null;

function hideStScanResults() {
  document.getElementById("st-scan-results")?.classList.add("hidden");
}

function stMatchText(hay, q, digits) {
  const t = String(hay || "").toLowerCase();
  if (!q) return true;
  if (t.includes(q)) return true;
  if (digits.length >= 3) {
    const td = t.replace(/\D/g, "");
    if (td.includes(digits)) return true;
  }
  return false;
}

function stScannedUnitIds() {
  return new Set((stocktakeData?.lines || []).filter((l) => l.unit_id).map((l) => l.unit_id));
}

function stCountedByProduct() {
  const map = {};
  for (const l of stocktakeData?.lines || []) {
    if (l.unit_id) continue;
    map[l.product_id] = (map[l.product_id] || 0) + (+l.quantity || 0);
  }
  return map;
}

function stSuggestItems(qRaw) {
  const q = (qRaw || "").trim().toLowerCase();
  const digits = q.replace(/\D/g, "");
  if (!q || !stocktakeData?.session) return [];
  const scanned = stScannedUnitIds();
  const counted = stCountedByProduct();
  const items = [];
  for (const u of stocktakeData.expected?.units || []) {
    if (scanned.has(u.id)) continue;
    const blob = [u.product_name, u.model, u.color, u.imei, u.serial, u.barcode].join(" ");
    if (!stMatchText(blob, q, digits)) continue;
    items.push({
      kind: "unit",
      unit_id: u.id,
      label: u.product_name || "Устройство",
      meta: [u.imei || u.serial || `#${u.id}`, u.color, u.serial && u.imei ? u.serial : ""].filter(Boolean).join(" · "),
    });
  }
  for (const p of stocktakeData.expected?.products || []) {
    if (+p.track_units) continue;
    const left = (+p.qty || 0) - (counted[p.id] || 0);
    if (left <= 0) continue;
    const blob = [p.name, p.model, p.color, p.barcode].join(" ");
    if (!stMatchText(blob, q, digits)) continue;
    items.push({
      kind: "product",
      product_id: p.id,
      label: p.name,
      meta: [p.color, p.barcode, `осталось ${left}`].filter(Boolean).join(" · "),
    });
  }
  return items.slice(0, 12);
}

function renderStScanResults(q) {
  const box = document.getElementById("st-scan-results");
  if (!box) return;
  const items = stSuggestItems(q);
  if (!(q || "").trim()) {
    box.classList.add("hidden");
    return;
  }
  if (!items.length) {
    box.innerHTML = `<div class="pos-search-empty">Ничего не найдено среди ожидаемых</div>`;
    box.classList.remove("hidden");
    return;
  }
  box.innerHTML = items.map((it, idx) => `
    <button type="button" class="pos-search-item" data-idx="${idx}">
      <span class="psi-name">${esc(it.label)}</span>
      <span class="psi-meta">${esc(it.meta)}</span>
    </button>`).join("");
  box.querySelectorAll(".pos-search-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      const it = items[+btn.dataset.idx];
      if (!it) return;
      hideStScanResults();
      if (it.kind === "unit") stSubmitScan({ unit_id: it.unit_id });
      else stSubmitScan({ product_id: it.product_id });
    });
  });
  box.classList.remove("hidden");
}

async function stSubmitScan(payload) {
  if (!stocktakeData?.session) return;
  const input = document.getElementById("st-scan-input");
  try {
    stocktakeData = await api(`/api/stocktake/${stocktakeData.session.id}/scan`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    if (input) {
      input.value = "";
      input.focus();
    }
    hideStScanResults();
    scanBeep(true);
    const last = stocktakeData.lines[0];
    document.getElementById("st-last-scan").textContent = last
      ? `+ ${last.product_name}${last.imei ? ` · ${last.imei}` : ""}${last.serial ? ` · ${last.serial}` : ""}`
      : "";
    renderStocktakeSessionPanel();
    renderStocktake();
    toast("Добавлено");
  } catch (err) {
    scanBeep(false);
    toast(err.message, "error");
  }
}

function bindStocktake() {
  document.getElementById("st-scan-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = document.getElementById("st-scan-input");
    const q = input?.value.trim();
    if (!q || !stocktakeData?.session) return;
    const suggestions = stSuggestItems(q);
    if (suggestions.length === 1) {
      const it = suggestions[0];
      if (it.kind === "unit") return stSubmitScan({ unit_id: it.unit_id });
      return stSubmitScan({ product_id: it.product_id });
    }
    if (suggestions.length > 1) {
      renderStScanResults(q);
      toast("Выберите вариант из списка", "error");
      return;
    }
    await stSubmitScan({ q });
  });
  document.getElementById("st-scan-input")?.addEventListener("input", debounce((e) => {
    renderStScanResults(e.target.value);
  }, 120));
  document.getElementById("st-scan-input")?.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideStScanResults();
    if (e.key === "ArrowDown") {
      const first = document.querySelector("#st-scan-results .pos-search-item");
      if (first) { e.preventDefault(); first.focus(); }
    }
  });
  document.addEventListener("click", (e) => {
    const wrap = document.querySelector(".st-scan-wrap");
    if (wrap && !wrap.contains(e.target)) hideStScanResults();
  });
}

async function loadStocktakePage() {
  if (!warehouses.length) await loadWarehouses();
  renderStocktakeSundayBanner();
  try {
    stocktakeData = await api("/api/stocktake/current");
  } catch {
    stocktakeData = { session: null };
  }
  renderStocktakeSessionPanel();
  renderStocktake();
  await loadStocktakeHistory();
}

function renderStocktakeSundayBanner() {
  const el = document.getElementById("st-sunday-banner");
  if (!el) return;
  const isSunday = new Date().getDay() === 0;
  el.classList.toggle("hidden", !isSunday);
  if (isSunday) {
    el.innerHTML = `<div class="card-body"><strong>📅 Воскресная инвентаризация.</strong> Сканируйте каждый телефон по IMEI — расхождения будут в отчёте ниже.</div>`;
  }
}

async function loadStocktakeHistory() {
  const tb = document.getElementById("st-history-tbody");
  if (!tb) return;
  try {
    const rows = await api("/api/stocktake/history?limit=20");
    tb.innerHTML = rows.map((s) => `
      <tr>
        <td>${esc(s.started_at?.slice(0, 16) || "")}</td>
        <td>${esc(s.warehouse_name || "—")}</td>
        <td>${esc(s.user_name || "—")}</td>
        <td><span class="tag">${s.status === "closed" ? "Завершена" : "Открыта"}</span></td>
        <td>${esc(s.notes || "—")}</td>
      </tr>`).join("") || '<tr><td colspan="5" style="text-align:center;color:var(--muted)">История пуста</td></tr>';
  } catch {
    tb.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--muted)">Нет доступа к истории</td></tr>';
  }
}

function renderStocktakeSessionPanel() {
  const panel = document.getElementById("st-session-panel");
  if (!panel) return;
  if (stocktakeData?.session) {
    const s = stocktakeData.session;
    const wh = warehouses.find((w) => w.id === s.warehouse_id);
    panel.innerHTML = `
      <div class="metric-row"><span>Склад</span><strong>${esc(wh?.name || s.warehouse_id)}</strong></div>
      <div class="metric-row"><span>Начата</span><strong>${s.started_at}</strong></div>
      <div class="metric-row"><span>Отсканировано</span><strong>${stocktakeData.counted_total} / ${stocktakeData.expected_total}</strong></div>
      <button type="button" class="btn btn-primary" style="margin-top:.75rem" id="st-complete-btn">Завершить и применить</button>
      <p class="hint" style="margin-top:.5rem">Каждый телефон — отдельный IMEI. Аксессуары корректируют остаток при завершении.</p>`;
    document.getElementById("st-complete-btn").onclick = completeStocktake;
    return;
  }
  panel.innerHTML = `
    <label>Склад<select id="st-wh-select" class="select">${warehouses.map((w) =>
      `<option value="${w.id}">${esc(w.name)}</option>`).join("")}</select></label>
    <label>Комментарий<input id="st-notes" class="input"></label>
    <button type="button" class="btn btn-primary" style="margin-top:.75rem" id="st-start-btn">Начать инвентаризацию</button>`;
  document.getElementById("st-start-btn").onclick = startStocktake;
}

async function startStocktake() {
  try {
    stocktakeData = await api("/api/stocktake/start", {
      method: "POST",
      body: JSON.stringify({
        warehouse_id: +document.getElementById("st-wh-select").value,
        notes: document.getElementById("st-notes").value,
      }),
    });
    toast("Инвентаризация начата");
    renderStocktakeSessionPanel();
    renderStocktake();
    document.getElementById("st-scan-input")?.focus();
  } catch (e) { toast(e.message, "error"); }
}

async function completeStocktake() {
  if (!stocktakeData?.session) return;
  if (!confirm("Завершить инвентаризацию? Остатки аксессуаров будут скорректированы.")) return;
  try {
    stocktakeData = await api(`/api/stocktake/${stocktakeData.session.id}/complete`, { method: "POST" });
    toast("Инвентаризация завершена");
    stocktakeData = { session: null };
    renderStocktakeSessionPanel();
    renderStocktake();
    loadStocktakeHistory();
  } catch (e) { toast(e.message, "error"); }
}

function renderStocktake() {
  const expTb = document.getElementById("st-expected-tbody");
  const linesTb = document.getElementById("st-lines-tbody");
  const varBody = document.getElementById("st-variance-body");
  if (!expTb) return;
  if (!stocktakeData?.session) {
    expTb.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--muted)">Начните инвентаризацию</td></tr>';
    if (linesTb) linesTb.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--muted)">—</td></tr>';
    if (varBody) varBody.innerHTML = "";
    return;
  }
  const scanned = stScannedUnitIds();
  const counted = stCountedByProduct();
  const rows = [];
  // Phones: one row per IMEI still expected
  for (const u of stocktakeData.expected?.units || []) {
    if (scanned.has(u.id)) continue;
    const code = u.imei || u.serial || `#${u.id}`;
    rows.push(`<tr>
      <td>${esc(u.product_name)}</td>
      <td>${dash(u.color)}</td>
      <td><strong>${esc(code)}</strong>${u.serial && u.imei ? ` <span class="muted">/ ${esc(u.serial)}</span>` : ""}</td>
      <td><button type="button" class="btn btn-ghost btn-sm" onclick="stScanUnit(${u.id})">✓</button></td>
    </tr>`);
  }
  // Accessories: remaining qty only
  for (const p of stocktakeData.expected?.products || []) {
    if (+p.track_units) continue;
    const left = (+p.qty || 0) - (counted[p.id] || 0);
    if (left <= 0) continue;
    rows.push(`<tr>
      <td>${esc(p.name)}</td>
      <td>${dash(p.color)}</td>
      <td>осталось <strong>${left}</strong>${p.barcode ? ` · ${esc(p.barcode)}` : ""}</td>
      <td><button type="button" class="btn btn-ghost btn-sm" onclick="stCountProduct(${p.id})">+1</button></td>
    </tr>`);
  }
  expTb.innerHTML = rows.join("") || '<tr><td colspan="4" style="text-align:center;color:var(--success)">Всё отсканировано</td></tr>';

  if (linesTb) {
    linesTb.innerHTML = (stocktakeData.lines || []).map((l) => `
      <tr>
        <td>${esc(l.product_name)}</td>
        <td>${l.unit_id ? dash(l.imei || l.serial) : "×1"}</td>
        <td>${dash(l.color)}</td>
        <td><button type="button" class="btn btn-ghost btn-sm" onclick="stUndoLine(${l.id})">✕</button></td>
      </tr>`).join("") || '<tr><td colspan="4" style="color:var(--muted)">Пока ничего</td></tr>';
  }
  const vars = stocktakeData.variances || [];
  const missing = stocktakeData.missing_units || [];
  if (varBody) {
    varBody.innerHTML = vars.length || missing.length
      ? `${vars.map((v) => `<div class="metric-row"><span>${esc(v.product_name)}${v.color ? ` (${esc(v.color)})` : ""}</span><strong>${v.counted} / ${v.expected} (${v.difference >= 0 ? "+" : ""}${v.difference})</strong></div>`).join("")}
         ${missing.length ? `<p class="hint" style="margin-top:.75rem">Не отсканировано IMEI: ${missing.length}</p>
           <div class="table-wrap"><table class="data-table"><thead><tr><th>Товар</th><th>Цвет</th><th>IMEI</th></tr></thead><tbody>
           ${missing.slice(0, 50).map((u) => `<tr><td>${esc(u.product_name)}</td><td>${dash(u.color)}</td><td>${esc(u.imei || u.serial || "#" + u.id)}</td></tr>`).join("")}
           </tbody></table></div>${missing.length > 50 ? "<p class=\"hint\">…</p>" : ""}`
           : ""}`
      : '<p style="color:var(--success)">Расхождений нет</p>';
  }
}

window.stScanUnit = (unitId) => stSubmitScan({ unit_id: unitId });

window.stCountProduct = async (productId) => {
  if (!stocktakeData?.session) return;
  try {
    stocktakeData = await api(`/api/stocktake/${stocktakeData.session.id}/count`, {
      method: "POST", body: JSON.stringify({ product_id: productId, quantity: 1 }),
    });
    renderStocktakeSessionPanel();
    renderStocktake();
    toast("+1");
  } catch (e) { toast(e.message, "error"); }
};

window.stUndoLine = async (lineId) => {
  if (!stocktakeData?.session) return;
  try {
    stocktakeData = await api(`/api/stocktake/${stocktakeData.session.id}/lines/${lineId}`, { method: "DELETE" });
    renderStocktakeSessionPanel();
    renderStocktake();
  } catch (e) { toast(e.message, "error"); }
};

init();
