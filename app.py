"""Магазин телефонов и аксессуаров — касса, продажи, аналитика."""

from __future__ import annotations

import logging
import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Header, HTTPException, Query
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings, SettingsConfigDict

logger = logging.getLogger("telephons")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

STATIC_DIR = Path(__file__).resolve().parent / "static"
DATA_DIR = Path("/data") if Path("/data").exists() else Path(__file__).resolve().parent / "data"
DB_PATH = DATA_DIR / "store.db"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    store_pin: str = ""
    port: int = 80


settings = Settings()
settings.port = int(os.environ.get("PORT", settings.port))


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

            CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);
            CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode);
            CREATE INDEX IF NOT EXISTS idx_sales_created ON sales(created_at);
            """
        )
        count = conn.execute("SELECT COUNT(*) FROM products").fetchone()[0]
        if count == 0:
            now = utc_now()
            samples = [
                ("iPhone 15 128GB", "phone", "Apple", "IP15-128", "4601234567890", 62000, 74990, 5, 2),
                ("Samsung Galaxy A55", "phone", "Samsung", "A55-128", "4601234567891", 22000, 27990, 8, 2),
                ("Xiaomi Redmi Note 13", "phone", "Xiaomi", "RN13-256", "4601234567892", 14000, 18990, 10, 3),
                ("Чехол силиконовый", "accessory", "Generic", "CASE-SIL", "4601234567893", 150, 590, 50, 10),
                ("Защитное стекло", "accessory", "Generic", "GLASS-67", "4601234567894", 80, 390, 80, 15),
                ("USB-C кабель 1м", "accessory", "Baseus", "CABLE-C1", "4601234567895", 120, 490, 40, 10),
                ("Беспроводные наушники", "accessory", "JBL", "JBL-TUNE", "4601234567896", 1800, 3490, 12, 3),
                ("Powerbank 10000 mAh", "accessory", "Xiaomi", "PB-10K", "4601234567897", 900, 1990, 15, 5),
            ]
            conn.executemany(
                """
                INSERT INTO products
                (name, category, brand, sku, barcode, purchase_price, sale_price, stock, min_stock, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                [(*row, now) for row in samples],
            )


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


def utc_now() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def row_to_dict(row: sqlite3.Row | None) -> dict[str, Any] | None:
    if row is None:
        return None
    return dict(row)


def check_pin(pin: str | None) -> None:
    if settings.store_pin and pin != settings.store_pin:
        raise HTTPException(status_code=401, detail="Неверный PIN")


class ProductIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    category: str = "accessory"
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


app = FastAPI(title="Магазин телефонов")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.on_event("startup")
def on_startup():
    init_db()
    logger.info("DB: %s", DB_PATH)


@app.get("/")
async def index():
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/health")
async def health():
    return {"status": "ok", "db": str(DB_PATH), "db_exists": DB_PATH.exists()}


@app.get("/api/config")
async def config():
    return {"auth_required": bool(settings.store_pin), "store_name": "Магазин телефонов"}


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
    low_stock: bool = False,
    x_pin: str | None = Header(default=None, alias="X-Pin"),
):
    check_pin(x_pin)
    sql = "SELECT * FROM products WHERE 1=1"
    params: list[Any] = []
    if q:
        sql += " AND (name LIKE ? OR brand LIKE ? OR sku LIKE ? OR barcode LIKE ?)"
        like = f"%{q}%"
        params.extend([like, like, like, like])
    if category:
        sql += " AND category = ?"
        params.append(category)
    if low_stock:
        sql += " AND stock <= min_stock"
    sql += " ORDER BY name"
    with db() as conn:
        rows = conn.execute(sql, params).fetchall()
    return [row_to_dict(r) for r in rows]


