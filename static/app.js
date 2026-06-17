const PIN_KEY = "telephons_pin";
let pin = localStorage.getItem(PIN_KEY) || "";
let products = [];
let cart = [];
let paymentMethod = "cash";
let authRequired = false;

const fmt = (n) => new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB", maximumFractionDigits: 0 }).format(n);
const catLabel = (c) => ({ phone: "Телефон", accessory: "Аксессуар" }[c] || c);
const payLabel = (p) => ({ cash: "Наличные", card: "Карта", transfer: "Перевод" }[p] || p);

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
    throw new Error(err.detail || `Ошибка ${res.status}`);
  }
  return res.json();
}

function toast(msg, type = "success") {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.className = `toast ${type}`;
  setTimeout(() => el.classList.add("hidden"), 3000);
}

function showLogin() {
  document.getElementById("login-screen").classList.remove("hidden");
  document.getElementById("app").classList.add("hidden");
}

function showApp() {
  document.getElementById("login-screen").classList.add("hidden");
  document.getElementById("app").classList.remove("hidden");
}

async function init() {
  const cfg = await fetch("/api/config").then((r) => r.json());
  authRequired = cfg.auth_required;
  if (authRequired && !pin) {
    showLogin();
    return;
  }
  if (authRequired && pin) {
    try {
      await api("/api/auth/check", { method: "POST", body: JSON.stringify({ pin }) });
    } catch {
      return;
    }
  }
  showApp();
  startClock();
  bindTabs();
  bindPos();
  bindProducts();
  bindSales();
  bindAnalytics();
  await loadProducts();
}

document.getElementById("pin-submit").addEventListener("click", async () => {
  const input = document.getElementById("pin-input");
  pin = input.value.trim();
  try {
    await api("/api/auth/check", { method: "POST", body: JSON.stringify({ pin }) });
    localStorage.setItem(PIN_KEY, pin);
    document.getElementById("pin-error").classList.add("hidden");
    showApp();
    await loadProducts();
    startClock();
    bindTabs();
    bindPos();
    bindProducts();
    bindSales();
    bindAnalytics();
  } catch {
    document.getElementById("pin-error").textContent = "Неверный PIN";
    document.getElementById("pin-error").classList.remove("hidden");
  }
});

document.getElementById("pin-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("pin-submit").click();
});

function startClock() {
  const tick = () => {
    document.getElementById("clock").textContent = new Date().toLocaleString("ru-RU", {
      weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
    });
  };
  tick();
  setInterval(tick, 30000);
}

function bindTabs() {
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById(`tab-${btn.dataset.tab}`).classList.add("active");
      if (btn.dataset.tab === "sales") loadSales();
      if (btn.dataset.tab === "products") loadProductsTable();
      if (btn.dataset.tab === "analytics") loadAnalytics();
    });
  });
}

/* ── Products ── */
async function loadProducts() {
  const q = document.getElementById("pos-search")?.value || "";
  const cat = document.getElementById("pos-category")?.value || "";
  let url = `/api/products?q=${encodeURIComponent(q)}`;
  if (cat) url += `&category=${cat}`;
  products = await api(url);
  renderPosProducts();
}

function renderPosProducts() {
  const grid = document.getElementById("pos-products");
  if (!products.length) {
    grid.innerHTML = '<p style="color:var(--muted);padding:1rem">Товары не найдены</p>';
    return;
  }
  grid.innerHTML = products.map((p) => {
    const out = p.stock <= 0;
    const low = p.stock > 0 && p.stock <= p.min_stock;
    return `<div class="product-card ${out ? "out-of-stock" : ""}" data-id="${p.id}" ${out ? "" : 'tabindex="0"'}>
      <span class="cat-badge cat-${p.category}">${catLabel(p.category)}</span>
      <div class="name">${esc(p.name)}</div>
      <div class="brand">${esc(p.brand)}</div>
      <div class="price">${fmt(p.sale_price)}</div>
      <div class="stock ${low ? "low" : ""}">${out ? "Нет в наличии" : `Остаток: ${p.stock}`}</div>
    </div>`;
  }).join("");

  grid.querySelectorAll(".product-card:not(.out-of-stock)").forEach((card) => {
    card.addEventListener("click", () => addToCart(+card.dataset.id));
  });
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/* ── Cart / POS ── */
function bindPos() {
  document.getElementById("pos-search").addEventListener("input", debounce(loadProducts, 300));
  document.getElementById("pos-category").addEventListener("change", loadProducts);

  document.getElementById("pos-search").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const q = e.target.value.trim();
      const byBarcode = products.find((p) => p.barcode === q);
      if (byBarcode && byBarcode.stock > 0) {
        addToCart(byBarcode.id);
        e.target.value = "";
        loadProducts();
      }
    }
  });

  document.querySelectorAll(".pay-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".pay-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      paymentMethod = btn.dataset.pay;
    });
  });

  document.getElementById("cart-discount").addEventListener("input", renderCart);
  document.getElementById("checkout-btn").addEventListener("click", checkout);
  document.getElementById("clear-cart-btn").addEventListener("click", () => { cart = []; renderCart(); });
}

