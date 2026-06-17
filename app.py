"""Магазин телефонов — касса, склад, реализация, финансовые отчёты."""

from __future__ import annotations

import logging
import os
import sqlite3
from contextlib import asynccontextmanager, contextmanager
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Literal

from fastapi import FastAPI, Header, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings, SettingsConfigDict

logger = logging.getLogger("telephons")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

STATIC_DIR = Path(__file__).resolve().parent / "static"
DATA_DIR = Path("/data") if Path("/data").exists() else Path(__file__).resolve().parent / "data"
DB_PATH = DATA_DIR / "store.db"

OwnershipType = Literal["own", "consignment"]
ReportScope = Literal["all", "own", "consignment"]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    store_pin: str = ""
    store_name: str = "Магазин телефонов"
    port: int = 80


settings = Settings()
settings.port = int(os.environ.get("PORT", settings.port))


def utc_now() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def row_to_dict(row: sqlite3.Row | None) -> dict[str, Any] | None:
    if row is None:
        return None
    return dict(row)


@contextmanager
def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def _add_column(conn: sqlite3.Connection, table: str, column: str, definition: str) -> None:
    cols = {r[1] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()}
    if column not in cols:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")


def migrate_db(conn: sqlite3.Connection) -> None:
    _add_column(conn, "products", "ownership_type", "TEXT NOT NULL DEFAULT 'own'")
    _add_column(conn, "products", "supplier_name", "TEXT DEFAULT ''")
    _add_column(conn, "sale_items", "ownership_type", "TEXT NOT NULL DEFAULT 'own'")
    _add_column(conn, "sale_items", "supplier_name", "TEXT DEFAULT ''")
    _add_column(conn, "sale_items", "supplier_due", "REAL NOT NULL DEFAULT 0")
    _add_column(conn, "sale_items", "shop_profit", "REAL NOT NULL DEFAULT 0")
    conn.execute(
        """
        UPDATE sale_items
        SET shop_profit = subtotal - purchase_price * quantity
        WHERE shop_profit = 0 AND subtotal != 0
        """
    )


def init_db() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with db() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS products (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                category TEXT NOT NULL DEFAULT 'accessory',
                brand TEXT DEFAULT '',
                sku TEXT DEFAULT '',
                barcode TEXT DEFAULT '',
                purchase_price REAL NOT NULL DEFAULT 0,
                sale_price REAL NOT NULL DEFAULT 0,
                stock INTEGER NOT NULL DEFAULT 0,
                min_stock INTEGER NOT NULL DEFAULT 2,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS sales (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                total REAL NOT NULL,
                discount REAL NOT NULL DEFAULT 0,
                payment_method TEXT NOT NULL DEFAULT 'cash',
                status TEXT NOT NULL DEFAULT 'completed',
                notes TEXT DEFAULT '',
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS sale_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                sale_id INTEGER NOT NULL,
                product_id INTEGER,
                product_name TEXT NOT NULL,
                quantity INTEGER NOT NULL,
                unit_price REAL NOT NULL,
                purchase_price REAL NOT NULL DEFAULT 0,
                subtotal REAL NOT NULL,
                FOREIGN KEY (sale_id) REFERENCES sales(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS supplier_payments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                supplier_name TEXT NOT NULL,
                amount REAL NOT NULL,
                notes TEXT DEFAULT '',
                created_at TEXT NOT NULL
            );
            """
        )
        migrate_db(conn)
        conn.executescript(
            """
            CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);
            CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode);
            CREATE INDEX IF NOT EXISTS idx_products_ownership ON products(ownership_type);
            CREATE INDEX IF NOT EXISTS idx_sales_created ON sales(created_at);
            """
        )

        count = conn.execute("SELECT COUNT(*) FROM products").fetchone()[0]
        if count == 0:
            now = utc_now()
            samples = [
                ("iPhone 15 128GB", "phone", "own", "", "Apple", "IP15-128", "4601234567890", 62000, 74990, 5, 2),
                ("Samsung Galaxy A55", "phone", "own", "", "Samsung", "A55-128", "4601234567891", 22000, 27990, 8, 2),
                ("Xiaomi Redmi Note 13", "phone", "consignment", "ООО ТехноСнаб", "Xiaomi", "RN13-256", "4601234567892", 14000, 18990, 10, 3),
                ("iPhone 14 Pro (комиссия)", "phone", "consignment", "ИП Петров", "Apple", "IP14P-256", "4601234567893", 55000, 69990, 3, 1),
                ("Чехол силиконовый", "accessory", "own", "", "Generic", "CASE-SIL", "4601234567894", 150, 590, 50, 10),
                ("Защитное стекло", "accessory", "own", "", "Generic", "GLASS-67", "4601234567895", 80, 390, 80, 15),
                ("Наушники JBL (реализация)", "accessory", "consignment", "ООО ТехноСнаб", "JBL", "JBL-TUNE", "4601234567896", 1800, 3490, 12, 3),
                ("Powerbank 10000 mAh", "accessory", "own", "", "Xiaomi", "PB-10K", "4601234567897", 900, 1990, 15, 5),
            ]
            conn.executemany(
                """
                INSERT INTO products
                (name, category, ownership_type, supplier_name, brand, sku, barcode,
                 purchase_price, sale_price, stock, min_stock, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                [(*row, now) for row in samples],
            )