@app.post("/api/products")
async def create_product(body: ProductIn, x_pin: str | None = Header(default=None, alias="X-Pin")):
    check_pin(x_pin)
    with db() as conn:
        cur = conn.execute(
            """
            INSERT INTO products
            (name, category, brand, sku, barcode, purchase_price, sale_price, stock, min_stock, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                body.name,
                body.category,
                body.brand,
                body.sku,
                body.barcode,
                body.purchase_price,
                body.sale_price,
                body.stock,
                body.min_stock,
                utc_now(),
            ),
        )
        pid = cur.lastrowid
        row = conn.execute("SELECT * FROM products WHERE id = ?", (pid,)).fetchone()
    return row_to_dict(row)


@app.put("/api/products/{product_id}")
async def update_product(
    product_id: int,
    body: ProductUpdate,
    x_pin: str | None = Header(default=None, alias="X-Pin"),
):
    check_pin(x_pin)
    fields = {k: v for k, v in body.model_dump().items() if v is not None}
    if not fields:
        raise HTTPException(status_code=400, detail="Нет данных для обновления")
    sets = ", ".join(f"{k} = ?" for k in fields)
    with db() as conn:
        exists = conn.execute("SELECT id FROM products WHERE id = ?", (product_id,)).fetchone()
        if not exists:
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
        lines: list[tuple] = []
        for item in body.items:
            product = conn.execute("SELECT * FROM products WHERE id = ?", (item.product_id,)).fetchone()
            if not product:
                raise HTTPException(status_code=404, detail=f"Товар #{item.product_id} не найден")
            if product["stock"] < item.quantity:
                raise HTTPException(
                    status_code=400,
                    detail=f"Недостаточно «{product['name']}»: на складе {product['stock']}",
                )
            line_sub = product["sale_price"] * item.quantity
            subtotal += line_sub
            lines.append(
                (
                    product["id"],
                    product["name"],
                    item.quantity,
                    product["sale_price"],
                    product["purchase_price"],
                    line_sub,
                )
            )

        total = max(0.0, subtotal - body.discount)
        now = utc_now()
        cur = conn.execute(
            """
            INSERT INTO sales (total, discount, payment_method, status, notes, created_at)
            VALUES (?, ?, ?, 'completed', ?, ?)
            """,
            (total, body.discount, body.payment_method, body.notes, now),
        )
        sale_id = cur.lastrowid
        for pid, pname, qty, price, cost, line_sub in lines:
            conn.execute(
                """
                INSERT INTO sale_items
                (sale_id, product_id, product_name, quantity, unit_price, purchase_price, subtotal)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (sale_id, pid, pname, qty, price, cost, line_sub),
            )
            conn.execute("UPDATE products SET stock = stock - ? WHERE id = ?", (qty, pid))

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
    x_pin: str | None = Header(default=None, alias="X-Pin"),
):
    check_pin(x_pin)
    sql = "SELECT * FROM sales WHERE status = 'completed'"
    params: list[Any] = []
    if date_from:
        sql += " AND created_at >= ?"
        params.append(date_from)
    if date_to:
        sql += " AND created_at <= ?"
        params.append(date_to + " 23:59:59")
    sql += " ORDER BY created_at DESC LIMIT ? OFFSET ?"
    params.extend([limit, offset])
    with db() as conn:
        sales = conn.execute(sql, params).fetchall()
        total_count = conn.execute(
            "SELECT COUNT(*) FROM sales WHERE status = 'completed'"
        ).fetchone()[0]
    return {
        "items": [row_to_dict(s) for s in sales],
        "total": total_count,
    }


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
        items = conn.execute("SELECT * FROM sale_items WHERE sale_id = ?", (sale_id,)).fetchall()
        for item in items:
            if item["product_id"]:
                conn.execute(
                    "UPDATE products SET stock = stock + ? WHERE id = ?",
                    (item["quantity"], item["product_id"]),
                )
        conn.execute("UPDATE sales SET status = 'voided' WHERE id = ?", (sale_id,))
    return {"ok": True}


def period_start(period: str) -> str:
    now = datetime.now()
    if period == "week":
        start = now - timedelta(days=now.weekday())
    elif period == "month":
        start = now.replace(day=1)
    else:
        start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    return start.strftime("%Y-%m-%d %H:%M:%S")


