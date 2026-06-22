const PIN_KEY = "telephons_pin";
let pin = localStorage.getItem(PIN_KEY) || "";
let products = [];
let warehouses = [];
let cart = [];
let paymentMethod = "cash";
let authRequired = false;
let currentPage = "dashboard";
let reportScope = "all";
let analyticsScope = "all";
let selectedWarehouseId = null;
let whStockViewTotal = false;
let tiGivenProducts = [];
let currentUser = null;
let allowedPages = null;
let openShift = null;
let imeiPickerResolve = null;
let catalogProducts = [];
let catalogDetailId = null;
let pendingProductImage = null;
let pendingProductImageUrl = null;

const ROLE_LABELS = { owner: "Владелец", warehouse: "Кладовщик", cashier: "Кассир" };

const fmt = (n) => new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB", maximumFractionDigits: 0 }).format(n);
const pct = (a, b) => b ? Math.round((a / b) * 100) : 0;
const catLabel = (c) => ({ phone: "Телефон", accessory: "Аксессуар" }[c] || c);
const ownLabel = (o) => ({ own: "Собственный", consignment: "Реализация" }[o] || o);
const payLabel = (p) => ({ cash: "Наличные", card: "Карта", transfer: "Перевод", trade_in: "Обмен" }[p] || p);
const scopeLabel = (s) => ({ all: "Общий", own: "Собственные", consignment: "Реализация", trade_ins: "Обмены" }[s] || s);
const conditionLabel = (c) => ({ new: "Новый", used: "Б/у", refurbished: "Восстановленный" }[c] || c);
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const dash = (s) => s ? esc(s) : "—";

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
  return [p.model, p.color, p.memory, p.ram, p.size].filter(Boolean).slice(0, 4)
    .map((s) => `<span class="spec-chip">${esc(s)}</span>`).join("");
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
    throw new Error("Неверный PIN");
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(typeof err.detail === "string" ? err.detail : `Ошибка ${res.status}`);
  }
  return res.json();
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
  catalog: "Каталог",
  warehouses: "Склады",
  "products-own": "Собственные товары",
  "products-consignment": "Товары под реализацию",
  suppliers: "Поставщики",
  "trade-in": "Обмен",
  shifts: "Смена",
  imei: "IMEI / Серийники",
  users: "Пользователи",
  reports: "Финансовые отчёты",
  analytics: "Аналитика",
};

function defaultWarehouseId() {
  const d = warehouses.find((w) => w.is_default);
  return d ? d.id : warehouses[0]?.id ?? null;
}

function whStock(p, whId) {
  if (!whId || !p) return p?.stock ?? 0;
  if (p.track_units && p.units_by_warehouse) {
    return +(p.units_by_warehouse[String(whId)] ?? p.units_by_warehouse[whId] ?? 0);
  }
  if (!p.stock_by_warehouse) return p.stock ?? 0;
  return +(p.stock_by_warehouse[String(whId)] ?? p.stock_by_warehouse[whId] ?? 0);
}

function canAccess(page) {
  return !allowedPages || allowedPages.includes(page);
}

function firstAllowedPage() {
  if (!allowedPages?.length) return "dashboard";
  return allowedPages.includes("dashboard") ? "dashboard" : allowedPages[0];
}

async function refreshSession() {
  if (authRequired && !pin) return;
  try {
    const data = await api("/api/auth/check", { method: "POST", body: JSON.stringify({ pin: pin || "" }) });
    currentUser = data.user;
    allowedPages = data.pages;
    openShift = data.open_shift;
  } catch {
    if (authRequired) throw new Error("auth");
    const shiftData = await api("/api/shifts/current").catch(() => ({ shift: null }));
    openShift = shiftData.shift;
  }
  updateTopbar();
  applyRoleNav();
}

function updateTopbar() {
  const actions = document.getElementById("topbar-actions");
  if (!actions) return;
  const shiftBadge = openShift
    ? `<span class="badge badge-ok">Смена #${openShift.id}</span>`
    : `<span class="badge badge-warn">Смена закрыта</span>`;
  const userBadge = currentUser
    ? `<span class="topbar-user">${esc(currentUser.name)} · ${ROLE_LABELS[currentUser.role] || currentUser.role}</span>`
    : "";
  actions.innerHTML = `${userBadge}${shiftBadge}<button class="btn btn-ghost btn-sm" id="btn-logout">Выход</button>`;
  document.getElementById("btn-logout")?.addEventListener("click", () => {
    pin = "";
    localStorage.removeItem(PIN_KEY);
    currentUser = null;
    allowedPages = null;
    openShift = null;
    showLogin();
  });
}