def check_pin(pin: str | None) -> None:
    if settings.store_pin and pin != settings.store_pin:
        raise HTTPException(status_code=401, detail="Неверный PIN")


def period_start(period: str) -> str:
    now = datetime.now()
    if period == "week":
        start = now - timedelta(days=now.weekday())
    elif period == "month":
        start = now.replace(day=1)
    elif period == "quarter":
        q_month = ((now.month - 1) // 3) * 3 + 1
        start = now.replace(month=q_month, day=1)
    elif period == "year":
        start = now.replace(month=1, day=1)
    else:
        start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    return start.strftime("%Y-%m-%d %H:%M:%S")


def date_filter_sql(date_from: str, date_to: str, column: str = "s.created_at") -> tuple[str, list[Any]]:
    clause = ""
    params: list[Any] = []
    if date_from:
        clause += f" AND {column} >= ?"
        params.append(date_from)
    if date_to:
        clause += f" AND {column} <= ?"
        params.append(date_to + " 23:59:59")
    return clause, params


def ownership_filter_sql(scope: str, column: str = "si.ownership_type") -> tuple[str, list[Any]]:
    if scope == "own":
        return f" AND {column} = 'own'", []
    if scope == "consignment":
        return f" AND {column} = 'consignment'", []
    return "", []


def calc_line(product: sqlite3.Row, qty: int, unit_price: float | None = None) -> dict[str, float | str]:
    price = unit_price if unit_price is not None else float(product["sale_price"])
    subtotal = price * qty
    ownership = product["ownership_type"] or "own"
    cost = float(product["purchase_price"])
    if ownership == "consignment":
        supplier_due = cost * qty
        shop_profit = subtotal - supplier_due
    else:
        supplier_due = 0.0
        shop_profit = subtotal - cost * qty
    return {
        "ownership_type": ownership,
        "supplier_name": product["supplier_name"] or "",
        "unit_price": price,
        "purchase_price": cost,
        "subtotal": subtotal,
        "supplier_due": supplier_due,
        "shop_profit": shop_profit,
    }


class ProductIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    category: str = "accessory"
    ownership_type: OwnershipType = "own"
    supplier_name: str = ""
    brand: str = ""
    sku: str = ""
    barcode: str = ""
    purchase_price: float = Field(ge=0)
    sale_price: float = Field(ge=0)
    stock: int = Field(ge=0)
    min_stock: int = Field(ge=0, default=2)


class ProductUpdate(BaseModel):
    name: str | None = None
    category: str | None = None
    ownership_type: OwnershipType | None = None
    supplier_name: str | None = None
    brand: str | None = None
    sku: str | None = None
    barcode: str | None = None
    purchase_price: float | None = Field(default=None, ge=0)
    sale_price: float | None = Field(default=None, ge=0)
    stock: int | None = Field(default=None, ge=0)
    min_stock: int | None = Field(default=None, ge=0)


class CartItem(BaseModel):
    product_id: int
    quantity: int = Field(ge=1)


class SaleIn(BaseModel):
    items: list[CartItem]
    discount: float = Field(ge=0, default=0)
    payment_method: str = "cash"
    notes: str = ""


class SupplierPaymentIn(BaseModel):
    supplier_name: str = Field(min_length=1)
    amount: float = Field(gt=0)
    notes: str = ""


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_db()
    logger.info("DB: %s", DB_PATH)
    yield


app = FastAPI(title=settings.store_name, lifespan=lifespan)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
async def index():
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/health")
async def health():
    return {"status": "ok", "db": str(DB_PATH), "db_exists": DB_PATH.exists()}


@app.get("/api/config")
async def config():
    return {"auth_required": bool(settings.store_pin), "store_name": settings.store_name}


@app.post("/api/auth/check")
async def auth_check(body: dict):
    pin = body.get("pin", "")
    if settings.store_pin and pin != settings.store_pin:
        raise HTTPException(status_code=401, detail="Неверный PIN")
    return {"ok": True}


@app.get("/api/products")
async def list_products(
    q: str = "",
    category: str = "",
    ownership_type: str = "",
    supplier: str = "",
    low_stock: bool = False,
    x_pin: str | None = Header(default=None, alias="X-Pin"),
):
    check_pin(x_pin)
    sql = "SELECT * FROM products WHERE 1=1"
    params: list[Any] = []
    if q:
        sql += " AND (name LIKE ? OR brand LIKE ? OR sku LIKE ? OR barcode LIKE ? OR supplier_name LIKE ?)"
        like = f"%{q}%"
        params.extend([like, like, like, like, like])
    if category:
        sql += " AND category = ?"
        params.append(category)
    if ownership_type:
        sql += " AND ownership_type = ?"
        params.append(ownership_type)
    if supplier:
        sql += " AND supplier_name LIKE ?"
        params.append(f"%{supplier}%")
    if low_stock:
        sql += " AND stock <= min_stock"
    sql += " ORDER BY ownership_type, name"
    with db() as conn:
        rows = conn.execute(sql, params).fetchall()
    return [row_to_dict(r) for r in rows]


@app.get("/api/suppliers")
async def list_suppliers(x_pin: str | None = Header(default=None, alias="X-Pin")):
    check_pin(x_pin)
    with db() as conn:
        rows = conn.execute(
            """
            SELECT supplier_name,
                   COUNT(*) AS products_count,
                   COALESCE(SUM(stock), 0) AS total_stock,
                   COALESCE(SUM(purchase_price * stock), 0) AS stock_value
            FROM products
            WHERE ownership_type = 'consignment' AND supplier_name != ''
            GROUP BY supplier_name
            ORDER BY supplier_name
            """
        ).fetchall()
        result = []
        for r in rows:
            sold_due = conn.execute(
                """
                SELECT COALESCE(SUM(supplier_due), 0)
                FROM sale_items si
                JOIN sales s ON s.id = si.sale_id
                WHERE si.ownership_type = 'consignment'
                  AND si.supplier_name = ?
                  AND s.status = 'completed'
                """,
                (r["supplier_name"],),
            ).fetchone()[0]
            paid = conn.execute(
                "SELECT COALESCE(SUM(amount), 0) FROM supplier_payments WHERE supplier_name = ?",
                (r["supplier_name"],),
            ).fetchone()[0]
            result.append({
                "supplier_name": r["supplier_name"],
                "products_count": r["products_count"],
                "total_stock": r["total_stock"],
                "stock_value": float(r["stock_value"]),
                "accrued_due": float(sold_due),
                "paid": float(paid),
                "balance": float(sold_due) - float(paid),
            })
    return result


@app.post("/api/products")
async def create_product(body: ProductIn, x_pin: str | None = Header(default=None, alias="X-Pin")):
    check_pin(x_pin)
    if body.ownership_type == "consignment" and not body.supplier_name.strip():
        raise HTTPException(status_code=400, detail="Укажите поставщика для товара под реализацию")
    with db() as conn:
        cur = conn.execute(
            """
            INSERT INTO products
            (name, category, ownership_type, supplier_name, brand, sku, barcode,
             purchase_price, sale_price, stock, min_stock, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                body.name, body.category, body.ownership_type, body.supplier_name.strip(),
                body.brand, body.sku, body.barcode, body.purchase_price, body.sale_price,
                body.stock, body.min_stock, utc_now(),
            ),
        )
        row = conn.execute("SELECT * FROM products WHERE id = ?", (cur.lastrowid,)).fetchone()
    return row_to_dict(row)


@app.put("/api/products/{product_id}")
async def update_product(product_id: int, body: ProductUpdate, x_pin: str | None = Header(default=None, alias="X-Pin")):
    check_pin(x_pin)
    fields = {k: v for k, v in body.model_dump().items() if v is not None}
    if not fields:
        raise HTTPException(status_code=400, detail="Нет данных для обновления")
    if fields.get("ownership_type") == "consignment" and not (fields.get("supplier_name") or "").strip():
        with db() as conn:
            existing = conn.execute("SELECT supplier_name FROM products WHERE id = ?", (product_id,)).fetchone()
            if not existing or not existing["supplier_name"]:
                raise HTTPException(status_code=400, detail="Укажите поставщика")
    sets = ", ".join(f"{k} = ?" for k in fields)
    with db() as conn:
        if not conn.execute("SELECT id FROM products WHERE id = ?", (product_id,)).fetchone():
            raise HTTPException(status_code=404, detail="Товар не найден")
        conn.execute(f"UPDATE products SET {sets} WHERE id = ?", (*fields.values(), product_id))
        row = conn.execute("SELECT * FROM products WHERE id = ?", (product_id,)).fetchone()
    return row_to_dict(row)


@app.delete("/api/products/{product_id}")
async def delete_product(product_id: int, x_pin: str | None = Header(default=None, alias="X-Pin")):
    check_pin(x_pin)
    with db() as conn:
        cur = conn.execute("DELETE FROM products WHERE id = ?", (product_id,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Товар не найден")
    return {"ok": True}


@app.post("/api/sales")
async def create_sale(body: SaleIn, x_pin: str | None = Header(default=None, alias="X-Pin")):
    check_pin(x_pin)
    if not body.items:
        raise HTTPException(status_code=400, detail="Корзина пуста")

    with db() as conn:
        subtotal = 0.0
        lines: list[dict[str, Any]] = []
        for item in body.items:
            product = conn.execute("SELECT * FROM products WHERE id = ?", (item.product_id,)).fetchone()
            if not product:
                raise HTTPException(status_code=404, detail=f"Товар #{item.product_id} не найден")
            if product["stock"] < item.quantity:
                raise HTTPException(
                    status_code=400,
                    detail=f"Недостаточно «{product['name']}»: на складе {product['stock']}",
                )
            calc = calc_line(product, item.quantity)
            subtotal += calc["subtotal"]
            lines.append({"product": product, "qty": item.quantity, **calc})

        total = max(0.0, subtotal - body.discount)
        now = utc_now()
        cur = conn.execute(
            "INSERT INTO sales (total, discount, payment_method, status, notes, created_at) VALUES (?, ?, ?, 'completed', ?, ?)",
            (total, body.discount, body.payment_method, body.notes, now),
        )
        sale_id = cur.lastrowid
        for line in lines:
            p = line["product"]
            conn.execute(
                """
                INSERT INTO sale_items
                (sale_id, product_id, product_name, ownership_type, supplier_name, quantity,
                 unit_price, purchase_price, supplier_due, shop_profit, subtotal)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    sale_id, p["id"], p["name"], line["ownership_type"], line["supplier_name"],
                    line["qty"], line["unit_price"], line["purchase_price"],
                    line["supplier_due"], line["shop_profit"], line["subtotal"],
                ),
            )
            conn.execute("UPDATE products SET stock = stock - ? WHERE id = ?", (line["qty"], p["id"]))

        sale = conn.execute("SELECT * FROM sales WHERE id = ?", (sale_id,)).fetchone()
        items = conn.execute("SELECT * FROM sale_items WHERE sale_id = ?", (sale_id,)).fetchall()

    result = row_to_dict(sale)
    result["items"] = [row_to_dict(i) for i in items]
    return result