@app.get("/api/analytics/summary")
async def analytics_summary(
    period: str = Query(default="day", pattern="^(day|week|month|all)$"),
    x_pin: str | None = Header(default=None, alias="X-Pin"),
):
    check_pin(x_pin)
    with db() as conn:
        if period == "all":
            sales = conn.execute(
                "SELECT COUNT(*) AS cnt, COALESCE(SUM(total), 0) AS revenue FROM sales WHERE status = 'completed'"
            ).fetchone()
            profit_row = conn.execute(
                """
                SELECT COALESCE(SUM(si.subtotal - si.purchase_price * si.quantity), 0) AS profit
                FROM sale_items si
                JOIN sales s ON s.id = si.sale_id
                WHERE s.status = 'completed'
                """
            ).fetchone()
        else:
            since = period_start(period)
            sales = conn.execute(
                """
                SELECT COUNT(*) AS cnt, COALESCE(SUM(total), 0) AS revenue
                FROM sales WHERE status = 'completed' AND created_at >= ?
                """,
                (since,),
            ).fetchone()
            profit_row = conn.execute(
                """
                SELECT COALESCE(SUM(si.subtotal - si.purchase_price * si.quantity), 0) AS profit
                FROM sale_items si
                JOIN sales s ON s.id = si.sale_id
                WHERE s.status = 'completed' AND s.created_at >= ?
                """,
                (since,),
            ).fetchone()

        low_stock = conn.execute(
            "SELECT COUNT(*) FROM products WHERE stock <= min_stock"
        ).fetchone()[0]
        stock_value = conn.execute(
            "SELECT COALESCE(SUM(purchase_price * stock), 0) FROM products"
        ).fetchone()[0]

    revenue = float(sales["revenue"])
    profit = float(profit_row["profit"])
    return {
        "period": period,
        "sales_count": sales["cnt"],
        "revenue": revenue,
        "profit": profit,
        "margin_pct": round(profit / revenue * 100, 1) if revenue else 0,
        "low_stock_count": low_stock,
        "stock_value": float(stock_value),
    }


@app.get("/api/analytics/top-products")
async def analytics_top(
    period: str = Query(default="month", pattern="^(day|week|month|all)$"),
    limit: int = Query(default=10, ge=1, le=50),
    x_pin: str | None = Header(default=None, alias="X-Pin"),
):
    check_pin(x_pin)
    since_clause = ""
    params: list[Any] = []
    if period != "all":
        since_clause = "AND s.created_at >= ?"
        params.append(period_start(period))
    params.append(limit)
    with db() as conn:
        rows = conn.execute(
            f"""
            SELECT si.product_name AS name,
                   SUM(si.quantity) AS qty,
                   SUM(si.subtotal) AS revenue,
                   SUM(si.subtotal - si.purchase_price * si.quantity) AS profit
            FROM sale_items si
            JOIN sales s ON s.id = si.sale_id
            WHERE s.status = 'completed' {since_clause}
            GROUP BY si.product_name
            ORDER BY revenue DESC
            LIMIT ?
            """,
            params,
        ).fetchall()
    return [row_to_dict(r) for r in rows]


@app.get("/api/analytics/by-category")
async def analytics_by_category(
    period: str = Query(default="month", pattern="^(day|week|month|all)$"),
    x_pin: str | None = Header(default=None, alias="X-Pin"),
):
    check_pin(x_pin)
    since_clause = ""
    params: list[Any] = []
    if period != "all":
        since_clause = "AND s.created_at >= ?"
        params.append(period_start(period))
    with db() as conn:
        rows = conn.execute(
            f"""
            SELECT p.category,
                   COUNT(DISTINCT s.id) AS sales,
                   SUM(si.subtotal) AS revenue
            FROM sale_items si
            JOIN sales s ON s.id = si.sale_id
            LEFT JOIN products p ON p.id = si.product_id
            WHERE s.status = 'completed' {since_clause}
            GROUP BY p.category
            ORDER BY revenue DESC
            """,
            params,
        ).fetchall()
    labels = {"phone": "Телефоны", "accessory": "Аксессуары"}
    return [
        {
            "category": r["category"] or "other",
            "label": labels.get(r["category"] or "", r["category"] or "Прочее"),
            "sales": r["sales"],
            "revenue": float(r["revenue"] or 0),
        }
        for r in rows
    ]


@app.get("/api/analytics/daily")
async def analytics_daily(days: int = Query(default=14, ge=1, le=90), x_pin: str | None = Header(default=None, alias="X-Pin")):
    check_pin(x_pin)
    since = (datetime.now() - timedelta(days=days - 1)).strftime("%Y-%m-%d")
    with db() as conn:
        rows = conn.execute(
            """
            SELECT DATE(created_at) AS day,
                   COUNT(*) AS sales,
                   COALESCE(SUM(total), 0) AS revenue
            FROM sales
            WHERE status = 'completed' AND DATE(created_at) >= ?
            GROUP BY DATE(created_at)
            ORDER BY day
            """,
            (since,),
        ).fetchall()
    return [row_to_dict(r) for r in rows]


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app:app", host="0.0.0.0", port=settings.port, reload=False)