function applyRoleNav() {
  document.querySelectorAll(".nav-item").forEach((btn) => {
    const page = btn.dataset.page;
    btn.classList.toggle("hidden", allowedPages && !allowedPages.includes(page));
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

function fillWarehouseSelect(el, selectedId, { empty = false, emptyLabel = "— выберите —" } = {}) {
  if (!el) return;
  const cur = selectedId ?? el.value;
  el.innerHTML = (empty ? `<option value="">${emptyLabel}</option>` : "") +
    warehouses.map((w) => `<option value="${w.id}">${esc(w.name)}${w.is_default ? " ★" : ""}</option>`).join("");
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
    throw new Error(typeof err.detail === "string" ? err.detail : `Ошибка ${res.status}`);
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
    catalog: loadCatalog,
    warehouses: loadWarehousesPage,
    "products-own": loadOwnProducts,
    "products-consignment": loadConsProducts,
    suppliers: loadSuppliers,
    "trade-in": loadTradeInPage,
    shifts: loadShiftsPage,
    imei: loadImeiPage,
    users: loadUsersPage,
    reports: loadReport,
    analytics: loadAnalytics,
  };
  loaders[page]?.();
}

function bindNav() {
  document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.addEventListener("click", () => navigate(btn.dataset.page));
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
  fillWarehouseSelect(document.getElementById("pos-warehouse"), defaultWarehouseId());
  fillWarehouseSelect(document.getElementById("pf-warehouse"), defaultWarehouseId());
  fillWarehouseSelect(document.getElementById("ti-given-warehouse"), defaultWarehouseId());
  fillWarehouseSelect(document.getElementById("ti-received-warehouse"), defaultWarehouseId());
  fillWarehouseSelect(document.getElementById("sm-to-warehouse"), null, { empty: true });
}

async function init() {
  try {
    const res = await fetch("/api/config");
    if (!res.ok) throw new Error("config");
    const cfg = await res.json();
    authRequired = cfg.auth_required;
    document.getElementById("store-name").textContent = cfg.store_name || "TeleStore";

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
    startClock();
    bindNav();
    bindPos();
    bindSales();
    bindProducts();
    bindCatalog();
    bindWarehouses();
    bindTradeIn();
    bindSuppliers();
    bindReports();
    bindAnalytics();
    bindShifts();
    bindImei();
    bindUsers();
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
    <div class="kpi accent-blue"><div class="label">Выручка сегодня</div><div class="value">${fmt(d.today.gross_revenue)}</div><div class="sub">${d.today.sales_count} продаж</div></div>
    <div class="kpi accent-green"><div class="label">Прибыль сегодня</div><div class="value">${fmt(d.today.shop_profit)}</div><div class="sub">маржа ${d.today.margin_pct}%</div></div>
    <div class="kpi accent-blue"><div class="label">Выручка за месяц</div><div class="value">${fmt(d.month.gross_revenue)}</div><div class="sub">${d.month.sales_count} продаж</div></div>
    <div class="kpi accent-warn"><div class="label">Мало на складе</div><div class="value">${d.low_stock_count}</div><div class="sub">позиций</div></div>
  `;
  document.getElementById("dash-today").innerHTML = `
    <div class="metric-row"><span>Выручка</span><strong>${fmt(d.today.gross_revenue)}</strong></div>
    <div class="metric-row"><span>Прибыль магазина</span><strong>${fmt(d.today.shop_profit)}</strong></div>
    <div class="metric-row"><span>К оплате поставщикам</span><strong>${fmt(d.today.supplier_due)}</strong></div>
    <div class="metric-row"><span>Себестоимость (свои)</span><strong>${fmt(d.today.own_cogs)}</strong></div>
  `;
  document.getElementById("dash-split").innerHTML = `
    <div class="metric-row"><span><span class="tag tag-own">Свои</span> Выручка</span><strong>${fmt(d.own_month.gross_revenue)}</strong></div>
    <div class="metric-row"><span><span class="tag tag-own">Свои</span> Прибыль</span><strong>${fmt(d.own_month.shop_profit)}</strong></div>
    <div class="metric-row"><span><span class="tag tag-cons">Реализация</span> Выручка</span><strong>${fmt(d.consignment_month.gross_revenue)}</strong></div>
    <div class="metric-row"><span><span class="tag tag-cons">Реализация</span> Комиссия</span><strong>${fmt(d.consignment_month.shop_profit)}</strong></div>
    <div class="metric-row"><span><span class="tag tag-cons">Реализация</span> Долг поставщикам</span><strong>${fmt(d.consignment_month.supplier_due)}</strong></div>
  `;
  const sup = d.supplier_balances;
  document.getElementById("dash-suppliers-card").classList.toggle("hidden", !sup.length);
  document.getElementById("dash-suppliers").innerHTML = sup.length
    ? `<table class="data-table"><thead><tr><th>Поставщик</th><th>К выплате</th></tr></thead><tbody>
        ${sup.map((s) => `<tr><td>${esc(s.supplier_name)}</td><td><strong>${fmt(s.balance)}</strong></td></tr>`).join("")}
       </tbody></table>`
    : '<p style="color:var(--muted)">Нет задолженности</p>';
}

/* ── POS ── */
function bindPos() {
  ["pos-search", "pos-category", "pos-ownership", "pos-warehouse"].forEach((id) => {
    const el = document.getElementById(id);
    el?.addEventListener(id === "pos-search" ? "input" : "change", debounce(() => {
      if (id === "pos-warehouse") cart = [];
      loadProducts();
    }, 250));
  });
  document.getElementById("pos-search").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const q = e.target.value.trim();
      const whId = +document.getElementById("pos-warehouse").value;
      const p = products.find((x) => x.barcode === q && whStock(x, whId) > 0);
      if (p) { addToCart(p.id); e.target.value = ""; loadProducts(); }
    }
  });
  document.querySelectorAll(".pay-btn").forEach((b) => b.addEventListener("click", () => {
    document.querySelectorAll(".pay-btn").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    paymentMethod = b.dataset.pay;
  }));
  document.getElementById("cart-discount").addEventListener("input", renderCart);
  document.getElementById("checkout-btn").addEventListener("click", checkout);
  document.getElementById("clear-cart-btn").addEventListener("click", () => { cart = []; renderCart(); });
}

async function loadPos() {
  if (!warehouses.length) await loadWarehouses();
  await refreshSession();
  fillWarehouseSelect(document.getElementById("pos-warehouse"), document.getElementById("pos-warehouse").value || defaultWarehouseId());
  await loadProducts();
}

async function loadProducts() {
  const q = document.getElementById("pos-search")?.value || "";
  const cat = document.getElementById("pos-category")?.value || "";
  const own = document.getElementById("pos-ownership")?.value || "";
  const wh = document.getElementById("pos-warehouse")?.value || "";
  let url = `/api/products?q=${encodeURIComponent(q)}`;
  if (cat) url += `&category=${cat}`;
  if (own) url += `&ownership_type=${own}`;
  if (wh) url += `&warehouse_id=${wh}`;
  products = await api(url);
  renderPosProducts();
  renderCart();
}

function renderPosProducts() {
  const grid = document.getElementById("pos-products");
  const whId = +document.getElementById("pos-warehouse")?.value;
  if (!products.length) { grid.innerHTML = '<p style="padding:1rem;color:var(--muted)">Товары не найдены</p>'; return; }
  grid.innerHTML = products.map((p) => {
    const stock = whStock(p, whId);
    const out = stock <= 0;
    const margin = p.sale_price - p.purchase_price;
    const meta = [p.model, p.color, p.memory].filter(Boolean).join(" · ");
    const imeiTag = p.track_units ? ' · <span class="tag" style="font-size:.6rem">IMEI</span>' : "";
    return `<div class="product-card ${out ? "out" : ""}" data-id="${p.id}">
      ${p.image_url ? `<div class="product-card-thumb"><img src="${esc(p.image_url)}" alt="" loading="lazy"></div>` : ""}
      <span class="tag tag-${p.ownership_type === "consignment" ? "cons" : "own"}">${ownLabel(p.ownership_type)}</span>
      <div class="name">${esc(p.name)}</div>
      <div class="meta">${esc(p.brand)} · ${catLabel(p.category)}${meta ? ` · ${esc(meta)}` : ""}${imeiTag}</div>
      <div class="price">${fmt(p.sale_price)}</div>
      <div class="meta">${out ? "Нет в наличии" : `Ост: ${stock} · +${fmt(margin)}`}</div>
    </div>`;
  }).join("");
  grid.querySelectorAll(".product-card:not(.out)").forEach((c) => {
    c.addEventListener("click", () => addToCart(+c.dataset.id));
  });
}

function addToCart(id) {
  const whId = +document.getElementById("pos-warehouse").value;
  const p = products.find((x) => x.id === id);
  const stock = whStock(p, whId);
  if (!p || stock <= 0) return;
  if (p.track_units) {
    pickImeiForProduct(p, whId).then((picked) => {
      if (!picked) return;
      const used = cart.flatMap((c) => c.unit_ids || []);
      if (used.includes(picked.id)) { toast("Этот IMEI уже в чеке", "error"); return; }
      cart.push({ product_id: id, quantity: 1, product: p, unit_ids: [picked.id], unit_labels: [picked.label] });
      renderCart();
    });
    return;
  }
  const ex = cart.find((c) => c.product_id === id && !c.unit_ids?.length);
  const qty = ex ? ex.quantity : 0;
  if (qty >= stock) { toast(`Макс. ${stock} шт.`, "error"); return; }
  if (ex) ex.quantity++; else cart.push({ product_id: id, quantity: 1, product: p, unit_ids: [] });
  renderCart();
}

async function pickImeiForProduct(product, whId) {
  const units = await api(`/api/products/${product.id}/units?warehouse_id=${whId}&status=in_stock`);
  const used = new Set(cart.flatMap((c) => c.unit_ids || []));
  const available = units.filter((u) => !used.has(u.id));
  if (!available.length) { toast("Нет доступных IMEI", "error"); return null; }
  const toPick = (u) => ({ id: u.id, label: u.imei || u.serial || `#${u.id}` });
  if (available.length === 1) return toPick(available[0]);
  return new Promise((resolve) => {
    imeiPickerResolve = resolve;
    document.getElementById("imei-picker-title").textContent = `IMEI: ${product.name}`;
    document.getElementById("imei-picker-list").innerHTML = available.map((u) =>
      `<button type="button" class="imei-pick-btn" data-id="${u.id}" data-label="${esc(u.imei || u.serial || `#${u.id}`)}">
        <strong>${esc(u.imei || u.serial || `#${u.id}`)}</strong>
        ${u.serial && u.imei ? `<span>${esc(u.serial)}</span>` : ""}
      </button>`
    ).join("");
    document.getElementById("imei-picker-list").querySelectorAll(".imei-pick-btn").forEach((btn) => {
      btn.onclick = () => {
        document.getElementById("imei-picker-modal").close();
        resolve({ id: +btn.dataset.id, label: btn.dataset.label });
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
    document.getElementById("cart-subtotal").textContent = "0 ₽";
    document.getElementById("cart-total").textContent = "0 ₽";
    return;
  }
  empty.classList.add("hidden");
  let sub = 0;
  box.innerHTML = cart.map((c, idx) => {
    const line = c.product.sale_price * c.quantity;
    sub += line;
    const imeiLabel = c.unit_labels?.length
      ? `<div class="ci-imei">${c.unit_labels.map((l) => esc(l)).join(", ")}</div>`
      : "";
    const qtyCtrl = c.unit_ids?.length
      ? `<span class="ci-qty-static">${c.quantity}</span>`
      : `<div class="ci-qty"><button onclick="changeQty(${c.product_id},-1)">−</button>${c.quantity}<button onclick="changeQty(${c.product_id},1)">+</button></div>`;
    return `<div class="cart-item">
      <div><div class="ci-name">${esc(c.product.name)}</div>
      <span class="tag tag-${c.product.ownership_type === "consignment" ? "cons" : "own"}" style="font-size:.6rem">${ownLabel(c.product.ownership_type)}</span>${imeiLabel}</div>
      ${qtyCtrl}
      <strong>${fmt(line)}</strong>
      ${c.unit_ids?.length ? `<button class="btn btn-ghost btn-sm" onclick="removeCartLine(${idx})">×</button>` : ""}
    </div>`;
  }).join("");
  const disc = +document.getElementById("cart-discount").value || 0;
  document.getElementById("cart-subtotal").textContent = fmt(sub);
  document.getElementById("cart-total").textContent = fmt(Math.max(0, sub - disc));
  const shiftHint = document.getElementById("pos-shift-hint");
  if (shiftHint) {
    if (!openShift) {
      shiftHint.textContent = "Смена не открыта — откройте в разделе «Смена»";
      shiftHint.classList.remove("hidden");
      document.getElementById("checkout-btn").disabled = true;
    } else {
      shiftHint.classList.add("hidden");
      document.getElementById("checkout-btn").disabled = false;
    }
  }
}

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

async function checkout() {
  if (!openShift) {
    toast("Сначала откройте смену", "error");
    return;
  }
  const discount = +document.getElementById("cart-discount").value || 0;
  const warehouse_id = +document.getElementById("pos-warehouse").value;
  try {
    const sale = await api("/api/sales", {
      method: "POST",
      body: JSON.stringify({
        items: cart.map((c) => ({
          product_id: c.product_id,
          quantity: c.quantity,
          unit_ids: c.unit_ids || [],
        })),
        discount, payment_method: paymentMethod, warehouse_id,
      }),
    });
    cart = [];
    document.getElementById("cart-discount").value = "0";
    renderCart();
    await loadProducts();
    await refreshSession();
    showReceipt(sale);
    toast("Продажа проведена");
  } catch (e) { toast(e.message, "error"); }
}

function showReceipt(sale) {
  document.getElementById("receipt-content").innerHTML = `
    <div class="rt">TeleStore ERP</div>
    <div style="text-align:center">Чек №${sale.id} · ${sale.created_at}</div>
    <hr>
    ${sale.items.map((i) => {
      const imei = i.units?.length ? ` [${i.units.map((u) => u.imei || u.serial).filter(Boolean).join(", ")}]` : "";
      return `<div>${esc(i.product_name)} ×${i.quantity}${esc(imei)} — ${fmt(i.subtotal)}</div>`;
    }).join("")}
    <hr>
    ${sale.discount > 0 ? `<div>Скидка: −${fmt(sale.discount)}</div>` : ""}
    <div style="text-align:right;font-weight:700;font-size:1.1rem">ИТОГО: ${fmt(sale.total)}</div>
    <div style="text-align:center;color:var(--muted)">${payLabel(sale.payment_method)}</div>`;
  document.getElementById("receipt-modal").showModal();
}
document.getElementById("receipt-close").onclick = () => document.getElementById("receipt-modal").close();
document.getElementById("receipt-print").onclick = () => {
  const w = window.open("", "_blank");
  w.document.write(document.getElementById("receipt-content").innerHTML);
  w.print();
};

/* ── Sales ── */
function bindSales() {
  document.getElementById("refresh-sales").onclick = loadSales;
  ["sales-from", "sales-to", "sales-ownership"].forEach((id) => {
    document.getElementById(id).addEventListener("change", loadSales);
  });
  document.getElementById("sale-detail-close").onclick = () => document.getElementById("sale-detail-modal").close();
}

async function loadSales() {
  const from = document.getElementById("sales-from").value;
  const to = document.getElementById("sales-to").value;
  const own = document.getElementById("sales-ownership").value;
  let url = `/api/sales?limit=100`;
  if (from) url += `&date_from=${from}`;
  if (to) url += `&date_to=${to}`;
  if (own) url += `&ownership_type=${own}`;
  const data = await api(url);
  const tb = document.getElementById("sales-tbody");
  if (!data.items.length) { tb.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--muted)">Нет продаж</td></tr>'; return; }
  tb.innerHTML = data.items.map((s) => `
    <tr>
      <td><strong>#${s.id}</strong></td>
      <td>${s.created_at}</td>
      <td><strong>${fmt(s.total)}</strong></td>
      <td>${payLabel(s.payment_method)}</td>
      <td>—</td>
      <td><button class="btn btn-ghost btn-sm" onclick="showSale(${s.id})">Детали</button></td>
    </tr>`).join("");
}

window.showSale = async (id) => {
  const sale = await api(`/api/sales/${id}`);
  const isOwner = !currentUser || currentUser.role === "owner";
  document.getElementById("sale-detail-content").innerHTML = `
    <h3>Продажа #${sale.id}</h3>
    <p style="color:var(--muted);margin:.5rem 0 1rem">${sale.created_at} · ${payLabel(sale.payment_method)}</p>
    <table class="data-table"><thead><tr><th>Товар</th><th>IMEI</th><th>Тип</th><th>Кол-во</th><th>Сумма</th><th>Прибыль</th></tr></thead>
    <tbody>${sale.items.map((i) => `<tr>
      <td>${esc(i.product_name)}</td>
      <td style="font-size:.8rem">${i.units?.length ? i.units.map((u) => esc(u.imei || u.serial || "—")).join("<br>") : "—"}</td>
      <td><span class="tag tag-${i.ownership_type === "consignment" ? "cons" : "own"}">${ownLabel(i.ownership_type)}</span></td>
      <td>${i.quantity}</td><td>${fmt(i.subtotal)}</td><td>${fmt(i.shop_profit)}</td>
    </tr>`).join("")}</tbody></table>
    <div style="margin-top:1rem;text-align:right;font-size:1.1rem;font-weight:700">Итого: ${fmt(sale.total)}</div>
    ${isOwner ? `<button class="btn btn-danger" style="margin-top:1rem" onclick="voidSale(${id})">Отменить продажу</button>` : ""}`;
  document.getElementById("sale-detail-modal").showModal();
};

window.voidSale = async (id) => {
  if (!confirm("Отменить? Товары вернутся на склад.")) return;
  try {
    await api(`/api/sales/${id}/void`, { method: "POST" });
    document.getElementById("sale-detail-modal").close();
    toast("Отменено");
    loadSales();
  } catch (e) { toast(e.message, "error"); }
};

/* ── Catalog ── */
function bindCatalog() {
  ["catalog-search", "catalog-category", "catalog-ownership", "catalog-sort"].forEach((id) => {
    const el = document.getElementById(id);
    el?.addEventListener(id === "catalog-search" ? "input" : "change", debounce(loadCatalog, 280));
  });
  document.getElementById("catalog-detail-close")?.addEventListener("click", () => {
    document.getElementById("catalog-detail-modal").close();
  });
  document.getElementById("catalog-detail-edit")?.addEventListener("click", () => {
    document.getElementById("catalog-detail-modal").close();
    if (catalogDetailId) editProduct(catalogDetailId);
  });
}

async function loadCatalog() {
  const q = document.getElementById("catalog-search")?.value || "";
  const cat = document.getElementById("catalog-category")?.value || "";
  const own = document.getElementById("catalog-ownership")?.value || "";
  const sort = document.getElementById("catalog-sort")?.value || "name";
  let url = `/api/products?q=${encodeURIComponent(q)}`;
  if (cat) url += `&category=${cat}`;
  if (own) url += `&ownership_type=${own}`;
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
        <div class="catalog-card-title">${esc(p.name)}</div>
        <div class="catalog-card-meta">${esc(p.brand || "—")}${p.sku ? ` · ${esc(p.sku)}` : ""}</div>
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
      <h3>${esc(p.name)}</h3>
      <div class="catalog-detail-brand">${esc(p.brand || "")}${p.supplier_name ? ` · ${esc(p.supplier_name)}` : ""}</div>
      <div class="catalog-detail-price">${fmt(p.sale_price)}</div>
      <span class="catalog-card-stock ${stockBadgeClass(p)}">${stockBadgeText(p)}</span>
      <div class="catalog-detail-specs">${specs}${whRows}</div>
      ${p.specs_extra ? `<div class="catalog-detail-extra">${esc(p.specs_extra)}</div>` : ""}
    </div>`;
  document.getElementById("catalog-detail-modal").showModal();
};

/* ── Warehouses ── */
function bindWarehouses() {
  document.getElementById("warehouse-cancel").onclick = () => document.getElementById("warehouse-modal").close();
  document.getElementById("warehouse-form").onsubmit = saveWarehouse;
  document.getElementById("stock-move-cancel").onclick = () => document.getElementById("stock-move-modal").close();
  document.getElementById("stock-move-form").onsubmit = submitStockMove;
  document.getElementById("wh-btn-inbound").onclick = () => openStockMoveModal("inbound");
  document.getElementById("wh-btn-outbound").onclick = () => openStockMoveModal("outbound");
  document.getElementById("wh-btn-transfer").onclick = () => openStockMoveModal("transfer");
  document.getElementById("wh-show-total").onclick = () => {
    whStockViewTotal = !whStockViewTotal;
    document.getElementById("wh-show-total").textContent = whStockViewTotal
      ? "Показать выбранный склад" : "Сводка по всем складам";
    loadWarehouseStock();
  };
  document.getElementById("wh-refresh-movements").onclick = loadWarehouseMovements;
  document.getElementById("transfer-doc-close").onclick = () => document.getElementById("transfer-doc-modal").close();
  document.getElementById("transfer-doc-print").onclick = () => printTransferDocument();
}

async function loadWarehousesPage() {
  if (!warehouses.length) await loadWarehouses();
  renderWarehouseList();
  if (!selectedWarehouseId) selectedWarehouseId = defaultWarehouseId();
  await loadWarehouseStock();
  await loadWarehouseMovements();
}

function renderWarehouseList() {
  const tb = document.getElementById("wh-list-tbody");
  tb.innerHTML = warehouses.map((w) => `
    <tr class="wh-row${w.id === selectedWarehouseId ? " wh-row-active" : ""}" data-id="${w.id}">
      <td><strong>${esc(w.name)}</strong>${w.is_default ? ' <span class="tag tag-own" style="font-size:.6rem">по умолч.</span>' : ""}</td>
      <td>${dash(w.address)}</td>
      <td><button class="btn btn-ghost btn-sm" onclick="selectWarehouse(${w.id})">Остатки</button></td>
      <td>
        <button class="btn btn-ghost btn-sm" onclick="editWarehouse(${w.id})">✎</button>
        <button class="btn btn-danger" onclick="deleteWarehouse(${w.id})">✕</button>
      </td>
    </tr>`).join("") || '<tr><td colspan="4" style="text-align:center;color:var(--muted)">Нет складов</td></tr>';
}

window.selectWarehouse = (id) => {
  selectedWarehouseId = id;
  whStockViewTotal = false;
  document.getElementById("wh-show-total").textContent = "Сводка по всем складам";
  renderWarehouseList();
  loadWarehouseStock();
};

async function loadWarehouseStock() {
  const tb = document.getElementById("wh-stock-tbody");
  const title = document.getElementById("wh-stock-title");
  const hasWh = selectedWarehouseId && !whStockViewTotal;
  document.getElementById("wh-btn-inbound").disabled = !hasWh;
  document.getElementById("wh-btn-outbound").disabled = !hasWh;
  document.getElementById("wh-btn-transfer").disabled = !hasWh;

  if (whStockViewTotal) {
    title.textContent = "Сводка по всем складам";
    const items = await api("/api/stock/total");
    tb.innerHTML = items.map((p) => `
      <tr>
        <td><strong>${esc(p.name)}</strong></td>
        <td>${dash(p.model)}</td>
        <td>${dash(p.color)}</td>
        <td><span class="tag tag-${p.category}">${catLabel(p.category)}</span></td>
        <td><strong>${p.stock}</strong></td>
      </tr>`).join("") || '<tr><td colspan="5" style="text-align:center;color:var(--muted)">Нет остатков</td></tr>';
    return;
  }

  const wh = warehouses.find((w) => w.id === selectedWarehouseId);
  title.textContent = wh ? `Остатки: ${wh.name}` : "Остатки склада";
  if (!selectedWarehouseId) {
    tb.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--muted)">Выберите склад</td></tr>';
    return;
  }
  const items = await api(`/api/warehouses/${selectedWarehouseId}/stock`);
  tb.innerHTML = items.map((p) => `
    <tr>
      <td><strong>${esc(p.name)}</strong></td>
      <td>${dash(p.model)}</td>
      <td>${dash(p.color)}</td>
      <td><span class="tag tag-${p.category}">${catLabel(p.category)}</span></td>
      <td><strong>${p.warehouse_quantity}</strong></td>
    </tr>`).join("") || '<tr><td colspan="5" style="text-align:center;color:var(--muted)">Нет остатков</td></tr>';
}

window.openWarehouseModal = (wh = null) => {
  document.getElementById("warehouse-modal-title").textContent = wh ? "Редактирование склада" : "Новый склад";
  document.getElementById("wf-id").value = wh ? wh.id : "";
  document.getElementById("wf-name").value = wh?.name || "";
  document.getElementById("wf-address").value = wh?.address || "";
  document.getElementById("wf-notes").value = wh?.notes || "";
  document.getElementById("wf-default").checked = !!wh?.is_default;
  document.getElementById("warehouse-modal").showModal();
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

async function openStockMoveModal(type) {
  if (!selectedWarehouseId) return;
  document.getElementById("sm-type").value = type;
  const titles = { inbound: "Приход на склад", outbound: "Расход со склада", transfer: "Перемещение" };
  document.getElementById("stock-move-title").textContent = titles[type];
  document.getElementById("sm-to-label").classList.toggle("hidden", type !== "transfer");
  fillWarehouseSelect(document.getElementById("sm-to-warehouse"), null, { empty: true, emptyLabel: "— склад назначения —" });

  let productOptions;
  if (type === "inbound") {
    const all = await api("/api/products");
    productOptions = all.map((p) => `<option value="${p.id}">${esc(p.name)} (${esc(p.sku)})</option>`).join("");
  } else {
    const stock = await api(`/api/warehouses/${selectedWarehouseId}/stock`);
    productOptions = stock.map((p) =>
      `<option value="${p.id}">${esc(p.name)} — ост: ${p.warehouse_quantity}</option>`
    ).join("");
  }
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

/* ── Shifts ── */
function bindShifts() {
  document.getElementById("shift-close-form").onsubmit = async (e) => {
    e.preventDefault();
    if (!openShift) return;
    try {
      const res = await api(`/api/shifts/${openShift.id}/close`, {
        method: "POST",
        body: JSON.stringify({
          actual_cash: +document.getElementById("shift-actual-cash").value,
          actual_card: +document.getElementById("shift-actual-card").value,
          notes: document.getElementById("shift-close-notes").value,
        }),
      });
      toast(`Смена закрыта. Разница нал.: ${fmt(res.cash_difference)}`);
      await refreshSession();
      loadShiftsPage();
    } catch (err) { toast(err.message, "error"); }
  };
}

async function loadShiftsPage() {
  await refreshSession();
  const cur = document.getElementById("shift-current");
  const closeCard = document.getElementById("shift-close-card");
  const closeBtn = document.getElementById("shift-close-btn");

  if (openShift) {
    const data = await api("/api/shifts/current");
    const s = data.summary;
    cur.innerHTML = `
      <div class="metric-row"><span>Смена</span><strong>#${openShift.id}</strong></div>
      <div class="metric-row"><span>Кассир</span><strong>${esc(openShift.user_name)}</strong></div>
      <div class="metric-row"><span>Открыта</span><strong>${openShift.opened_at}</strong></div>
      <div class="metric-row"><span>Размен</span><strong>${fmt(openShift.opening_cash)}</strong></div>
      <div class="metric-row"><span>Продаж</span><strong>${s.sales_count}</strong></div>
      <div class="metric-row"><span>Наличные (продажи)</span><strong>${fmt(s.expected_cash)}</strong></div>
      <div class="metric-row"><span>Карта</span><strong>${fmt(s.expected_card)}</strong></div>
      <div class="metric-row"><span>Ожидается в кассе</span><strong>${fmt(+openShift.opening_cash + s.expected_cash)}</strong></div>`;
    document.getElementById("shift-summary").innerHTML =
      `<p class="hint">Ожидаемые наличные: ${fmt(+openShift.opening_cash + s.expected_cash)} · карта: ${fmt(s.expected_card)}</p>`;
    closeCard.classList.remove("hidden");
    closeBtn.disabled = false;
  } else {
    cur.innerHTML = `
      <p style="color:var(--muted);margin-bottom:1rem">Смена не открыта. Укажите размен в кассе и откройте смену.</p>
      <label>Размен, ₽<input type="number" id="shift-opening-cash" class="input" min="0" value="0"></label>
      <button type="button" class="btn btn-primary" style="margin-top:.75rem" id="shift-open-btn">Открыть смену</button>`;
    closeCard.classList.add("hidden");
    document.getElementById("shift-open-btn").onclick = async () => {
      try {
        await api("/api/shifts/open", {
          method: "POST",
          body: JSON.stringify({ opening_cash: +document.getElementById("shift-opening-cash").value || 0 }),
        });
        toast("Смена открыта");
        await refreshSession();
        loadShiftsPage();
      } catch (err) { toast(err.message, "error"); }
    };
  }

  const histCard = document.querySelector("#page-shifts .card:last-child");
  if (currentUser?.role === "owner") {
    histCard?.classList.remove("hidden");
    const history = await api("/api/shifts?limit=30");
    document.getElementById("shifts-history-tbody").innerHTML = history.map((sh) => `
      <tr>
        <td>#${sh.id}</td>
        <td>${esc(sh.user_name)}</td>
        <td>${sh.opened_at}</td>
        <td>${sh.closed_at || "—"}</td>
        <td>${sh.sales_count ?? "—"}</td>
        <td>${sh.expected_cash != null ? fmt(+sh.expected_cash + +sh.opening_cash) : "—"}</td>
        <td>${sh.actual_cash != null && sh.expected_cash != null ? fmt(+sh.actual_cash - (+sh.opening_cash + +sh.expected_cash)) : "—"}</td>
      </tr>`).join("") || '<tr><td colspan="7" style="text-align:center;color:var(--muted)">Нет истории</td></tr>';
  } else {
    histCard?.classList.add("hidden");
  }
}

/* ── IMEI ── */
function bindImei() {
  document.getElementById("imei-form").onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api("/api/units", {
        method: "POST",
        body: JSON.stringify({
          product_id: +document.getElementById("imei-product").value,
          warehouse_id: +document.getElementById("imei-warehouse").value,
          imei: document.getElementById("imei-value").value.trim(),
          serial: document.getElementById("imei-serial").value.trim(),
          notes: document.getElementById("imei-notes").value.trim(),
        }),
      });
      toast("IMEI добавлен");
      document.getElementById("imei-form").reset();
      loadImeiPage();
    } catch (err) { toast(err.message, "error"); }
  };
  document.getElementById("imei-search").addEventListener("input", debounce(loadImeiList, 300));
  document.getElementById("imei-filter-wh").addEventListener("change", loadImeiList);
}

async function loadImeiPage() {
  if (!warehouses.length) await loadWarehouses();
  fillWarehouseSelect(document.getElementById("imei-warehouse"), defaultWarehouseId());
  const whSel = document.getElementById("imei-filter-wh");
  whSel.innerHTML = '<option value="">Все склады</option>' +
    warehouses.map((w) => `<option value="${w.id}">${esc(w.name)}</option>`).join("");
  const phones = await api("/api/products?category=phone");
  document.getElementById("imei-product").innerHTML = phones.map((p) =>
    `<option value="${p.id}">${esc(p.name)}${p.track_units ? " ★" : ""}</option>`
  ).join("");
  await loadImeiList();
}

async function loadImeiList() {
  const q = document.getElementById("imei-search").value.trim();
  const wh = document.getElementById("imei-filter-wh").value;
  let url = `/api/units?status=in_stock&q=${encodeURIComponent(q)}`;
  if (wh) url += `&warehouse_id=${wh}`;
  const units = await api(url);
  const statusLabel = (s) => ({ in_stock: "На складе", sold: "Продан" }[s] || s);
  document.getElementById("imei-tbody").innerHTML = units.map((u) => `
    <tr>
      <td><strong>${dash(u.imei)}</strong></td>
      <td>${dash(u.serial)}</td>
      <td>${esc(u.product_name)}</td>
      <td>${esc(u.warehouse_name)}</td>
      <td>${statusLabel(u.status)}</td>
      <td><button class="btn btn-ghost btn-sm" onclick="deleteUnit(${u.id})">Удалить</button></td>
    </tr>`).join("") || '<tr><td colspan="6" style="text-align:center;color:var(--muted)">Нет записей</td></tr>';
}

window.deleteUnit = async (id) => {
  if (!confirm("Удалить IMEI с учёта?")) return;
  try {
    await api(`/api/units/${id}`, { method: "DELETE" });
    toast("Удалено");
    loadImeiList();
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
  document.getElementById("product-cancel").onclick = () => {
    clearProductImagePending();
    document.getElementById("product-modal").close();
  };
  document.getElementById("product-form").onsubmit = saveProduct;
  document.getElementById("pf-image-file")?.addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    clearProductImagePending();
    pendingProductImage = file;
    pendingProductImageUrl = URL.createObjectURL(file);
    setProductImagePreview();
    e.target.value = "";
  });
  document.getElementById("pf-image-remove")?.addEventListener("click", async () => {
    const id = document.getElementById("pf-id").value;
    clearProductImagePending();
    if (id) {
      try {
        await api(`/api/products/${id}/image`, { method: "DELETE" });
        toast("Фото удалено");
      } catch (err) { toast(err.message, "error"); return; }
    }
    setProductImagePreview({ category: document.getElementById("pf-category").value });
  });
  document.getElementById("pf-category")?.addEventListener("change", () => {
    if (!pendingProductImageUrl && !document.getElementById("pf-id").value) setProductImagePreview();
  });
  ["pf-purchase", "pf-sale", "pf-ownership"].forEach((id) => {
    document.getElementById(id)?.addEventListener("input", updateMarginHint);
    document.getElementById(id)?.addEventListener("change", updateMarginHint);
  });
}

function updateMarginHint() {
  const own = document.getElementById("pf-ownership").value;
  const purchase = +document.getElementById("pf-purchase").value || 0;
  const sale = +document.getElementById("pf-sale").value || 0;
  const hint = document.getElementById("pf-margin-hint");
  const pl = document.getElementById("pf-purchase-label");
  if (own === "consignment") {
    pl.textContent = "Сумма поставщику за ед., ₽";
    hint.textContent = `Комиссия магазина: ${fmt(sale - purchase)} (${pct(sale - purchase, sale)}%) · Поставщику: ${fmt(purchase)}`;
  } else {
    pl.textContent = "Закупочная цена, ₽";
    hint.textContent = `Маржа: ${fmt(sale - purchase)} (${pct(sale - purchase, sale)}%)`;
  }
}

function setProductFormMode(isEdit, p = null) {
  const stockRow = document.getElementById("pf-stock-create-row");
  const minEditRow = document.getElementById("pf-min-stock-edit-row");
  const whRow = document.getElementById("pf-warehouse-row");
  const stockHint = document.getElementById("pf-stock-hint");
  if (isEdit) {
    stockRow.classList.add("hidden");
    minEditRow.classList.remove("hidden");
    whRow.classList.add("hidden");
    stockHint.classList.remove("hidden");
    document.getElementById("pf-min-stock-edit").value = p?.min_stock ?? 2;
    const parts = Object.entries(p?.stock_by_warehouse || {})
      .map(([wid, qty]) => {
        const w = warehouses.find((x) => x.id === +wid);
        return `${w?.name || `Склад #${wid}`}: ${qty}`;
      });
    stockHint.textContent = parts.length ? `Остатки по складам: ${parts.join(" · ")}` : `Общий остаток: ${p?.stock ?? 0}`;
  } else {
    stockRow.classList.remove("hidden");
    minEditRow.classList.add("hidden");
    whRow.classList.remove("hidden");
    stockHint.classList.add("hidden");
    fillWarehouseSelect(document.getElementById("pf-warehouse"), defaultWarehouseId());
  }
}

function fillProductCardFields(p = {}) {
  document.getElementById("pf-model").value = p.model || "";
  document.getElementById("pf-color").value = p.color || "";
  document.getElementById("pf-size").value = p.size || "";
  document.getElementById("pf-memory").value = p.memory || "";
  document.getElementById("pf-ram").value = p.ram || "";
  document.getElementById("pf-customs-cleared").checked = !!p.customs_cleared;
  document.getElementById("pf-customs-price").value = p.customs_price ?? 0;
  document.getElementById("pf-specs-extra").value = p.specs_extra || "";
  document.getElementById("pf-condition").value = p.condition || "new";
}

function productCardBody() {
  return {
    model: document.getElementById("pf-model").value,
    color: document.getElementById("pf-color").value,
    size: document.getElementById("pf-size").value,
    memory: document.getElementById("pf-memory").value,
    ram: document.getElementById("pf-ram").value,
    customs_cleared: document.getElementById("pf-customs-cleared").checked ? 1 : 0,
    customs_price: +document.getElementById("pf-customs-price").value || 0,
    specs_extra: document.getElementById("pf-specs-extra").value,
    condition: document.getElementById("pf-condition").value,
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
  const q = document.getElementById("cons-search").value;
  const sup = document.getElementById("cons-supplier-filter").value;
  let url = `/api/products?ownership_type=consignment&q=${encodeURIComponent(q)}`;
  if (sup) url += `&supplier=${encodeURIComponent(sup)}`;
  const items = await api(url);
  const suppliers = [...new Set(items.map((p) => p.supplier_name).filter(Boolean))];
  const sel = document.getElementById("cons-supplier-filter");
  const cur = sel.value;
  sel.innerHTML = '<option value="">Все поставщики</option>' + suppliers.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join("");
  sel.value = cur;
  document.getElementById("cons-tbody").innerHTML = items.map((p) => {
    const comm = p.sale_price - p.purchase_price;
    return `<tr>
      <td><strong>${esc(p.name)}</strong></td>
      <td>${dash(p.model)}</td>
      <td>${dash(p.color)}</td>
      <td>${dash(p.memory)}</td>
      <td>${esc(p.supplier_name)}</td>
      <td><span class="tag tag-${p.category}">${catLabel(p.category)}</span></td>
      <td>${fmt(p.purchase_price)}</td>
      <td>${fmt(p.sale_price)}</td>
      <td>${fmt(comm)} (${pct(comm, p.sale_price)}%)</td>
      <td class="${p.stock <= p.min_stock ? "stock-low" : ""}">${p.stock}</td>
      <td>
        <button class="btn btn-ghost btn-sm" onclick="editProduct(${p.id})">✎</button>
        <button class="btn btn-danger" onclick="deleteProduct(${p.id})">✕</button>
      </td></tr>`;
  }).join("") || '<tr><td colspan="11" style="text-align:center;color:var(--muted)">Нет товаров</td></tr>';
}

window.openProductModal = (ownership) => {
  clearProductImagePending();
  document.getElementById("product-modal-title").textContent = ownership === "consignment" ? "Товар под реализацию" : "Собственный товар";
  document.getElementById("pf-id").value = "";
  document.getElementById("pf-ownership").value = ownership;
  document.getElementById("pf-supplier-row").classList.toggle("hidden", ownership !== "consignment");
  ["pf-name","pf-brand","pf-sku","pf-barcode","pf-purchase","pf-sale","pf-stock","pf-supplier"].forEach((id) => {
    document.getElementById(id).value = id === "pf-stock" ? "0" : "";
  });
  fillProductCardFields();
  document.getElementById("pf-min-stock").value = "2";
  document.getElementById("pf-category").value = "accessory";
  setProductFormMode(false);
  setProductImagePreview({ category: "accessory" });
  updateMarginHint();
  document.getElementById("product-modal").showModal();
};

window.editProduct = async (id) => {
  clearProductImagePending();
  const p = await api(`/api/products/${id}`);
  if (!p) return;
  document.getElementById("product-modal-title").textContent = "Карточка товара";
  document.getElementById("pf-id").value = p.id;
  document.getElementById("pf-ownership").value = p.ownership_type;
  document.getElementById("pf-supplier-row").classList.toggle("hidden", p.ownership_type !== "consignment");
  document.getElementById("pf-name").value = p.name;
  document.getElementById("pf-category").value = p.category;
  document.getElementById("pf-brand").value = p.brand;
  document.getElementById("pf-supplier").value = p.supplier_name;
  document.getElementById("pf-sku").value = p.sku;
  document.getElementById("pf-barcode").value = p.barcode;
  document.getElementById("pf-purchase").value = p.purchase_price;
  document.getElementById("pf-sale").value = p.sale_price;
  document.getElementById("pf-min-stock").value = p.min_stock;
  fillProductCardFields(p);
  setProductFormMode(true, p);
  setProductImagePreview(p);
  updateMarginHint();
  document.getElementById("product-modal").showModal();
};

window.deleteProduct = async (id) => {
  if (!confirm("Удалить товар?")) return;
  try {
    await api(`/api/products/${id}`, { method: "DELETE" });
    toast("Удалено");
    loadOwnProducts();
    loadConsProducts();
    if (currentPage === "catalog") loadCatalog();
    if (currentPage === "pos") loadProducts();
  } catch (e) { toast(e.message, "error"); }
};

async function saveProduct(e) {
  e.preventDefault();
  const id = document.getElementById("pf-id").value;
  const body = {
    name: document.getElementById("pf-name").value,
    category: document.getElementById("pf-category").value,
    ownership_type: document.getElementById("pf-ownership").value,
    supplier_name: document.getElementById("pf-supplier").value,
    brand: document.getElementById("pf-brand").value,
    sku: document.getElementById("pf-sku").value,
    barcode: document.getElementById("pf-barcode").value,
    purchase_price: +document.getElementById("pf-purchase").value,
    sale_price: +document.getElementById("pf-sale").value,
    min_stock: id
      ? +document.getElementById("pf-min-stock-edit").value
      : +document.getElementById("pf-min-stock").value,
    ...productCardBody(),
  };
  if (!id) {
    body.stock = +document.getElementById("pf-stock").value;
    body.warehouse_id = +document.getElementById("pf-warehouse").value;
  }
  try {
    let productId = id;
    if (id) await api(`/api/products/${id}`, { method: "PUT", body: JSON.stringify(body) });
    else {
      const created = await api("/api/products", { method: "POST", body: JSON.stringify(body) });
      productId = created.id;
    }
    if (pendingProductImage && productId) {
      await apiUpload(`/api/products/${productId}/image`, pendingProductImage);
    }
    clearProductImagePending();
    document.getElementById("product-modal").close();
    toast("Сохранено");
    loadOwnProducts();
    loadConsProducts();
    if (currentPage === "catalog") loadCatalog();
    if (currentPage === "pos") loadProducts();
  } catch (err) { toast(err.message, "error"); }
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
      <td>${fmt(s.accrued_due)}</td>
      <td>${fmt(s.paid)}</td>
      <td class="${s.balance > 0 ? "stock-low" : ""}"><strong>${fmt(s.balance)}</strong></td>
    </tr>`).join("") || '<tr><td colspan="5" style="text-align:center;color:var(--muted)">Нет поставщиков</td></tr>';

  const sel = document.getElementById("pay-supplier");
  sel.innerHTML = suppliers.map((s) => `<option value="${esc(s.supplier_name)}">${esc(s.supplier_name)} (долг ${fmt(s.balance)})</option>`).join("");

  document.getElementById("payments-list").innerHTML = payments.slice(0, 20).map((p) => `
    <div class="pay-row"><span>${esc(p.supplier_name)} · ${p.created_at}</span><strong>−${fmt(p.amount)}</strong></div>
  `).join("") || '<p style="color:var(--muted);font-size:.8rem">Нет выплат</p>';
}

/* ── Reports ── */
function bindReports() {
  document.querySelectorAll("#report-scope .seg").forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll("#report-scope .seg").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      reportScope = b.dataset.scope;
      loadReport();
    };
  });
  document.getElementById("load-report").onclick = loadReport;
  document.getElementById("report-period").onchange = loadReport;
  document.getElementById("print-report").onclick = () => {
    const w = window.open("", "_blank");
    w.document.write(`<html><head><title>Отчёт</title><style>body{font-family:Arial;padding:24px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:6px}</style></head><body>${document.getElementById("report-content").innerHTML}${document.getElementById("report-combined").innerHTML}</body></html>`);
    w.print();
  };
}

function renderReportBlock(r, title) {
  return `
    <div class="report-header"><h3>${title}</h3><p>${r.period_label}</p></div>
    <div class="report-kpi">
      <div class="report-box"><div class="lbl">Выручка</div><div class="val">${fmt(r.gross_revenue)}</div></div>
      <div class="report-box"><div class="lbl">Продаж</div><div class="val">${r.sales_count}</div></div>
      <div class="report-box"><div class="lbl">Единиц</div><div class="val">${r.items_sold}</div></div>
      <div class="report-box"><div class="lbl">Прибыль магазина</div><div class="val" style="color:var(--success)">${fmt(r.shop_profit)}</div></div>
      <div class="report-box"><div class="lbl">Маржа</div><div class="val">${r.margin_pct}%</div></div>
      ${r.scope !== "consignment" ? `<div class="report-box"><div class="lbl">Себестоимость (свои)</div><div class="val">${fmt(r.own_cogs)}</div></div>` : ""}
      ${r.scope !== "own" ? `<div class="report-box"><div class="lbl">К оплате поставщикам</div><div class="val" style="color:var(--consignment)">${fmt(r.supplier_due)}</div></div>` : ""}
    </div>
    ${r.by_payment?.length ? `<div class="card"><div class="card-header"><h3>Оплата</h3></div><div class="card-body"><table class="data-table"><thead><tr><th>Способ</th><th>Чеков</th><th>Сумма</th></tr></thead><tbody>
      ${r.by_payment.map((p) => `<tr><td>${payLabel(p.method)}</td><td>${p.count}</td><td>${fmt(p.amount)}</td></tr>`).join("")}
    </tbody></table></div></div>` : ""}
    ${r.by_supplier?.length ? `<div class="card"><div class="card-header"><h3>По поставщикам</h3></div><div class="card-body"><table class="data-table"><thead><tr><th>Поставщик</th><th>Шт.</th><th>Выручка</th><th>Долг</th><th>Комиссия</th></tr></thead><tbody>
      ${r.by_supplier.map((s) => `<tr><td>${esc(s.supplier_name)}</td><td>${s.qty}</td><td>${fmt(s.revenue)}</td><td>${fmt(s.due)}</td><td>${fmt(s.profit)}</td></tr>`).join("")}
    </tbody></table></div></div>` : ""}`;
}

function renderCompareCard(r, cls, title) {
  return `<div class="compare-card ${cls}"><h4>${title}</h4>
    <div class="metric-row"><span>Выручка</span><strong>${fmt(r.gross_revenue)}</strong></div>
    <div class="metric-row"><span>Прибыль</span><strong>${fmt(r.shop_profit)}</strong></div>
    <div class="metric-row"><span>Маржа</span><strong>${r.margin_pct}%</strong></div>
    <div class="metric-row"><span>Продаж</span><strong>${r.sales_count}</strong></div>
    ${cls !== "own" ? `<div class="metric-row"><span>Поставщикам</span><strong>${fmt(r.supplier_due)}</strong></div>` : ""}
    ${cls !== "cons" ? `<div class="metric-row"><span>Себестоимость</span><strong>${fmt(r.own_cogs)}</strong></div>` : ""}
  </div>`;
}

async function loadReport() {
  const period = document.getElementById("report-period").value;
  const from = document.getElementById("report-from").value;
  const to = document.getElementById("report-to").value;
  const combinedEl = document.getElementById("report-combined");

  if (reportScope === "trade_ins") {
    let url = `/api/reports/trade-ins?period=${period}`;
    if (from) url += `&date_from=${from}`;
    if (to) url += `&date_to=${to}`;
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

  if (reportScope === "all" && !from && !to) {
    const combined = await api(`/api/reports/combined?period=${period}`);
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

  document.getElementById("analytics-kpi").innerHTML = `
    <div class="kpi accent-blue"><div class="label">Выручка</div><div class="value">${fmt(summary.revenue)}</div><div class="sub">${summary.sales_count} продаж</div></div>
    <div class="kpi accent-green"><div class="label">Прибыль</div><div class="value">${fmt(summary.profit)}</div><div class="sub">маржа ${summary.margin_pct}%</div></div>
    ${analyticsScope !== "own" ? `<div class="kpi accent-cons"><div class="label">Поставщикам</div><div class="value">${fmt(summary.supplier_due)}</div></div>` : ""}
    ${analyticsScope !== "consignment" ? `<div class="kpi"><div class="label">Себестоимость</div><div class="value">${fmt(summary.own_cogs)}</div></div>` : ""}
    <div class="kpi"><div class="label">На складе</div><div class="value">${summary.products_count}</div><div class="sub">${fmt(summary.stock_value)} закупка</div></div>
    <div class="kpi accent-warn"><div class="label">Мало остатков</div><div class="value">${summary.low_stock_count}</div></div>
  `;

  const maxR = Math.max(...daily.map((d) => d.revenue), 1);
  document.getElementById("daily-chart").innerHTML = daily.map((d) => {
    const h = Math.round((d.revenue / maxR) * 150);
    return `<div class="bar-col" title="${d.day}: ${fmt(d.revenue)}"><div class="bar" style="height:${h}px"></div><span class="bl">${d.day.slice(5)}</span></div>`;
  }).join("") || '<p style="color:var(--muted)">Нет данных</p>';

  document.getElementById("top-products").innerHTML = top.length
    ? top.map((t) => `<div class="top-item"><span>${esc(t.name)} <span class="tag tag-${t.ownership_type === "consignment" ? "cons" : "own"}" style="font-size:.6rem">${t.qty} шт</span></span><span class="rev">${fmt(t.revenue)}</span></div>`).join("")
    : '<p style="color:var(--muted)">Нет данных</p>';

  if (analyticsScope === "all") {
    const [ownS, consS] = await Promise.all([
      api(`/api/analytics/summary?period=${period}&scope=own`),
      api(`/api/analytics/summary?period=${period}&scope=consignment`),
    ]);
    const total = ownS.revenue + consS.revenue || 1;
    document.getElementById("scope-split").innerHTML = `
      <div class="split-row"><span class="tag tag-own">Свои</span> ${fmt(ownS.revenue)} (${pct(ownS.revenue, total)}%)</div>
      <div class="split-bar"><div class="split-bar-fill"><div style="width:${pct(ownS.revenue, total)}%;background:var(--own)"></div></div></div>
      <div class="split-row"><span class="tag tag-cons">Реализация</span> ${fmt(consS.revenue)} (${pct(consS.revenue, total)}%)</div>
      <div class="split-bar"><div class="split-bar-fill"><div style="width:${pct(consS.revenue, total)}%;background:var(--consignment)"></div></div></div>
      <div style="margin-top:.75rem;font-size:.85rem">
        <div class="metric-row"><span>Прибыль (свои)</span><strong>${fmt(ownS.profit)}</strong></div>
        <div class="metric-row"><span>Комиссия (реализация)</span><strong>${fmt(consS.profit)}</strong></div>
      </div>`;
  } else {
    document.getElementById("scope-split").innerHTML = `<p style="color:var(--muted);font-size:.85rem">Фильтр: ${scopeLabel(analyticsScope)}</p>
      <div class="metric-row" style="margin-top:.5rem"><span>Прибыль</span><strong>${fmt(summary.profit)}</strong></div>`;
  }
}

init();
