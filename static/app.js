const PIN_KEY = "telephons_pin";
let pin = localStorage.getItem(PIN_KEY) || "";
let products = [];
let cart = [];
let paymentMethod = "cash";
let authRequired = false;
let currentPage = "dashboard";
let reportScope = "all";
let analyticsScope = "all";

const fmt = (n) => new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB", maximumFractionDigits: 0 }).format(n);
const pct = (a, b) => b ? Math.round((a / b) * 100) : 0;
const catLabel = (c) => ({ phone: "Телефон", accessory: "Аксессуар" }[c] || c);
const ownLabel = (o) => ({ own: "Собственный", consignment: "Реализация" }[o] || o);
const payLabel = (p) => ({ cash: "Наличные", card: "Карта", transfer: "Перевод" }[p] || p);
const scopeLabel = (s) => ({ all: "Общий", own: "Собственные", consignment: "Реализация" }[s] || s);
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const PAGE_TITLES = {
  dashboard: "Обзор",
  pos: "Касса",
  sales: "Продажи",
  "products-own": "Собственные товары",
  "products-consignment": "Товары под реализацию",
  suppliers: "Поставщики",
  reports: "Финансовые отчёты",
  analytics: "Аналитика",
};

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
  el.className = `toast${type === "error" ? " error" : ""}`;
  el.classList.remove("hidden");
  setTimeout(() => el.classList.add("hidden"), 3200);
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
  currentPage = page;
  document.querySelectorAll(".nav-item").forEach((n) => n.classList.toggle("active", n.dataset.page === page));
  document.querySelectorAll(".page").forEach((p) => p.classList.remove("active"));
  document.getElementById(`page-${page}`)?.classList.add("active");
  document.getElementById("page-title").textContent = PAGE_TITLES[page] || page;
  const loaders = {
    dashboard: loadDashboard,
    pos: loadProducts,
    sales: loadSales,
    "products-own": loadOwnProducts,
    "products-consignment": loadConsProducts,
    suppliers: loadSuppliers,
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

async function init() {
  const cfg = await fetch("/api/config").then((r) => r.json());
  authRequired = cfg.auth_required;
  document.getElementById("store-name").textContent = cfg.store_name || "TeleStore";
  if (authRequired && !pin) { showLogin(); return; }
  if (authRequired && pin) {
    try { await api("/api/auth/check", { method: "POST", body: JSON.stringify({ pin }) }); }
    catch { return; }
  }
  showApp();
  startClock();
  bindNav();
  bindPos();
  bindSales();
  bindProducts();
  bindSuppliers();
  bindReports();
  bindAnalytics();
  navigate("dashboard");
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
  ["pos-search", "pos-category", "pos-ownership"].forEach((id) => {
    document.getElementById(id).addEventListener(id === "pos-search" ? "input" : "change", debounce(loadProducts, 250));
  });
  document.getElementById("pos-search").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const q = e.target.value.trim();
      const p = products.find((x) => x.barcode === q && x.stock > 0);
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

async function loadProducts() {
  const q = document.getElementById("pos-search")?.value || "";
  const cat = document.getElementById("pos-category")?.value || "";
  const own = document.getElementById("pos-ownership")?.value || "";
  let url = `/api/products?q=${encodeURIComponent(q)}`;
  if (cat) url += `&category=${cat}`;
  if (own) url += `&ownership_type=${own}`;
  products = await api(url);
  renderPosProducts();
}

function renderPosProducts() {
  const grid = document.getElementById("pos-products");
  if (!products.length) { grid.innerHTML = '<p style="padding:1rem;color:var(--muted)">Товары не найдены</p>'; return; }
  grid.innerHTML = products.map((p) => {
    const out = p.stock <= 0;
    const margin = p.sale_price - p.purchase_price;
    return `<div class="product-card ${out ? "out" : ""}" data-id="${p.id}">
      <span class="tag tag-${p.ownership_type === "consignment" ? "cons" : "own"}">${ownLabel(p.ownership_type)}</span>
      <div class="name">${esc(p.name)}</div>
      <div class="meta">${esc(p.brand)} · ${catLabel(p.category)}</div>
      <div class="price">${fmt(p.sale_price)}</div>
      <div class="meta">${out ? "Нет в наличии" : `Ост: ${p.stock} · +${fmt(margin)}`}</div>
    </div>`;
  }).join("");
  grid.querySelectorAll(".product-card:not(.out)").forEach((c) => {
    c.addEventListener("click", () => addToCart(+c.dataset.id));
  });
}

function addToCart(id) {
  const p = products.find((x) => x.id === id);
  if (!p || p.stock <= 0) return;
  const ex = cart.find((c) => c.product_id === id);
  const qty = ex ? ex.quantity : 0;
  if (qty >= p.stock) { toast(`Макс. ${p.stock} шт.`, "error"); return; }
  if (ex) ex.quantity++; else cart.push({ product_id: id, quantity: 1, product: p });
  renderCart();
}

function renderCart() {
  const box = document.getElementById("cart-items");
  const empty = document.getElementById("cart-empty");
  const count = cart.reduce((s, c) => s + c.quantity, 0);
  document.getElementById("cart-count").textContent = count;
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
  box.innerHTML = cart.map((c) => {
    const line = c.product.sale_price * c.quantity;
    sub += line;
    return `<div class="cart-item">
      <div><div class="ci-name">${esc(c.product.name)}</div>
      <span class="tag tag-${c.product.ownership_type === "consignment" ? "cons" : "own"}" style="font-size:.6rem">${ownLabel(c.product.ownership_type)}</span></div>
      <div class="ci-qty"><button onclick="changeQty(${c.product_id},-1)">−</button>${c.quantity}<button onclick="changeQty(${c.product_id},1)">+</button></div>
      <strong>${fmt(line)}</strong>
    </div>`;
  }).join("");
  const disc = +document.getElementById("cart-discount").value || 0;
  document.getElementById("cart-subtotal").textContent = fmt(sub);
  document.getElementById("cart-total").textContent = fmt(Math.max(0, sub - disc));
  document.getElementById("checkout-btn").disabled = false;
}

window.changeQty = (id, d) => {
  const item = cart.find((c) => c.product_id === id);
  if (!item) return;
  item.quantity += d;
  const p = products.find((x) => x.id === id);
  if (item.quantity <= 0) cart = cart.filter((c) => c.product_id !== id);
  else if (p && item.quantity > p.stock) { item.quantity = p.stock; toast(`Макс. ${p.stock}`, "error"); }
  renderCart();
};

async function checkout() {
  const discount = +document.getElementById("cart-discount").value || 0;
  try {
    const sale = await api("/api/sales", {
      method: "POST",
      body: JSON.stringify({
        items: cart.map((c) => ({ product_id: c.product_id, quantity: c.quantity })),
        discount, payment_method: paymentMethod,
      }),
    });
    cart = [];
    document.getElementById("cart-discount").value = "0";
    renderCart();
    await loadProducts();
    showReceipt(sale);
    toast("Продажа проведена");
  } catch (e) { toast(e.message, "error"); }
}

function showReceipt(sale) {
  document.getElementById("receipt-content").innerHTML = `
    <div class="rt">TeleStore ERP</div>
    <div style="text-align:center">Чек №${sale.id} · ${sale.created_at}</div>
    <hr>
    ${sale.items.map((i) => `<div>${esc(i.product_name)} ×${i.quantity} — ${fmt(i.subtotal)}</div>`).join("")}
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
  const types = [...new Set(sale.items.map((i) => i.ownership_type))];
  document.getElementById("sale-detail-content").innerHTML = `
    <h3>Продажа #${sale.id}</h3>
    <p style="color:var(--muted);margin:.5rem 0 1rem">${sale.created_at} · ${payLabel(sale.payment_method)}</p>
    <table class="data-table"><thead><tr><th>Товар</th><th>Тип</th><th>Кол-во</th><th>Сумма</th><th>Прибыль</th></tr></thead>
    <tbody>${sale.items.map((i) => `<tr>
      <td>${esc(i.product_name)}</td>
      <td><span class="tag tag-${i.ownership_type === "consignment" ? "cons" : "own"}">${ownLabel(i.ownership_type)}</span></td>
      <td>${i.quantity}</td><td>${fmt(i.subtotal)}</td><td>${fmt(i.shop_profit)}</td>
    </tr>`).join("")}</tbody></table>
    <div style="margin-top:1rem;text-align:right;font-size:1.1rem;font-weight:700">Итого: ${fmt(sale.total)}</div>
    <button class="btn btn-danger" style="margin-top:1rem" onclick="voidSale(${id})">Отменить продажу</button>`;
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

/* ── Products ── */
function bindProducts() {
  document.getElementById("own-search").addEventListener("input", debounce(loadOwnProducts, 300));
  document.getElementById("own-low-stock").addEventListener("change", loadOwnProducts);
  document.getElementById("cons-search").addEventListener("input", debounce(loadConsProducts, 300));
  document.getElementById("cons-supplier-filter").addEventListener("change", loadConsProducts);
  document.getElementById("product-cancel").onclick = () => document.getElementById("product-modal").close();
  document.getElementById("product-form").onsubmit = saveProduct;
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
  }).join("") || '<tr><td colspan="8" style="text-align:center;color:var(--muted)">Нет товаров</td></tr>';
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
  }).join("") || '<tr><td colspan="8" style="text-align:center;color:var(--muted)">Нет товаров</td></tr>';
}

window.openProductModal = (ownership) => {
  document.getElementById("product-modal-title").textContent = ownership === "consignment" ? "Товар под реализацию" : "Собственный товар";
  document.getElementById("pf-id").value = "";
  document.getElementById("pf-ownership").value = ownership;
  document.getElementById("pf-supplier-row").classList.toggle("hidden", ownership !== "consignment");
  ["pf-name","pf-brand","pf-sku","pf-barcode","pf-purchase","pf-sale","pf-stock","pf-supplier"].forEach((id) => {
    document.getElementById(id).value = id === "pf-stock" ? "0" : "";
  });
  document.getElementById("pf-min-stock").value = "2";
  document.getElementById("pf-category").value = "accessory";
  updateMarginHint();
  document.getElementById("product-modal").showModal();
};

window.editProduct = async (id) => {
  const all = await api("/api/products");
  const p = all.find((x) => x.id === id);
  if (!p) return;
  document.getElementById("product-modal-title").textContent = "Редактирование";
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
  document.getElementById("pf-stock").value = p.stock;
  document.getElementById("pf-min-stock").value = p.min_stock;
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
    stock: +document.getElementById("pf-stock").value,
    min_stock: +document.getElementById("pf-min-stock").value,
  };
  try {
    if (id) await api(`/api/products/${id}`, { method: "PUT", body: JSON.stringify(body) });
    else await api("/api/products", { method: "POST", body: JSON.stringify(body) });
    document.getElementById("product-modal").close();
    toast("Сохранено");
    loadOwnProducts();
    loadConsProducts();
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
  let url = `/api/reports/finance?scope=${reportScope}&period=${period}`;
  if (from) url += `&date_from=${from}`;
  if (to) url += `&date_to=${to}`;

  const combinedEl = document.getElementById("report-combined");
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