function addToCart(productId) {
  const p = products.find((x) => x.id === productId);
  if (!p || p.stock <= 0) return;
  const existing = cart.find((c) => c.product_id === productId);
  const inCart = existing ? existing.quantity : 0;
  if (inCart >= p.stock) {
    toast(`Максимум ${p.stock} шт.`, "error");
    return;
  }
  if (existing) existing.quantity++;
  else cart.push({ product_id: productId, quantity: 1, product: p });
  renderCart();
}

function renderCart() {
  const container = document.getElementById("cart-items");
  const empty = document.getElementById("cart-empty");
  if (!cart.length) {
    container.innerHTML = "";
    empty.classList.remove("hidden");
    document.getElementById("checkout-btn").disabled = true;
    document.getElementById("cart-subtotal").textContent = "0 ₽";
    document.getElementById("cart-total").textContent = "0 ₽";
    return;
  }
  empty.classList.add("hidden");
  let subtotal = 0;
  container.innerHTML = cart.map((c) => {
    const line = c.product.sale_price * c.quantity;
    subtotal += line;
    return `<div class="cart-item">
      <span class="ci-name">${esc(c.product.name)}</span>
      <span class="ci-qty">
        <button onclick="changeQty(${c.product_id},-1)">−</button>
        ${c.quantity}
        <button onclick="changeQty(${c.product_id},1)">+</button>
      </span>
      <span class="ci-subtotal">${fmt(line)}</span>
      <button class="ci-remove" onclick="removeFromCart(${c.product_id})">×</button>
    </div>`;
  }).join("");

  const discount = +document.getElementById("cart-discount").value || 0;
  const total = Math.max(0, subtotal - discount);
  document.getElementById("cart-subtotal").textContent = fmt(subtotal);
  document.getElementById("cart-total").textContent = fmt(total);
  document.getElementById("checkout-btn").disabled = false;
}

window.changeQty = (id, delta) => {
  const item = cart.find((c) => c.product_id === id);
  if (!item) return;
  const p = products.find((x) => x.id === id);
  item.quantity += delta;
  if (item.quantity <= 0) cart = cart.filter((c) => c.product_id !== id);
  else if (p && item.quantity > p.stock) { item.quantity = p.stock; toast(`Максимум ${p.stock} шт.`, "error"); }
  renderCart();
};

window.removeFromCart = (id) => {
  cart = cart.filter((c) => c.product_id !== id);
  renderCart();
};

async function checkout() {
  const discount = +document.getElementById("cart-discount").value || 0;
  try {
    const sale = await api("/api/sales", {
      method: "POST",
      body: JSON.stringify({
        items: cart.map((c) => ({ product_id: c.product_id, quantity: c.quantity })),
        discount,
        payment_method: paymentMethod,
      }),
    });
    cart = [];
    document.getElementById("cart-discount").value = "0";
    renderCart();
    await loadProducts();
    showReceipt(sale);
    toast("Продажа оформлена!");
  } catch (e) {
    toast(e.message, "error");
  }
}

function showReceipt(sale) {
  const items = sale.items.map((i) =>
    `<div>${esc(i.product_name)} × ${i.quantity} — ${fmt(i.subtotal)}</div>`
  ).join("");
  document.getElementById("receipt-content").innerHTML = `
    <div class="rc-title">Магазин телефонов</div>
    <div>Чек №${sale.id}</div>
    <div>${sale.created_at}</div>
    <div class="rc-line"></div>
    ${items}
    <div class="rc-line"></div>
    ${sale.discount > 0 ? `<div>Скидка: −${fmt(sale.discount)}</div>` : ""}
    <div class="rc-total">ИТОГО: ${fmt(sale.total)}</div>
    <div style="text-align:center;margin-top:.5rem;color:var(--muted)">${payLabel(sale.payment_method)}</div>
  `;
  document.getElementById("receipt-modal").showModal();
}