@app.get("/api/sales")
async def list_sales(
    limit: int = Query(default=50, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    date_from: str = "",
    date_to: str = "",
    ownership_type: str = "",
    x_pin: str | None = Header(default=None, alias="X-Pin"),
):
    check_pin(x_pin)
    if ownership_type:
        sql = """
            SELECT DISTINCT s.* FROM sales s
            JOIN sale_items si ON si.sale_id = s.id
            WHERE s.status = 'completed' AND si.ownership_type = ?
        """
        params: list[Any] = [ownership_type]
    else:
        sql = "SELECT * FROM sales WHERE status = 'completed'"
        params = []
    df, dp = date_filter_sql(date_from, date_to, "s.created_at" if ownership_type else "created_at")
    sql += df.replace("s.created_at", "created_at") if not ownership_type else df
    params.extend(dp)
    sql += f" ORDER BY {'s.' if ownership_type else ''}created_at DESC LIMIT ? OFFSET ?"
    params.extend([limit, offset])
    with db() as conn:
        sales = conn.execute(sql, params).fetchall()
        total_count = conn.execute("SELECT COUNT(*) FROM sales WHERE status = 'completed'").fetchone()[0]
    return {"items": [row_to_dict(s) for s in sales], "total": total_count}


@app.get("/api/sales/{sale_id}")
async def get_sale(sale_id: int, x_pin: str | None = Header(default=None, alias="X-Pin")):
    check_pin(x_pin)
    with db() as conn:
        sale = conn.execute("SELECT * FROM sales WHERE id = ?", (sale_id,)).fetchone()
        if not sale:
            raise HTTPException(status_code=404, detail="Продажа не найдена")
        items = conn.execute("SELECT * FROM sale_items WHERE sale_id = ?", (sale_id,)).fetchall()
    result = row_to_dict(sale)
    result["items"] = [row_to_dict(i) for i in items]
    return result


@app.post("/api/sales/{sale_id}/void")
async def void_sale(sale_id: int, x_pin: str | None = Header(default=None, alias="X-Pin")):
    check_pin(x_pin)
    with db() as conn:
        sale = conn.execute("SELECT * FROM sales WHERE id = ? AND status = 'completed'", (sale_id,)).fetchone()
        if not sale:
            raise HTTPException(status_code=404, detail="Продажа не найдена")
        for item in conn.execute("SELECT * FROM sale_items WHERE sale_id = ?", (sale_id,)).fetchall():
            if item["product_id"]:
                conn.execute(
                    "UPDATE products SET stock = stock + ? WHERE id = ?",
                    (item["quantity"], item["product_id"]),
                )
        conn.execute("UPDATE sales SET status = 'voided' WHERE id = ?", (sale_id,))
    return {"ok": True}


@app.get("/api/supplier-payments")
async def list_supplier_payments(x_pin: str | None = Header(default=None, alias="X-Pin")):
    check_pin(x_pin)
    with db() as conn:
        rows = conn.execute("SELECT * FROM supplier_payments ORDER BY created_at DESC LIMIT 200").fetchall()
    return [row_to_dict(r) for r in rows]


@app.post("/api/supplier-payments")
async def create_supplier_payment(body: SupplierPaymentIn, x_pin: str | None = Header(default=None, alias="X-Pin")):
    check_pin(x_pin)
    with db() as conn:
        cur = conn.execute(
            "INSERT INTO supplier_payments (supplier_name, amount, notes, created_at) VALUES (?, ?, ?, ?)",
            (body.supplier_name.strip(), body.amount, body.notes, utc_now()),
        )
        row = conn.execute("SELECT * FROM supplier_payments WHERE id = ?", (cur.lastrowid,)).fetchone()
    return row_to_dict(row)


def _finance_report(conn: sqlite3.Connection, period: str, scope: str, date_from: str, date_to: str) -> dict[str, Any]:
    if date_from or date_to:
        since_clause, params = date_filter_sql(date_from, date_to)
        period_label = f"{date_from or '…'} — {date_to or '…'}"
    elif period == "all":
        since_clause, params = "", []
        period_label = "Всё время"
    else:
        since_clause = " AND s.created_at >= ?"
        params = [period_start(period)]
        period_label = {"day": "Сегодня", "week": "Неделя", "month": "Месяц", "quarter": "Квартал", "year": "Год"}.get(period, period)

    own_clause, own_params = ownership_filter_sql(scope)

    base = f"""
        FROM sale_items si
        JOIN sales s ON s.id = si.sale_id
        WHERE s.status = 'completed' {since_clause} {own_clause}
    """
    all_params = params + own_params

    agg = conn.execute(
        f"""
        SELECT COUNT(DISTINCT s.id) AS sales_count,
               COALESCE(SUM(si.subtotal), 0) AS gross_revenue,
               COALESCE(SUM(CASE WHEN si.ownership_type = 'own' THEN si.purchase_price * si.quantity ELSE 0 END), 0) AS own_cogs,
               COALESCE(SUM(CASE WHEN si.ownership_type = 'consignment' THEN si.supplier_due ELSE 0 END), 0) AS supplier_due,
               COALESCE(SUM(si.shop_profit), 0) AS shop_profit,
               COALESCE(SUM(si.quantity), 0) AS items_sold
        {base}
        """,
        all_params,
    ).fetchone()

    discounts = conn.execute(
        f"""
        SELECT COALESCE(SUM(s.discount), 0)
        FROM sales s
        WHERE s.status = 'completed' {since_clause.replace('s.created_at', 'created_at') if since_clause else ''}
        """,
        params,
    ).fetchone()[0] if scope == "all" else 0

    payment_rows = conn.execute(
        f"""
        SELECT s.payment_method, COUNT(DISTINCT s.id) AS cnt, COALESCE(SUM(si.subtotal), 0) AS amount
        {base}
        GROUP BY s.payment_method
        """,
        all_params,
    ).fetchall()

    own_revenue = conn.execute(
        f"SELECT COALESCE(SUM(si.subtotal), 0) {base} AND si.ownership_type = 'own'",
        params + (own_params if scope != "consignment" else []) if scope != "own" else all_params,
    ).fetchone()[0] if scope == "all" else (float(agg["gross_revenue"]) if scope == "own" else 0)

    cons_revenue = conn.execute(
        f"SELECT COALESCE(SUM(si.subtotal), 0) {base} AND si.ownership_type = 'consignment'",
        all_params if scope != "own" else params,
    ).fetchone()[0] if scope in ("all", "consignment") else 0

    revenue = float(agg["gross_revenue"])
    shop_profit = float(agg["shop_profit"])
    own_cogs = float(agg["own_cogs"])
    supplier_due = float(agg["supplier_due"])

    return {
        "scope": scope,
        "period": period,
        "period_label": period_label,
        "sales_count": agg["sales_count"],
        "items_sold": agg["items_sold"],
        "gross_revenue": revenue,
        "discounts": float(discounts),
        "net_revenue": revenue - float(discounts) if scope == "all" else revenue,
        "own_cogs": own_cogs,
        "supplier_due": supplier_due,
        "shop_profit": shop_profit,
        "margin_pct": round(shop_profit / revenue * 100, 1) if revenue else 0,
        "own_revenue": float(own_revenue) if scope == "all" else (revenue if scope == "own" else 0),
        "consignment_revenue": float(cons_revenue) if scope in ("all", "consignment") else 0,
        "by_payment": [
            {"method": r["payment_method"], "count": r["cnt"], "amount": float(r["amount"])}
            for r in payment_rows
        ],
    }


@app.get("/api/reports/finance")
async def finance_report(
    period: str = Query(default="month", pattern="^(day|week|month|quarter|year|all)$"),
    scope: ReportScope = "all",
    date_from: str = "",
    date_to: str = "",
    x_pin: str | None = Header(default=None, alias="X-Pin"),
):
    check_pin(x_pin)
    with db() as conn:
        report = _finance_report(conn, period, scope, date_from, date_to)
        if scope in ("all", "consignment"):
            if date_from or date_to:
                sup_since, sup_params = date_filter_sql(date_from, date_to)
            elif period == "all":
                sup_since, sup_params = "", []
            else:
                sup_since = " AND s.created_at >= ?"
                sup_params = [period_start(period)]
            suppliers = conn.execute(
                f"""
                SELECT si.supplier_name,
                       SUM(si.quantity) AS qty,
                       SUM(si.subtotal) AS revenue,
                       SUM(si.supplier_due) AS due,
                       SUM(si.shop_profit) AS profit
                FROM sale_items si
                JOIN sales s ON s.id = si.sale_id
                WHERE s.status = 'completed' AND si.ownership_type = 'consignment' {sup_since}
                GROUP BY si.supplier_name
                ORDER BY revenue DESC
                """,
                sup_params,
            ).fetchall()
            report["by_supplier"] = [row_to_dict(r) for r in suppliers]
        else:
            report["by_supplier"] = []
    return report


@app.get("/api/reports/combined")
async def combined_report(
    period: str = Query(default="month", pattern="^(day|week|month|quarter|year|all)$"),
    date_from: str = "",
    date_to: str = "",
    x_pin: str | None = Header(default=None, alias="X-Pin"),
):
    check_pin(x_pin)
    with db() as conn:
        return {
            "all": _finance_report(conn, period, "all", date_from, date_to),
            "own": _finance_report(conn, period, "own", date_from, date_to),
            "consignment": _finance_report(conn, period, "consignment", date_from, date_to),
        }


@app.get("/api/analytics/summary")
async def analytics_summary(
    period: str = Query(default="month", pattern="^(day|week|month|quarter|year|all)$"),
    scope: ReportScope = "all",
    x_pin: str | None = Header(default=None, alias="X-Pin"),
):
    check_pin(x_pin)
    with db() as conn:
        report = _finance_report(conn, period, scope, "", "")
        low_sql = "SELECT COUNT(*) FROM products WHERE stock <= min_stock"
        params: list[Any] = []
        if scope != "all":
            low_sql += " AND ownership_type = ?"
            params.append(scope)
        low_stock = conn.execute(low_sql, params).fetchone()[0]
        stock_sql = "SELECT COALESCE(SUM(purchase_price * stock), 0) FROM products WHERE 1=1"
        if scope != "all":
            stock_sql += " AND ownership_type = ?"
        stock_value = conn.execute(stock_sql, params).fetchone()[0]
        products_count = conn.execute(
            f"SELECT COUNT(*) FROM products {'WHERE ownership_type = ?' if scope != 'all' else ''}",
            params,
        ).fetchone()[0]

    return {
        "period": period,
        "scope": scope,
        "sales_count": report["sales_count"],
        "revenue": report["gross_revenue"],
        "profit": report["shop_profit"],
        "supplier_due": report["supplier_due"],
        "own_cogs": report["own_cogs"],
        "margin_pct": report["margin_pct"],
        "low_stock_count": low_stock,
        "stock_value": float(stock_value),
        "products_count": products_count,
    }


@app.get("/api/analytics/top-products")
async def analytics_top(
    period: str = Query(default="month", pattern="^(day|week|month|quarter|year|all)$"),
    scope: ReportScope = "all",
    limit: int = Query(default=10, ge=1, le=50),
    x_pin: str | None = Header(default=None, alias="X-Pin"),
):
    check_pin(x_pin)
    since_clause, params = ("", []) if period == "all" else ("AND s.created_at >= ?", [period_start(period)])
    own_clause, own_params = ownership_filter_sql(scope)
    params = params + own_params + [limit]
    with db() as conn:
        rows = conn.execute(
            f"""
            SELECT si.product_name AS name, si.ownership_type,
                   SUM(si.quantity) AS qty,
                   SUM(si.subtotal) AS revenue,
                   SUM(si.shop_profit) AS profit
            FROM sale_items si
            JOIN sales s ON s.id = si.sale_id
            WHERE s.status = 'completed' {since_clause} {own_clause}
            GROUP BY si.product_name, si.ownership_type
            ORDER BY revenue DESC
            LIMIT ?
            """,
            params,
        ).fetchall()
    return [row_to_dict(r) for r in rows]


@app.get("/api/analytics/daily")
async def analytics_daily(
    days: int = Query(default=30, ge=1, le=90),
    scope: ReportScope = "all",
    x_pin: str | None = Header(default=None, alias="X-Pin"),
):
    check_pin(x_pin)
    since = (datetime.now() - timedelta(days=days - 1)).strftime("%Y-%m-%d")
    own_clause, own_params = ownership_filter_sql(scope)
    with db() as conn:
        rows = conn.execute(
            f"""
            SELECT DATE(s.created_at) AS day,
                   COUNT(DISTINCT s.id) AS sales,
                   COALESCE(SUM(si.subtotal), 0) AS revenue,
                   COALESCE(SUM(si.shop_profit), 0) AS profit
            FROM sale_items si
            JOIN sales s ON s.id = si.sale_id
            WHERE s.status = 'completed' AND DATE(s.created_at) >= ? {own_clause}
            GROUP BY DATE(s.created_at)
            ORDER BY day
            """,
            [since, *own_params],
        ).fetchall()
    return [row_to_dict(r) for r in rows]


@app.get("/api/dashboard")
async def dashboard(x_pin: str | None = Header(default=None, alias="X-Pin")):
    check_pin(x_pin)
    with db() as conn:
        today = _finance_report(conn, "day", "all", "", "")
        month = _finance_report(conn, "month", "all", "", "")
        own_month = _finance_report(conn, "month", "own", "", "")
        cons_month = _finance_report(conn, "month", "consignment", "", "")
        suppliers = conn.execute(
            """
            SELECT supplier_name,
                   COALESCE(SUM(supplier_due), 0) AS accrued
            FROM sale_items si
            JOIN sales s ON s.id = si.sale_id
            WHERE si.ownership_type = 'consignment' AND s.status = 'completed'
            GROUP BY supplier_name
            """
        ).fetchall()
        balances = []
        for s in suppliers:
            paid = conn.execute(
                "SELECT COALESCE(SUM(amount), 0) FROM supplier_payments WHERE supplier_name = ?",
                (s["supplier_name"],),
            ).fetchone()[0]
            bal = float(s["accrued"]) - float(paid)
            if bal > 0:
                balances.append({"supplier_name": s["supplier_name"], "balance": bal})
        low_stock = conn.execute("SELECT COUNT(*) FROM products WHERE stock <= min_stock").fetchone()[0]
    return {
        "today": today,
        "month": month,
        "own_month": own_month,
        "consignment_month": cons_month,
        "supplier_balances": balances,
        "low_stock_count": low_stock,
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app:app", host="0.0.0.0", port=settings.port, reload=False)