document.getElementById("receipt-close").addEventListener("click", () => {
  document.getElementById("receipt-modal").close();
});
document.getElementById("receipt-print").addEventListener("click", () => {
  const content = document.getElementById("receipt-content").innerHTML;
  const w = window.open("", "_blank");
  w.document.write(`<html><body style="font-family:monospace;padding:20px">${content}</body></html>`);
  w.print();
});

/* ── Sales ── */
function bindSales() {
  document.getElementById("refresh-sales").addEventListener("click", loadSales);
}

async function loadSales() {
  const data = await api("/api/sales?limit=100");
  const list = document.getElementById("sales-list");
  if (!data.items.length) {
    list.innerHTML = '<p style="color:var(--muted)">Продаж пока нет</p>';
    return;
  }
  list.innerHTML = data.items.map((s) => `
    <div class="sale-card" data-id="${s.id}">
      <span class="sale-id">#${s.id}</span>
      <span class="sale-date">${s.created_at}</span>
      <span class="sale-total">${fmt(s.total)}</span>
      <span class="sale-pay">${payLabel(s.payment_method)}</span>
    </div>
    <div class="sale-detail hidden" id="sale-detail-${s.id}"></div>
  `).join("");

  list.querySelectorAll(".sale-card").forEach((card) => {
    card.addEventListener("click", async () => {
      const id = card.dataset.id;
      const detail = document.getElementById(`sale-detail-${id}`);
      if (!detail.classList.contains("hidden")) { detail.classList.add("hidden"); return; }
      const sale = await api(`/api/sales/${id}`);
      detail.innerHTML = sale.items.map((i) =>
        `<div class="sd-item"><span>${esc(i.product_name)} × ${i.quantity}</span><span>${fmt(i.subtotal)}</span></div>`
      ).join("") + `<button class="btn btn-danger btn-sm void-btn" onclick="voidSale(${id})">Отменить продажу</button>`;
      detail.classList.remove("hidden");
    });
  });
}

window.voidSale = async (id) => {
  if (!confirm("Отменить продажу? Товары вернутся на склад.")) return;
  try {
    await api(`/api/sales/${id}/void`, { method: "POST" });
    toast("Продажа отменена");
    loadSales();
    loadProducts();
  } catch (e) {
    toast(e.message, "error");
  }
};

/* ── Products table ── */
function bindProducts() {
  document.getElementById("products-search").addEventListener("input", debounce(loadProductsTable, 300));
  document.getElementById("low-stock-filter").addEventListener("change", loadProductsTable);
  document.getElementById("add-product-btn").addEventListener("click", () => openProductModal());
  document.getElementById("product-cancel").addEventListener("click", () => document.getElementById("product-modal").close());
  document.getElementById("product-form").addEventListener("submit", saveProduct);
}

async function loadProductsTable() {
  const q = document.getElementById("products-search").value;
  const low = document.getElementById("low-stock-filter").checked;
  let url = `/api/products?q=${encodeURIComponent(q)}`;
  if (low) url += "&low_stock=true";
  const items = await api(url);
  const tbody = document.getElementById("products-tbody");
  tbody.innerHTML = items.map((p) => `
    <tr>
      <td>${esc(p.name)}</td>
      <td>${catLabel(p.category)}</td>
      <td>${esc(p.brand)}</td>
      <td>${fmt(p.purchase_price)}</td>
      <td>${fmt(p.sale_price)}</td>
      <td class="${p.stock <= p.min_stock ? "stock-low" : ""}">${p.stock}</td>
      <td>
        <button class="btn btn-ghost btn-sm" onclick="editProduct(${p.id})">✎</button>
        <button class="btn btn-danger btn-sm" onclick="deleteProduct(${p.id})">✕</button>
      </td>
    </tr>
  `).join("");
}

function openProductModal(data = null) {
  document.getElementById("product-modal-title").textContent = data ? "Редактировать товар" : "Новый товар";
  document.getElementById("pf-id").value = data?.id || "";
  document.getElementById("pf-name").value = data?.name || "";
  document.getElementById("pf-category").value = data?.category || "accessory";
  document.getElementById("pf-brand").value = data?.brand || "";
  document.getElementById("pf-sku").value = data?.sku || "";
  document.getElementById("pf-barcode").value = data?.barcode || "";
  document.getElementById("pf-purchase").value = data?.purchase_price ?? "";
  document.getElementById("pf-sale").value = data?.sale_price ?? "";
  document.getElementById("pf-stock").value = data?.stock ?? "";
  document.getElementById("pf-min-stock").value = data?.min_stock ?? 2;
  document.getElementById("product-modal").showModal();
}

window.editProduct = async (id) => {
  const items = await api("/api/products");
  const p = items.find((x) => x.id === id);
  if (p) openProductModal(p);
};

window.deleteProduct = async (id) => {
  if (!confirm("Удалить товар?")) return;
  try {
    await api(`/api/products/${id}`, { method: "DELETE" });
    toast("Товар удалён");
    loadProductsTable();
    loadProducts();
  } catch (e) {
    toast(e.message, "error");
  }
};

async function saveProduct(e) {
  e.preventDefault();
  const id = document.getElementById("pf-id").value;
  const body = {
    name: document.getElementById("pf-name").value,
    category: document.getElementById("pf-category").value,
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
    loadProductsTable();
    loadProducts();
  } catch (err) {
    toast(err.message, "error");
  }
}

/* ── Analytics ── */
function bindAnalytics() {
  document.getElementById("analytics-period").addEventListener("change", loadAnalytics);
}

async function loadAnalytics() {
  const period = document.getElementById("analytics-period").value;
  const [summary, top, cats, daily] = await Promise.all([
    api(`/api/analytics/summary?period=${period}`),
    api(`/api/analytics/top-products?period=${period}`),
    api(`/api/analytics/by-category?period=${period}`),
    api("/api/analytics/daily?days=14"),
  ]);

  document.getElementById("stats-grid").innerHTML = `
    <div class="stat-card"><div class="label">Продаж</div><div class="value blue">${summary.sales_count}</div></div>
    <div class="stat-card"><div class="label">Выручка</div><div class="value green">${fmt(summary.revenue)}</div></div>
    <div class="stat-card"><div class="label">Прибыль</div><div class="value green">${fmt(summary.profit)}</div></div>
    <div class="stat-card"><div class="label">Маржа</div><div class="value">${summary.margin_pct}%</div></div>
    <div class="stat-card"><div class="label">Мало на складе</div><div class="value orange">${summary.low_stock_count}</div></div>
    <div class="stat-card"><div class="label">Склад (закупка)</div><div class="value">${fmt(summary.stock_value)}</div></div>
  `;

  const maxRev = Math.max(...daily.map((d) => d.revenue), 1);
  document.getElementById("daily-chart").innerHTML = daily.map((d) => {
    const h = Math.round((d.revenue / maxRev) * 140);
    const label = d.day.slice(5);
    return `<div class="bar-col" title="${d.day}: ${fmt(d.revenue)}">
      <div class="bar" style="height:${h}px"></div>
      <span class="bar-label">${label}</span>
    </div>`;
  }).join("");

  document.getElementById("top-products").innerHTML = top.length
    ? top.map((t) => `<div class="top-item"><span class="ti-name">${esc(t.name)} (${t.qty} шт.)</span><span class="ti-rev">${fmt(t.revenue)}</span></div>`).join("")
    : '<p style="color:var(--muted);font-size:.85rem">Нет данных</p>';

  const maxCat = Math.max(...cats.map((c) => c.revenue), 1);
  const colors = { phone: "var(--phone)", accessory: "var(--accessory)" };
  document.getElementById("category-stats").innerHTML = cats.length
    ? cats.map((c) => `
      <div class="cat-stat">
        <div class="cs-label">${esc(c.label)}</div>
        <div class="cs-bar"><div class="cs-fill" style="width:${(c.revenue/maxCat*100).toFixed(0)}%;background:${colors[c.category]||'var(--accent)'}"></div></div>
        <div class="cs-val">${fmt(c.revenue)} · ${c.sales} продаж</div>
      </div>`).join("")
    : '<p style="color:var(--muted);font-size:.85rem">Нет данных</p>';
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

init();
