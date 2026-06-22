"""Магазин телефонов — касса, склад, реализация, финансовые отчёты."""

from __future__ import annotations

import logging
import os
import sqlite3
from contextlib import asynccontextmanager, contextmanager
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Literal

from fastapi import FastAPI, File, Header, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings, SettingsConfigDict

logger = logging.getLogger("telephons")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

STATIC_DIR = Path(__file__).resolve().parent / "static"
DATA_DIR = Path("/data") if Path("/data").exists() else Path(__file__).resolve().parent / "data"
DB_PATH = DATA_DIR / "store.db"
UPLOADS_DIR = DATA_DIR / "uploads"
UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
ALLOWED_IMAGE_EXT = {".jpg", ".jpeg", ".png", ".webp", ".gif"}
MAX_IMAGE_BYTES = 5 * 1024 * 1024

OwnershipType = Literal["own", "consignment"]
ReportScope = Literal["all", "own", "consignment"]
ProductCondition = Literal["new", "used", "refurbished"]
UserRole = Literal["owner", "warehouse", "cashier"]
DEFAULT_WAREHOUSE_NAME = "Основной склад"

ROLE_PAGES: dict[str, list[str]] = {
    "owner": [
        "dashboard", "pos", "sales", "catalog", "warehouses", "products-own",
        "products-consignment", "suppliers", "trade-in", "reports", "analytics",
        "shifts", "users", "imei",
    ],
    "warehouse": [
        "dashboard", "catalog", "warehouses", "products-own", "products-consignment",
        "trade-in", "imei",
    ],
    "cashier": ["dashboard", "pos", "sales", "trade-in", "shifts"],
}

ROLE_LEVEL = {"cashier": 1, "warehouse": 2, "owner": 3}


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
    _add_column(conn, "products", "model", "TEXT DEFAULT ''")
    _add_column(conn, "products", "color", "TEXT DEFAULT ''")
    _add_column(conn, "products", "size", "TEXT DEFAULT ''")
    _add_column(conn, "products", "memory", "TEXT DEFAULT ''")
    _add_column(conn, "products", "ram", "TEXT DEFAULT ''")
    _add_column(conn, "products", "customs_cleared", "INTEGER NOT NULL DEFAULT 0")
    _add_column(conn, "products", "customs_price", "REAL NOT NULL DEFAULT 0")
    _add_column(conn, "products", "specs_extra", "TEXT DEFAULT ''")
    _add_column(conn, "products", "condition", "TEXT NOT NULL DEFAULT 'new'")
    _add_column(conn, "sale_items", "ownership_type", "TEXT NOT NULL DEFAULT 'own'")
    _add_column(conn, "sale_items", "supplier_name", "TEXT DEFAULT ''")
    _add_column(conn, "sale_items", "supplier_due", "REAL NOT NULL DEFAULT 0")
    _add_column(conn, "sale_items", "shop_profit", "REAL NOT NULL DEFAULT 0")
    _add_column(conn, "sales", "warehouse_id", "INTEGER")
    _add_column(conn, "sales", "cash_amount", "REAL NOT NULL DEFAULT 0")
    _add_column(conn, "sales", "card_amount", "REAL NOT NULL DEFAULT 0")
    _add_column(conn, "sales", "trade_in_value", "REAL NOT NULL DEFAULT 0")
    _add_column(conn, "sales", "shift_id", "INTEGER")
    _add_column(conn, "products", "track_units", "INTEGER NOT NULL DEFAULT 0")
    _add_column(conn, "products", "image_url", "TEXT DEFAULT ''")
    conn.execute("UPDATE products SET track_units = 1 WHERE category = 'phone' AND track_units = 0")
    conn.execute(
        """
        UPDATE sale_items
        SET shop_profit = subtotal - purchase_price * quantity
        WHERE shop_profit = 0 AND subtotal != 0
        """
    )

    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS warehouses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            address TEXT DEFAULT '',
            notes TEXT DEFAULT '',
            is_default INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS warehouse_stock (
            warehouse_id INTEGER NOT NULL,
            product_id INTEGER NOT NULL,
            quantity INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (warehouse_id, product_id),
            FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON DELETE CASCADE,
            FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS stock_movements (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            warehouse_id INTEGER NOT NULL,
            product_id INTEGER NOT NULL,
            movement_type TEXT NOT NULL,
            quantity INTEGER NOT NULL,
            target_warehouse_id INTEGER,
            reference_id INTEGER,
            notes TEXT DEFAULT '',
            created_at TEXT NOT NULL,
            FOREIGN KEY (warehouse_id) REFERENCES warehouses(id),
            FOREIGN KEY (product_id) REFERENCES products(id)
        );

        CREATE TABLE IF NOT EXISTS trade_ins (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            given_product_id INTEGER NOT NULL,
            given_warehouse_id INTEGER NOT NULL,
            received_name TEXT NOT NULL,
            received_brand TEXT DEFAULT '',
            received_model TEXT DEFAULT '',
            received_color TEXT DEFAULT '',
            received_size TEXT DEFAULT '',
            received_memory TEXT DEFAULT '',
            received_ram TEXT DEFAULT '',
            received_specs_extra TEXT DEFAULT '',
            received_condition TEXT NOT NULL DEFAULT 'used',
            received_purchase_price REAL NOT NULL DEFAULT 0,
            received_sale_price REAL NOT NULL DEFAULT 0,
            received_value REAL NOT NULL DEFAULT 0,
            cash_amount REAL NOT NULL DEFAULT 0,
            card_amount REAL NOT NULL DEFAULT 0,
            received_product_id INTEGER,
            received_warehouse_id INTEGER,
            sale_id INTEGER,
            notes TEXT DEFAULT '',
            created_at TEXT NOT NULL,
            FOREIGN KEY (given_product_id) REFERENCES products(id),
            FOREIGN KEY (given_warehouse_id) REFERENCES warehouses(id),
            FOREIGN KEY (received_product_id) REFERENCES products(id),
            FOREIGN KEY (received_warehouse_id) REFERENCES warehouses(id),
            FOREIGN KEY (sale_id) REFERENCES sales(id)
        );

        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            pin TEXT NOT NULL UNIQUE,
            role TEXT NOT NULL DEFAULT 'cashier',
            is_active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS product_units (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            product_id INTEGER NOT NULL,
            warehouse_id INTEGER NOT NULL,
            imei TEXT DEFAULT '',
            serial TEXT DEFAULT '',
            status TEXT NOT NULL DEFAULT 'in_stock',
            sale_id INTEGER,
            notes TEXT DEFAULT '',
            created_at TEXT NOT NULL,
            FOREIGN KEY (product_id) REFERENCES products(id),
            FOREIGN KEY (warehouse_id) REFERENCES warehouses(id)
        );

        CREATE TABLE IF NOT EXISTS shifts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            user_name TEXT DEFAULT '',
            opened_at TEXT NOT NULL,
            closed_at TEXT,
            opening_cash REAL NOT NULL DEFAULT 0,
            expected_cash REAL NOT NULL DEFAULT 0,
            expected_card REAL NOT NULL DEFAULT 0,
            actual_cash REAL,
            actual_card REAL,
            sales_count INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'open',
            notes TEXT DEFAULT ''
        );

        CREATE TABLE IF NOT EXISTS sale_item_units (
            sale_item_id INTEGER NOT NULL,
            unit_id INTEGER NOT NULL,
            imei TEXT DEFAULT '',
            serial TEXT DEFAULT '',
            PRIMARY KEY (sale_item_id, unit_id),
            FOREIGN KEY (sale_item_id) REFERENCES sale_items(id) ON DELETE CASCADE,
            FOREIGN KEY (unit_id) REFERENCES product_units(id)
        );
        """
    )

    conn.executescript(
        """
        CREATE INDEX IF NOT EXISTS idx_units_product ON product_units(product_id);
        CREATE INDEX IF NOT EXISTS idx_units_warehouse ON product_units(warehouse_id);
        CREATE INDEX IF NOT EXISTS idx_units_status ON product_units(status);
        CREATE INDEX IF NOT EXISTS idx_shifts_status ON shifts(status);
        """
    )

    if conn.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 0:
        now = utc_now()
        owner_pin = settings.store_pin or "1234"
        conn.executemany(
            "INSERT INTO users (name, pin, role, is_active, created_at) VALUES (?, ?, ?, 1, ?)",
            [
                ("Владелец", owner_pin, "owner", now),
                ("Кассир", "1111", "cashier", now),
                ("Кладовщик", "2222", "warehouse", now),
            ],
        )

    default_wh = conn.execute(
        "SELECT id FROM warehouses WHERE is_default = 1 LIMIT 1"
    ).fetchone()
    if not default_wh:
        cur = conn.execute(
            """
            INSERT INTO warehouses (name, address, notes, is_default, created_at)
            VALUES (?, '', '', 1, ?)
            """,
            (DEFAULT_WAREHOUSE_NAME, utc_now()),
        )
        default_wh_id = cur.lastrowid
    else:
        default_wh_id = default_wh["id"]

    migrated = conn.execute(
        "SELECT COUNT(*) FROM warehouse_stock"
    ).fetchone()[0]
    if migrated == 0:
        products = conn.execute(
            "SELECT id, stock FROM products WHERE stock > 0"
        ).fetchall()
        now = utc_now()
        for p in products:
            conn.execute(
                """
                INSERT INTO warehouse_stock (warehouse_id, product_id, quantity)
                VALUES (?, ?, ?)
                """,
                (default_wh_id, p["id"], p["stock"]),
            )
            conn.execute(
                """
                INSERT INTO stock_movements
                (warehouse_id, product_id, movement_type, quantity, notes, created_at)
                VALUES (?, ?, 'inbound', ?, 'Миграция начального остатка', ?)
                """,
                (default_wh_id, p["id"], p["stock"], now),
            )

    conn.execute(
        "UPDATE sales SET warehouse_id = ? WHERE warehouse_id IS NULL",
        (default_wh_id,),
    )


def init_db() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
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
            CREATE INDEX IF NOT EXISTS idx_products_model ON products(model);
            CREATE INDEX IF NOT EXISTS idx_sales_created ON sales(created_at);
            CREATE INDEX IF NOT EXISTS idx_sales_warehouse ON sales(warehouse_id);
            CREATE INDEX IF NOT EXISTS idx_warehouse_stock_product ON warehouse_stock(product_id);
            CREATE INDEX IF NOT EXISTS idx_stock_movements_created ON stock_movements(created_at);
            CREATE INDEX IF NOT EXISTS idx_trade_ins_created ON trade_ins(created_at);
            """
        )

        count = conn.execute("SELECT COUNT(*) FROM products").fetchone()[0]
        if count == 0:
            now = utc_now()
            default_wh_id = get_default_warehouse_id(conn)
            samples = [
                ("iPhone 15 128GB", "phone", "own", "", "Apple", "IP15-128", "4601234567890", 62000, 74990, 5, 2,
                 "iPhone 15", "Чёрный", "", "128GB", "6GB", 1, 0, "", "new"),
                ("Samsung Galaxy A55", "phone", "own", "", "Samsung", "A55-128", "4601234567891", 22000, 27990, 8, 2,
                 "Galaxy A55", "Синий", "", "128GB", "8GB", 1, 0, "", "new"),
                ("Xiaomi Redmi Note 13", "phone", "consignment", "ООО ТехноСнаб", "Xiaomi", "RN13-256", "4601234567892",
                 14000, 18990, 10, 3, "Redmi Note 13", "Чёрный", "", "256GB", "8GB", 0, 0, "", "new"),
                ("iPhone 14 Pro (комиссия)", "phone", "consignment", "ИП Петров", "Apple", "IP14P-256", "4601234567893",
                 55000, 69990, 3, 1, "iPhone 14 Pro", "Фиолетовый", "", "256GB", "6GB", 1, 0, "", "new"),
                ("Чехол силиконовый", "accessory", "own", "", "Generic", "CASE-SIL", "4601234567894", 150, 590, 50, 10,
                 "", "", "", "", "", 0, 0, "", "new"),
                ("Защитное стекло", "accessory", "own", "", "Generic", "GLASS-67", "4601234567895", 80, 390, 80, 15,
                 "", "", "6.7\"", "", "", 0, 0, "", "new"),
                ("Наушники JBL (реализация)", "accessory", "consignment", "ООО ТехноСнаб", "JBL", "JBL-TUNE", "4601234567896",
                 1800, 3490, 12, 3, "Tune 520BT", "Чёрный", "", "", "", 0, 0, "", "new"),
                ("Powerbank 10000 mAh", "accessory", "own", "", "Xiaomi", "PB-10K", "4601234567897", 900, 1990, 15, 5,
                 "Mi Power Bank 3", "Белый", "", "10000 mAh", "", 0, 0, "", "new"),
            ]
            for row in samples:
                cur = conn.execute(
                    """
                    INSERT INTO products
                    (name, category, ownership_type, supplier_name, brand, sku, barcode,
                     purchase_price, sale_price, stock, min_stock, created_at,
                     model, color, size, memory, ram, customs_cleared, customs_price, specs_extra, condition)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (*row[:12], *row[12:], now),
                )
                pid = cur.lastrowid
                qty = row[9]
                if qty > 0:
                    conn.execute(
                        """
                        INSERT INTO warehouse_stock (warehouse_id, product_id, quantity)
                        VALUES (?, ?, ?)
                        """,
                        (default_wh_id, pid, qty),
                    )


def resolve_user(conn: sqlite3.Connection, pin: str | None) -> dict[str, Any] | None:
    if not pin:
        user_count = conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]
        if user_count == 0 and not settings.store_pin:
            return {"id": 0, "name": "Система", "role": "owner", "pin": ""}
        return None
    row = conn.execute(
        "SELECT * FROM users WHERE pin = ? AND is_active = 1", (pin,)
    ).fetchone()
    if row:
        return row_to_dict(row)
    if settings.store_pin and pin == settings.store_pin:
        return {"id": 0, "name": "Владелец", "role": "owner", "pin": pin}
    return None


def check_pin(pin: str | None, *, min_role: str | None = None) -> dict[str, Any]:
    with db() as conn:
        user = resolve_user(conn, pin)
        if not user:
            raise HTTPException(status_code=401, detail="Неверный PIN")
        if min_role and ROLE_LEVEL.get(user["role"], 0) < ROLE_LEVEL.get(min_role, 99):
            raise HTTPException(status_code=403, detail="Недостаточно прав")
        return user


def get_open_shift(conn: sqlite3.Connection) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT * FROM shifts WHERE status = 'open' ORDER BY id DESC LIMIT 1"
    ).fetchone()


def shift_sales_totals(conn: sqlite3.Connection, shift_id: int) -> dict[str, float | int]:
    row = conn.execute(
        """
        SELECT COUNT(*) AS cnt,
               COALESCE(SUM(cash_amount), 0) AS cash,
               COALESCE(SUM(card_amount), 0) AS card,
               COALESCE(SUM(total), 0) AS total
        FROM sales
        WHERE shift_id = ? AND status = 'completed'
        """,
        (shift_id,),
    ).fetchone()
    return {
        "sales_count": row["cnt"],
        "expected_cash": float(row["cash"]),
        "expected_card": float(row["card"]),
        "total_revenue": float(row["total"]),
    }


def pick_units(
    conn: sqlite3.Connection,
    product_id: int,
    warehouse_id: int,
    quantity: int,
    unit_ids: list[int] | None,
) -> list[sqlite3.Row]:
    if unit_ids:
        if len(unit_ids) != quantity:
            raise HTTPException(status_code=400, detail="Количество IMEI должно совпадать с количеством товара")
        placeholders = ",".join("?" * len(unit_ids))
        rows = conn.execute(
            f"""
            SELECT * FROM product_units
            WHERE id IN ({placeholders}) AND product_id = ? AND warehouse_id = ?
              AND status = 'in_stock'
            """,
            (*unit_ids, product_id, warehouse_id),
        ).fetchall()
        if len(rows) != quantity:
            raise HTTPException(status_code=400, detail="Указаны недоступные IMEI/серийники")
        return rows
    rows = conn.execute(
        """
        SELECT * FROM product_units
        WHERE product_id = ? AND warehouse_id = ? AND status = 'in_stock'
        ORDER BY id LIMIT ?
        """,
        (product_id, warehouse_id, quantity),
    ).fetchall()
    if len(rows) < quantity:
        raise HTTPException(
            status_code=400,
            detail=f"Не хватает IMEI на складе: нужно {quantity}, доступно {len(rows)}",
        )
    return rows


def mark_units_sold(conn: sqlite3.Connection, units: list[sqlite3.Row], sale_id: int) -> None:
    for u in units:
        conn.execute(
            "UPDATE product_units SET status = 'sold', sale_id = ? WHERE id = ?",
            (sale_id, u["id"]),
        )


def restore_units_for_sale(conn: sqlite3.Connection, sale_id: int) -> None:
    conn.execute(
        "UPDATE product_units SET status = 'in_stock', sale_id = NULL WHERE sale_id = ?",
        (sale_id,),
    )


def get_default_warehouse_id(conn: sqlite3.Connection) -> int:
    row = conn.execute(
        "SELECT id FROM warehouses WHERE is_default = 1 LIMIT 1"
    ).fetchone()
    if not row:
        raise HTTPException(status_code=500, detail="Склад по умолчанию не найден")
    return int(row["id"])


def resolve_warehouse_id(conn: sqlite3.Connection, warehouse_id: int | None) -> int:
    if warehouse_id is not None:
        row = conn.execute("SELECT id FROM warehouses WHERE id = ?", (warehouse_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Склад не найден")
        return warehouse_id
    return get_default_warehouse_id(conn)


def sync_product_stock(conn: sqlite3.Connection, product_id: int) -> int:
    total = conn.execute(
        """
        SELECT COALESCE(SUM(quantity), 0)
        FROM warehouse_stock WHERE product_id = ?
        """,
        (product_id,),
    ).fetchone()[0]
    conn.execute("UPDATE products SET stock = ? WHERE id = ?", (total, product_id))
    return int(total)


def get_warehouse_stock(conn: sqlite3.Connection, warehouse_id: int, product_id: int) -> int:
    row = conn.execute(
        """
        SELECT quantity FROM warehouse_stock
        WHERE warehouse_id = ? AND product_id = ?
        """,
        (warehouse_id, product_id),
    ).fetchone()
    return int(row["quantity"]) if row else 0


def record_stock_movement(
    conn: sqlite3.Connection,
    warehouse_id: int,
    product_id: int,
    movement_type: str,
    quantity: int,
    *,
    target_warehouse_id: int | None = None,
    reference_id: int | None = None,
    notes: str = "",
) -> int:
    cur = conn.execute(
        """
        INSERT INTO stock_movements
        (warehouse_id, product_id, movement_type, quantity, target_warehouse_id, reference_id, notes, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (warehouse_id, product_id, movement_type, quantity, target_warehouse_id, reference_id, notes, utc_now()),
    )
    return int(cur.lastrowid)


def adjust_warehouse_stock(
    conn: sqlite3.Connection,
    warehouse_id: int,
    product_id: int,
    delta: int,
    movement_type: str,
    *,
    target_warehouse_id: int | None = None,
    reference_id: int | None = None,
    notes: str = "",
) -> tuple[int, int | None]:
    if delta == 0:
        return get_warehouse_stock(conn, warehouse_id, product_id), None
    current = get_warehouse_stock(conn, warehouse_id, product_id)
    new_qty = current + delta
    if new_qty < 0:
        product = conn.execute("SELECT name FROM products WHERE id = ?", (product_id,)).fetchone()
        name = product["name"] if product else f"#{product_id}"
        raise HTTPException(
            status_code=400,
            detail=f"Недостаточно «{name}» на складе: доступно {current}, нужно {abs(delta)}",
        )
    if current == 0 and delta > 0:
        conn.execute(
            """
            INSERT INTO warehouse_stock (warehouse_id, product_id, quantity)
            VALUES (?, ?, ?)
            """,
            (warehouse_id, product_id, delta),
        )
    else:
        conn.execute(
            """
            UPDATE warehouse_stock SET quantity = ?
            WHERE warehouse_id = ? AND product_id = ?
            """,
            (new_qty, warehouse_id, product_id),
        )
    movement_id = record_stock_movement(
        conn, warehouse_id, product_id, movement_type, abs(delta),
        target_warehouse_id=target_warehouse_id,
        reference_id=reference_id,
        notes=notes,
    )
    sync_product_stock(conn, product_id)
    return new_qty, movement_id


def enrich_product(conn: sqlite3.Connection, product: sqlite3.Row) -> dict[str, Any]:
    data = row_to_dict(product) or {}
    rows = conn.execute(
        """
        SELECT ws.warehouse_id, ws.quantity, w.name AS warehouse_name
        FROM warehouse_stock ws
        JOIN warehouses w ON w.id = ws.warehouse_id
        WHERE ws.product_id = ?
        ORDER BY w.is_default DESC, w.name
        """,
        (product["id"],),
    ).fetchall()
    stock_by_warehouse = {str(r["warehouse_id"]): r["quantity"] for r in rows}
    data["stock_by_warehouse"] = stock_by_warehouse
    data["stock"] = int(sum(stock_by_warehouse.values()))
    if int(product["track_units"] or 0):
        unit_rows = conn.execute(
            """
            SELECT warehouse_id, COUNT(*) AS cnt FROM product_units
            WHERE product_id = ? AND status = 'in_stock'
            GROUP BY warehouse_id
            """,
            (product["id"],),
        ).fetchall()
        units_by_warehouse = {str(r["warehouse_id"]): int(r["cnt"]) for r in unit_rows}
        data["units_by_warehouse"] = units_by_warehouse
        data["units_available"] = int(sum(units_by_warehouse.values()))
    return data


def enrich_sale_items(conn: sqlite3.Connection, items: list[sqlite3.Row]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for item in items:
        d = row_to_dict(item) or {}
        units = conn.execute(
            "SELECT * FROM sale_item_units WHERE sale_item_id = ?", (item["id"],)
        ).fetchall()
        d["units"] = [row_to_dict(u) for u in units]
        result.append(d)
    return result


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
    model: str = ""
    color: str = ""
    size: str = ""
    memory: str = ""
    ram: str = ""
    customs_cleared: int = Field(ge=0, le=1, default=0)
    customs_price: float = Field(ge=0, default=0)
    specs_extra: str = ""
    condition: ProductCondition = "new"
    warehouse_id: int | None = None
    track_units: int | None = None
    image_url: str = ""


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
    model: str | None = None
    color: str | None = None
    size: str | None = None
    memory: str | None = None
    ram: str | None = None
    customs_cleared: int | None = Field(default=None, ge=0, le=1)
    customs_price: float | None = Field(default=None, ge=0)
    specs_extra: str | None = None
    condition: ProductCondition | None = None
    warehouse_id: int | None = None
    track_units: int | None = Field(default=None, ge=0, le=1)
    image_url: str | None = None


class CartItem(BaseModel):
    product_id: int
    quantity: int = Field(ge=1)
    unit_ids: list[int] = Field(default_factory=list)


class SaleIn(BaseModel):
    items: list[CartItem]
    discount: float = Field(ge=0, default=0)
    payment_method: str = "cash"
    notes: str = ""
    warehouse_id: int | None = None
    shift_id: int | None = None


class UnitIn(BaseModel):
    product_id: int
    warehouse_id: int
    imei: str = ""
    serial: str = ""
    notes: str = ""


class UserIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    pin: str = Field(min_length=4, max_length=12)
    role: UserRole = "cashier"


class UserUpdate(BaseModel):
    name: str | None = None
    pin: str | None = Field(default=None, min_length=4, max_length=12)
    role: UserRole | None = None
    is_active: int | None = Field(default=None, ge=0, le=1)


class ShiftOpenIn(BaseModel):
    opening_cash: float = Field(ge=0, default=0)


class ShiftCloseIn(BaseModel):
    actual_cash: float = Field(ge=0)
    actual_card: float = Field(ge=0)
    notes: str = ""


class SupplierPaymentIn(BaseModel):
    supplier_name: str = Field(min_length=1)
    amount: float = Field(gt=0)
    notes: str = ""


class WarehouseIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    address: str = ""
    notes: str = ""
    is_default: bool = False


class WarehouseUpdate(BaseModel):
    name: str | None = None
    address: str | None = None
    notes: str | None = None
    is_default: bool | None = None


class StockMovementIn(BaseModel):
    warehouse_id: int
    product_id: int
    quantity: int = Field(ge=1)
    notes: str = ""


class StockTransferIn(BaseModel):
    product_id: int
    from_warehouse_id: int
    to_warehouse_id: int
    quantity: int = Field(ge=1)
    notes: str = ""


class TradeInIn(BaseModel):
    given_product_id: int
    given_warehouse_id: int
    received_name: str = Field(min_length=1, max_length=200)
    received_brand: str = ""
    received_model: str = ""
    received_color: str = ""
    received_size: str = ""
    received_memory: str = ""
    received_ram: str = ""
    received_specs_extra: str = ""
    received_condition: ProductCondition = "used"
    received_purchase_price: float = Field(ge=0, default=0)
    received_sale_price: float = Field(ge=0, default=0)
    received_value: float = Field(ge=0)
    cash_amount: float = Field(ge=0, default=0)
    card_amount: float = Field(ge=0, default=0)
    received_warehouse_id: int | None = None
    given_unit_id: int | None = None
    received_imei: str = ""
    received_serial: str = ""
    notes: str = ""


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_db()
    logger.info("DB: %s", DB_PATH)
    yield


app = FastAPI(title=settings.store_name, lifespan=lifespan)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
app.mount("/uploads", StaticFiles(directory=UPLOADS_DIR), name="uploads")


@app.get("/")
async def index():
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/health")
async def health():
    return {"status": "ok", "db": str(DB_PATH), "db_exists": DB_PATH.exists()}


@app.get("/api/config")
async def config():
    with db() as conn:
        user_count = conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]
    return {
        "auth_required": user_count > 0 or bool(settings.store_pin),
        "store_name": settings.store_name,
        "role_pages": ROLE_PAGES,
    }


@app.post("/api/auth/check")
async def auth_check(body: dict):
    pin = body.get("pin", "")
    with db() as conn:
        user = resolve_user(conn, pin)
        if not user:
            raise HTTPException(status_code=401, detail="Неверный PIN")
        shift = get_open_shift(conn)
        return {
            "ok": True,
            "user": {"id": user["id"], "name": user["name"], "role": user["role"]},
            "pages": ROLE_PAGES.get(user["role"], []),
            "open_shift": row_to_dict(shift) if shift else None,
        }


# --- Users (owner) ---


@app.get("/api/users")
async def list_users(x_pin: str | None = Header(default=None, alias="X-Pin")):
    check_pin(x_pin, min_role="owner")
    with db() as conn:
        rows = conn.execute(
            "SELECT id, name, role, is_active, created_at FROM users ORDER BY role, name"
        ).fetchall()
    return [row_to_dict(r) for r in rows]


@app.post("/api/users")
async def create_user(body: UserIn, x_pin: str | None = Header(default=None, alias="X-Pin")):
    check_pin(x_pin, min_role="owner")
    with db() as conn:
        try:
            cur = conn.execute(
                "INSERT INTO users (name, pin, role, is_active, created_at) VALUES (?, ?, ?, 1, ?)",
                (body.name.strip(), body.pin, body.role, utc_now()),
            )
            row = conn.execute(
                "SELECT id, name, role, is_active, created_at FROM users WHERE id = ?",
                (cur.lastrowid,),
            ).fetchone()
        except sqlite3.IntegrityError:
            raise HTTPException(status_code=400, detail="PIN уже используется")
    return row_to_dict(row)


@app.put("/api/users/{user_id}")
async def update_user(user_id: int, body: UserUpdate, x_pin: str | None = Header(default=None, alias="X-Pin")):
    check_pin(x_pin, min_role="owner")
    fields = {k: v for k, v in body.model_dump().items() if v is not None}
    if not fields:
        raise HTTPException(status_code=400, detail="Нет данных")
    sets = ", ".join(f"{k} = ?" for k in fields)
    with db() as conn:
        try:
            conn.execute(f"UPDATE users SET {sets} WHERE id = ?", (*fields.values(), user_id))
        except sqlite3.IntegrityError:
            raise HTTPException(status_code=400, detail="PIN уже используется")
        row = conn.execute(
            "SELECT id, name, role, is_active, created_at FROM users WHERE id = ?", (user_id,)
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Пользователь не найден")
    return row_to_dict(row)


# --- Shifts ---


@app.get("/api/shifts/current")
async def current_shift(x_pin: str | None = Header(default=None, alias="X-Pin")):
    check_pin(x_pin)
    with db() as conn:
        shift = get_open_shift(conn)
        if not shift:
            return {"shift": None, "summary": None}
        summary = shift_sales_totals(conn, shift["id"])
        return {"shift": row_to_dict(shift), "summary": summary}


@app.post("/api/shifts/open")
async def open_shift(body: ShiftOpenIn, x_pin: str | None = Header(default=None, alias="X-Pin")):
    user = check_pin(x_pin)
    with db() as conn:
        if get_open_shift(conn):
            raise HTTPException(status_code=400, detail="Смена уже открыта")
        cur = conn.execute(
            """
            INSERT INTO shifts (user_id, user_name, opened_at, opening_cash, status)
            VALUES (?, ?, ?, ?, 'open')
            """,
            (user.get("id") or None, user.get("name", ""), utc_now(), body.opening_cash),
        )
        row = conn.execute("SELECT * FROM shifts WHERE id = ?", (cur.lastrowid,)).fetchone()
    return row_to_dict(row)


@app.post("/api/shifts/{shift_id}/close")
async def close_shift(shift_id: int, body: ShiftCloseIn, x_pin: str | None = Header(default=None, alias="X-Pin")):
    check_pin(x_pin)
    with db() as conn:
        shift = conn.execute(
            "SELECT * FROM shifts WHERE id = ? AND status = 'open'", (shift_id,)
        ).fetchone()
        if not shift:
            raise HTTPException(status_code=404, detail="Открытая смена не найдена")
        totals = shift_sales_totals(conn, shift_id)
        expected_cash = float(shift["opening_cash"]) + totals["expected_cash"]
        conn.execute(
            """
            UPDATE shifts SET
                closed_at = ?, status = 'closed',
                expected_cash = ?, expected_card = ?,
                actual_cash = ?, actual_card = ?,
                sales_count = ?, notes = ?
            WHERE id = ?
            """,
            (
                utc_now(), totals["expected_cash"], totals["expected_card"],
                body.actual_cash, body.actual_card, totals["sales_count"],
                body.notes, shift_id,
            ),
        )
        row = conn.execute("SELECT * FROM shifts WHERE id = ?", (shift_id,)).fetchone()
    result = row_to_dict(row)
    result["expected_cash_in_drawer"] = expected_cash
    result["cash_difference"] = body.actual_cash - expected_cash
    result["card_difference"] = body.actual_card - totals["expected_card"]
    return result


@app.get("/api/shifts")
async def list_shifts(limit: int = Query(default=30, ge=1, le=200), x_pin: str | None = Header(default=None, alias="X-Pin")):
    check_pin(x_pin, min_role="owner")
    with db() as conn:
        rows = conn.execute(
            "SELECT * FROM shifts ORDER BY opened_at DESC LIMIT ?", (limit,)
        ).fetchall()
    return [row_to_dict(r) for r in rows]


# --- Product units (IMEI) ---


@app.get("/api/units")
async def list_units(
    product_id: int | None = None,
    warehouse_id: int | None = None,
    status: str = "in_stock",
    q: str = "",
    x_pin: str | None = Header(default=None, alias="X-Pin"),
):
    check_pin(x_pin)
    sql = """
        SELECT u.*, p.name AS product_name, p.model, w.name AS warehouse_name
        FROM product_units u
        JOIN products p ON p.id = u.product_id
        JOIN warehouses w ON w.id = u.warehouse_id
        WHERE 1=1
    """
    params: list[Any] = []
    if product_id:
        sql += " AND u.product_id = ?"
        params.append(product_id)
    if warehouse_id:
        sql += " AND u.warehouse_id = ?"
        params.append(warehouse_id)
    if status:
        sql += " AND u.status = ?"
        params.append(status)
    if q:
        like = f"%{q}%"
        sql += " AND (u.imei LIKE ? OR u.serial LIKE ? OR p.name LIKE ?)"
        params.extend([like, like, like])
    sql += " ORDER BY u.created_at DESC LIMIT 500"
    with db() as conn:
        rows = conn.execute(sql, params).fetchall()
    return [row_to_dict(r) for r in rows]


@app.post("/api/units")
async def create_unit(body: UnitIn, x_pin: str | None = Header(default=None, alias="X-Pin")):
    check_pin(x_pin, min_role="warehouse")
    if not body.imei.strip() and not body.serial.strip():
        raise HTTPException(status_code=400, detail="Укажите IMEI или серийный номер")
    with db() as conn:
        product = conn.execute("SELECT * FROM products WHERE id = ?", (body.product_id,)).fetchone()
        if not product:
            raise HTTPException(status_code=404, detail="Товар не найден")
        wh = resolve_warehouse_id(conn, body.warehouse_id)
        imei = body.imei.strip()
        serial = body.serial.strip()
        if imei:
            dup = conn.execute(
                "SELECT id FROM product_units WHERE imei = ? AND status != 'sold'", (imei,)
            ).fetchone()
            if dup:
                raise HTTPException(status_code=400, detail="IMEI уже в системе")
        cur = conn.execute(
            """
            INSERT INTO product_units
            (product_id, warehouse_id, imei, serial, status, notes, created_at)
            VALUES (?, ?, ?, ?, 'in_stock', ?, ?)
            """,
            (body.product_id, wh, imei, serial, body.notes, utc_now()),
        )
        adjust_warehouse_stock(
            conn, wh, body.product_id, 1, "inbound",
            notes=f"IMEI: {imei or serial}",
        )
        conn.execute("UPDATE products SET track_units = 1 WHERE id = ?", (body.product_id,))
        row = conn.execute(
            """
            SELECT u.*, p.name AS product_name, w.name AS warehouse_name
            FROM product_units u
            JOIN products p ON p.id = u.product_id
            JOIN warehouses w ON w.id = u.warehouse_id
            WHERE u.id = ?
            """,
            (cur.lastrowid,),
        ).fetchone()
    return row_to_dict(row)


@app.delete("/api/units/{unit_id}")
async def delete_unit(unit_id: int, x_pin: str | None = Header(default=None, alias="X-Pin")):
    check_pin(x_pin, min_role="warehouse")
    with db() as conn:
        unit = conn.execute(
            "SELECT * FROM product_units WHERE id = ? AND status = 'in_stock'", (unit_id,)
        ).fetchone()
        if not unit:
            raise HTTPException(status_code=404, detail="Единица не найдена или уже продана")
        conn.execute("DELETE FROM product_units WHERE id = ?", (unit_id,))
        adjust_warehouse_stock(
            conn, unit["warehouse_id"], unit["product_id"], -1,
            "outbound", notes=f"Удаление IMEI #{unit_id}",
        )
    return {"ok": True}


@app.get("/api/products/{product_id}/units")
async def product_units(
    product_id: int,
    warehouse_id: int | None = None,
    status: str = "in_stock",
    x_pin: str | None = Header(default=None, alias="X-Pin"),
):
    check_pin(x_pin)
    return await list_units(
        product_id=product_id, warehouse_id=warehouse_id, status=status, q="", x_pin=x_pin
    )


# --- Warehouses ---


@app.get("/api/warehouses")
async def list_warehouses(x_pin: str | None = Header(default=None, alias="X-Pin")):
    check_pin(x_pin)
    with db() as conn:
        rows = conn.execute(
            "SELECT * FROM warehouses ORDER BY is_default DESC, name"
        ).fetchall()
    return [row_to_dict(r) for r in rows]


@app.post("/api/warehouses")
async def create_warehouse(body: WarehouseIn, x_pin: str | None = Header(default=None, alias="X-Pin")):
    check_pin(x_pin)
    with db() as conn:
        if body.is_default:
            conn.execute("UPDATE warehouses SET is_default = 0")
        cur = conn.execute(
            """
            INSERT INTO warehouses (name, address, notes, is_default, created_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (body.name.strip(), body.address, body.notes, int(body.is_default), utc_now()),
        )
        row = conn.execute("SELECT * FROM warehouses WHERE id = ?", (cur.lastrowid,)).fetchone()
    return row_to_dict(row)


@app.put("/api/warehouses/{warehouse_id}")
async def update_warehouse(
    warehouse_id: int,
    body: WarehouseUpdate,
    x_pin: str | None = Header(default=None, alias="X-Pin"),
):
    check_pin(x_pin)
    fields = {k: v for k, v in body.model_dump().items() if v is not None}
    if not fields:
        raise HTTPException(status_code=400, detail="Нет данных для обновления")
    if "is_default" in fields:
        fields["is_default"] = int(fields["is_default"])
    with db() as conn:
        if not conn.execute("SELECT id FROM warehouses WHERE id = ?", (warehouse_id,)).fetchone():
            raise HTTPException(status_code=404, detail="Склад не найден")
        if fields.get("is_default"):
            conn.execute("UPDATE warehouses SET is_default = 0")
        sets = ", ".join(f"{k} = ?" for k in fields)
        conn.execute(f"UPDATE warehouses SET {sets} WHERE id = ?", (*fields.values(), warehouse_id))
        row = conn.execute("SELECT * FROM warehouses WHERE id = ?", (warehouse_id,)).fetchone()
    return row_to_dict(row)


@app.delete("/api/warehouses/{warehouse_id}")
async def delete_warehouse(warehouse_id: int, x_pin: str | None = Header(default=None, alias="X-Pin")):
    check_pin(x_pin, min_role="owner")
    with db() as conn:
        wh = conn.execute("SELECT * FROM warehouses WHERE id = ?", (warehouse_id,)).fetchone()
        if not wh:
            raise HTTPException(status_code=404, detail="Склад не найден")
        if wh["is_default"]:
            raise HTTPException(status_code=400, detail="Нельзя удалить склад по умолчанию")
        stock_count = conn.execute(
            "SELECT COUNT(*) FROM warehouse_stock WHERE warehouse_id = ? AND quantity > 0",
            (warehouse_id,),
        ).fetchone()[0]
        if stock_count > 0:
            raise HTTPException(status_code=400, detail="На складе есть остатки — сначала переместите товар")
        conn.execute("DELETE FROM warehouses WHERE id = ?", (warehouse_id,))
    return {"ok": True}


@app.get("/api/warehouses/{warehouse_id}/stock")
async def warehouse_stock(warehouse_id: int, x_pin: str | None = Header(default=None, alias="X-Pin")):
    check_pin(x_pin)
    with db() as conn:
        if not conn.execute("SELECT id FROM warehouses WHERE id = ?", (warehouse_id,)).fetchone():
            raise HTTPException(status_code=404, detail="Склад не найден")
        rows = conn.execute(
            """
            SELECT p.*, ws.quantity AS warehouse_quantity
            FROM warehouse_stock ws
            JOIN products p ON p.id = ws.product_id
            WHERE ws.warehouse_id = ? AND ws.quantity > 0
            ORDER BY p.name
            """,
            (warehouse_id,),
        ).fetchall()
        result = []
        for r in rows:
            item = enrich_product(conn, r)
            item["warehouse_quantity"] = r["warehouse_quantity"]
            result.append(item)
    return result


@app.get("/api/stock/total")
async def stock_total(x_pin: str | None = Header(default=None, alias="X-Pin")):
    check_pin(x_pin)
    with db() as conn:
        rows = conn.execute(
            """
            SELECT p.id, p.name, p.sku, p.barcode, p.category, p.brand,
                   COALESCE(SUM(ws.quantity), 0) AS total_stock
            FROM products p
            LEFT JOIN warehouse_stock ws ON ws.product_id = p.id
            GROUP BY p.id
            HAVING total_stock > 0
            ORDER BY p.name
            """
        ).fetchall()
        enriched = []
        for r in rows:
            product = conn.execute("SELECT * FROM products WHERE id = ?", (r["id"],)).fetchone()
            if product:
                enriched.append(enrich_product(conn, product))
    return enriched


@app.post("/api/stock/inbound")
async def stock_inbound(body: StockMovementIn, x_pin: str | None = Header(default=None, alias="X-Pin")):
    check_pin(x_pin)
    with db() as conn:
        if not conn.execute("SELECT id FROM products WHERE id = ?", (body.product_id,)).fetchone():
            raise HTTPException(status_code=404, detail="Товар не найден")
        resolve_warehouse_id(conn, body.warehouse_id)
        adjust_warehouse_stock(
            conn, body.warehouse_id, body.product_id, body.quantity,
            "inbound", notes=body.notes or "Приход на склад",
        )
        product = conn.execute("SELECT * FROM products WHERE id = ?", (body.product_id,)).fetchone()
        return enrich_product(conn, product) if product else {"ok": True}


@app.post("/api/stock/outbound")
async def stock_outbound(body: StockMovementIn, x_pin: str | None = Header(default=None, alias="X-Pin")):
    check_pin(x_pin)
    with db() as conn:
        if not conn.execute("SELECT id FROM products WHERE id = ?", (body.product_id,)).fetchone():
            raise HTTPException(status_code=404, detail="Товар не найден")
        resolve_warehouse_id(conn, body.warehouse_id)
        adjust_warehouse_stock(
            conn, body.warehouse_id, body.product_id, -body.quantity,
            "outbound", notes=body.notes or "Расход со склада",
        )
        product = conn.execute("SELECT * FROM products WHERE id = ?", (body.product_id,)).fetchone()
        return enrich_product(conn, product) if product else {"ok": True}


def _build_transfer_document(
    conn: sqlite3.Connection,
    movement_id: int,
    body: StockTransferIn,
    created_at: str,
) -> dict[str, Any]:
    product = conn.execute("SELECT * FROM products WHERE id = ?", (body.product_id,)).fetchone()
    from_wh = conn.execute("SELECT * FROM warehouses WHERE id = ?", (body.from_warehouse_id,)).fetchone()
    to_wh = conn.execute("SELECT * FROM warehouses WHERE id = ?", (body.to_warehouse_id,)).fetchone()
    return {
        "id": movement_id,
        "created_at": created_at,
        "from_warehouse_id": body.from_warehouse_id,
        "from_warehouse_name": from_wh["name"] if from_wh else "",
        "from_warehouse_address": from_wh["address"] if from_wh else "",
        "to_warehouse_id": body.to_warehouse_id,
        "to_warehouse_name": to_wh["name"] if to_wh else "",
        "to_warehouse_address": to_wh["address"] if to_wh else "",
        "product_id": body.product_id,
        "product_name": product["name"] if product else "",
        "product_model": product["model"] if product else "",
        "product_color": product["color"] if product else "",
        "product_memory": product["memory"] if product else "",
        "product_sku": product["sku"] if product else "",
        "quantity": body.quantity,
        "notes": body.notes or "",
    }


@app.get("/api/stock/movements")
async def list_stock_movements(
    warehouse_id: int | None = None,
    movement_type: str = "",
    limit: int = Query(default=50, ge=1, le=200),
    x_pin: str | None = Header(default=None, alias="X-Pin"),
):
    check_pin(x_pin)
    sql = """
        SELECT m.*,
               p.name AS product_name, p.model AS product_model, p.sku AS product_sku,
               w.name AS warehouse_name,
               tw.name AS target_warehouse_name
        FROM stock_movements m
        JOIN products p ON p.id = m.product_id
        JOIN warehouses w ON w.id = m.warehouse_id
        LEFT JOIN warehouses tw ON tw.id = m.target_warehouse_id
        WHERE 1=1
    """
    params: list[Any] = []
    if warehouse_id is not None:
        sql += " AND (m.warehouse_id = ? OR m.target_warehouse_id = ?)"
        params.extend([warehouse_id, warehouse_id])
    if movement_type:
        sql += " AND m.movement_type = ?"
        params.append(movement_type)
    sql += " ORDER BY m.created_at DESC LIMIT ?"
    params.append(limit)
    with db() as conn:
        rows = conn.execute(sql, params).fetchall()
    return [row_to_dict(r) for r in rows]


@app.get("/api/stock/transfers/{movement_id}/document")
async def get_transfer_document(movement_id: int, x_pin: str | None = Header(default=None, alias="X-Pin")):
    check_pin(x_pin)
    with db() as conn:
        m = conn.execute(
            """
            SELECT m.*, p.name AS product_name, p.model AS product_model,
                   p.color AS product_color, p.memory AS product_memory, p.sku AS product_sku,
                   w.name AS from_warehouse_name, w.address AS from_warehouse_address,
                   tw.name AS to_warehouse_name, tw.address AS to_warehouse_address
            FROM stock_movements m
            JOIN products p ON p.id = m.product_id
            JOIN warehouses w ON w.id = m.warehouse_id
            LEFT JOIN warehouses tw ON tw.id = m.target_warehouse_id
            WHERE m.id = ? AND m.movement_type = 'transfer_out'
            """,
            (movement_id,),
        ).fetchone()
        if not m:
            raise HTTPException(status_code=404, detail="Накладная не найдена")
    return {
        "id": m["id"],
        "created_at": m["created_at"],
        "from_warehouse_id": m["warehouse_id"],
        "from_warehouse_name": m["from_warehouse_name"],
        "from_warehouse_address": m["from_warehouse_address"] or "",
        "to_warehouse_id": m["target_warehouse_id"],
        "to_warehouse_name": m["to_warehouse_name"] or "",
        "to_warehouse_address": m["to_warehouse_address"] or "",
        "product_id": m["product_id"],
        "product_name": m["product_name"],
        "product_model": m["product_model"] or "",
        "product_color": m["product_color"] or "",
        "product_memory": m["product_memory"] or "",
        "product_sku": m["product_sku"] or "",
        "quantity": m["quantity"],
        "notes": m["notes"] or "",
    }


@app.post("/api/stock/transfer")
async def stock_transfer(body: StockTransferIn, x_pin: str | None = Header(default=None, alias="X-Pin")):
    check_pin(x_pin)
    if body.from_warehouse_id == body.to_warehouse_id:
        raise HTTPException(status_code=400, detail="Склады отправления и назначения совпадают")
    with db() as conn:
        if not conn.execute("SELECT id FROM products WHERE id = ?", (body.product_id,)).fetchone():
            raise HTTPException(status_code=404, detail="Товар не найден")
        resolve_warehouse_id(conn, body.from_warehouse_id)
        resolve_warehouse_id(conn, body.to_warehouse_id)
        now = utc_now()
        notes = body.notes or "Перемещение между складами"
        _, movement_id = adjust_warehouse_stock(
            conn, body.from_warehouse_id, body.product_id, -body.quantity,
            "transfer_out", target_warehouse_id=body.to_warehouse_id, notes=notes,
        )
        adjust_warehouse_stock(
            conn, body.to_warehouse_id, body.product_id, body.quantity,
            "transfer_in", target_warehouse_id=body.from_warehouse_id, notes=notes,
        )
        document = _build_transfer_document(conn, movement_id or 0, body, now)
        product = conn.execute("SELECT * FROM products WHERE id = ?", (body.product_id,)).fetchone()
        result = enrich_product(conn, product) if product else {"ok": True}
        if isinstance(result, dict):
            result["transfer_document"] = document
        else:
            result = {"ok": True, "transfer_document": document}
        return result


# --- Products ---


@app.get("/api/products")
async def list_products(
    q: str = "",
    category: str = "",
    ownership_type: str = "",
    supplier: str = "",
    warehouse_id: int | None = None,
    low_stock: bool = False,
    x_pin: str | None = Header(default=None, alias="X-Pin"),
):
    check_pin(x_pin)
    sql = "SELECT p.* FROM products p WHERE 1=1"
    params: list[Any] = []
    if warehouse_id is not None:
        sql += """
            AND EXISTS (
                SELECT 1 FROM warehouse_stock ws
                WHERE ws.product_id = p.id AND ws.warehouse_id = ? AND ws.quantity > 0
            )
        """
        params.append(warehouse_id)
    if q:
        sql += """
            AND (p.name LIKE ? OR p.brand LIKE ? OR p.sku LIKE ? OR p.barcode LIKE ?
                 OR p.supplier_name LIKE ? OR p.model LIKE ? OR p.color LIKE ? OR p.memory LIKE ?)
        """
        like = f"%{q}%"
        params.extend([like] * 8)
    if category:
        sql += " AND p.category = ?"
        params.append(category)
    if ownership_type:
        sql += " AND p.ownership_type = ?"
        params.append(ownership_type)
    if supplier:
        sql += " AND p.supplier_name LIKE ?"
        params.append(f"%{supplier}%")
    if low_stock:
        sql += " AND p.stock <= p.min_stock"
    sql += " ORDER BY p.ownership_type, p.name"
    with db() as conn:
        rows = conn.execute(sql, params).fetchall()
        return [enrich_product(conn, r) for r in rows]


@app.get("/api/suppliers")
async def list_suppliers(x_pin: str | None = Header(default=None, alias="X-Pin")):
    check_pin(x_pin)
    with db() as conn:
        rows = conn.execute(
            """
            SELECT p.supplier_name,
                   COUNT(DISTINCT p.id) AS products_count,
                   COALESCE(SUM(ws.quantity), 0) AS total_stock,
                   COALESCE(SUM(p.purchase_price * ws.quantity), 0) AS stock_value
            FROM products p
            LEFT JOIN warehouse_stock ws ON ws.product_id = p.id
            WHERE p.ownership_type = 'consignment' AND p.supplier_name != ''
            GROUP BY p.supplier_name
            ORDER BY p.supplier_name
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
        wh_id = resolve_warehouse_id(conn, body.warehouse_id)
        track = body.track_units if body.track_units is not None else (1 if body.category == "phone" else 0)
        cur = conn.execute(
            """
            INSERT INTO products
            (name, category, ownership_type, supplier_name, brand, sku, barcode,
             purchase_price, sale_price, stock, min_stock, created_at,
             model, color, size, memory, ram, customs_cleared, customs_price, specs_extra, condition, track_units, image_url)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?,
                    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                body.name, body.category, body.ownership_type, body.supplier_name.strip(),
                body.brand, body.sku, body.barcode, body.purchase_price, body.sale_price,
                body.min_stock, utc_now(),
                body.model, body.color, body.size, body.memory, body.ram,
                body.customs_cleared, body.customs_price, body.specs_extra, body.condition, track,
                body.image_url.strip(),
            ),
        )
        product_id = cur.lastrowid
        if body.stock > 0:
            adjust_warehouse_stock(
                conn, wh_id, product_id, body.stock,
                "inbound", notes="Начальный остаток при создании товара",
            )
        else:
            sync_product_stock(conn, product_id)
        row = conn.execute("SELECT * FROM products WHERE id = ?", (product_id,)).fetchone()
        return enrich_product(conn, row)


@app.put("/api/products/{product_id}")
async def update_product(product_id: int, body: ProductUpdate, x_pin: str | None = Header(default=None, alias="X-Pin")):
    check_pin(x_pin)
    fields = {k: v for k, v in body.model_dump().items() if v is not None and k != "warehouse_id"}
    warehouse_id = body.warehouse_id
    stock_update = fields.pop("stock", None)
    if not fields and stock_update is None:
        raise HTTPException(status_code=400, detail="Нет данных для обновления")
    if fields.get("ownership_type") == "consignment" and not (fields.get("supplier_name") or "").strip():
        with db() as conn:
            existing = conn.execute("SELECT supplier_name FROM products WHERE id = ?", (product_id,)).fetchone()
            if not existing or not existing["supplier_name"]:
                raise HTTPException(status_code=400, detail="Укажите поставщика")
    with db() as conn:
        if not conn.execute("SELECT id FROM products WHERE id = ?", (product_id,)).fetchone():
            raise HTTPException(status_code=404, detail="Товар не найден")
        if fields:
            sets = ", ".join(f"{k} = ?" for k in fields)
            conn.execute(f"UPDATE products SET {sets} WHERE id = ?", (*fields.values(), product_id))
        if stock_update is not None:
            wh_id = resolve_warehouse_id(conn, warehouse_id)
            current = get_warehouse_stock(conn, wh_id, product_id)
            delta = stock_update - current
            if delta != 0:
                adjust_warehouse_stock(
                    conn, wh_id, product_id, delta,
                    "inbound" if delta > 0 else "outbound",
                    notes="Корректировка остатка через карточку товара",
                )
            else:
                sync_product_stock(conn, product_id)
        row = conn.execute("SELECT * FROM products WHERE id = ?", (product_id,)).fetchone()
        return enrich_product(conn, row)


@app.delete("/api/products/{product_id}")
async def delete_product(product_id: int, x_pin: str | None = Header(default=None, alias="X-Pin")):
    check_pin(x_pin, min_role="owner")
    with db() as conn:
        row = conn.execute("SELECT image_url FROM products WHERE id = ?", (product_id,)).fetchone()
        cur = conn.execute("DELETE FROM products WHERE id = ?", (product_id,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Товар не найден")
        if row and row["image_url"] and row["image_url"].startswith("/uploads/"):
            path = UPLOADS_DIR / Path(row["image_url"]).name
            if path.exists():
                path.unlink(missing_ok=True)
    return {"ok": True}


def _remove_product_images(product_id: int) -> None:
    for path in UPLOADS_DIR.glob(f"product_{product_id}.*"):
        path.unlink(missing_ok=True)


@app.post("/api/products/{product_id}/image")
async def upload_product_image(
    product_id: int,
    file: UploadFile = File(...),
    x_pin: str | None = Header(default=None, alias="X-Pin"),
):
    check_pin(x_pin, min_role="warehouse")
    if not file.filename:
        raise HTTPException(status_code=400, detail="Файл не выбран")
    ext = Path(file.filename).suffix.lower()
    if ext not in ALLOWED_IMAGE_EXT:
        raise HTTPException(status_code=400, detail="Допустимы JPG, PNG, WEBP, GIF")
    data = await file.read()
    if len(data) > MAX_IMAGE_BYTES:
        raise HTTPException(status_code=400, detail="Максимальный размер файла — 5 МБ")
    with db() as conn:
        if not conn.execute("SELECT id FROM products WHERE id = ?", (product_id,)).fetchone():
            raise HTTPException(status_code=404, detail="Товар не найден")
    _remove_product_images(product_id)
    filename = f"product_{product_id}{ext}"
    (UPLOADS_DIR / filename).write_bytes(data)
    image_url = f"/uploads/{filename}"
    with db() as conn:
        conn.execute("UPDATE products SET image_url = ? WHERE id = ?", (image_url, product_id))
        row = conn.execute("SELECT * FROM products WHERE id = ?", (product_id,)).fetchone()
        return enrich_product(conn, row)


@app.delete("/api/products/{product_id}/image")
async def delete_product_image(product_id: int, x_pin: str | None = Header(default=None, alias="X-Pin")):
    check_pin(x_pin, min_role="warehouse")
    with db() as conn:
        if not conn.execute("SELECT id FROM products WHERE id = ?", (product_id,)).fetchone():
            raise HTTPException(status_code=404, detail="Товар не найден")
        conn.execute("UPDATE products SET image_url = '' WHERE id = ?", (product_id,))
    _remove_product_images(product_id)
    return {"ok": True}


@app.get("/api/products/{product_id}")
async def get_product(product_id: int, x_pin: str | None = Header(default=None, alias="X-Pin")):
    check_pin(x_pin)
    with db() as conn:
        row = conn.execute("SELECT * FROM products WHERE id = ?", (product_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Товар не найден")
        return enrich_product(conn, row)


# --- Sales ---


@app.post("/api/sales")
async def create_sale(body: SaleIn, x_pin: str | None = Header(default=None, alias="X-Pin")):
    check_pin(x_pin)
    if not body.items:
        raise HTTPException(status_code=400, detail="Корзина пуста")

    with db() as conn:
        warehouse_id = resolve_warehouse_id(conn, body.warehouse_id)
        shift = get_open_shift(conn)
        shift_id = body.shift_id or (shift["id"] if shift else None)
        if shift_id is None:
            raise HTTPException(status_code=400, detail="Сначала откройте смену (раздел «Смена»)")

        subtotal = 0.0
        lines: list[dict[str, Any]] = []
        for item in body.items:
            product = conn.execute("SELECT * FROM products WHERE id = ?", (item.product_id,)).fetchone()
            if not product:
                raise HTTPException(status_code=404, detail=f"Товар #{item.product_id} не найден")
            if int(product["track_units"] or 0):
                avail = conn.execute(
                    """
                    SELECT COUNT(*) FROM product_units
                    WHERE product_id = ? AND warehouse_id = ? AND status = 'in_stock'
                    """,
                    (item.product_id, warehouse_id),
                ).fetchone()[0]
                if avail < item.quantity:
                    raise HTTPException(
                        status_code=400,
                        detail=f"«{product['name']}»: нужны IMEI — доступно {avail} из {item.quantity}",
                    )
            else:
                wh_stock = get_warehouse_stock(conn, warehouse_id, item.product_id)
                if wh_stock < item.quantity:
                    raise HTTPException(
                        status_code=400,
                        detail=f"Недостаточно «{product['name']}» на складе: доступно {wh_stock}",
                    )
            calc = calc_line(product, item.quantity)
            subtotal += calc["subtotal"]
            lines.append({"product": product, "qty": item.quantity, "unit_ids": item.unit_ids, **calc})

        total = max(0.0, subtotal - body.discount)
        now = utc_now()
        cash_amount = total if body.payment_method == "cash" else 0.0
        card_amount = total if body.payment_method in ("card", "transfer") else 0.0
        cur = conn.execute(
            """
            INSERT INTO sales
            (total, discount, payment_method, status, notes, created_at,
             warehouse_id, cash_amount, card_amount, trade_in_value, shift_id)
            VALUES (?, ?, ?, 'completed', ?, ?, ?, ?, ?, 0, ?)
            """,
            (total, body.discount, body.payment_method, body.notes, now,
             warehouse_id, cash_amount, card_amount, shift_id),
        )
        sale_id = cur.lastrowid
        for line in lines:
            p = line["product"]
            cur_item = conn.execute(
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
            sale_item_id = cur_item.lastrowid
            if int(p["track_units"] or 0):
                units = pick_units(conn, p["id"], warehouse_id, line["qty"], line["unit_ids"] or None)
                for u in units:
                    conn.execute(
                        """
                        INSERT INTO sale_item_units (sale_item_id, unit_id, imei, serial)
                        VALUES (?, ?, ?, ?)
                        """,
                        (sale_item_id, u["id"], u["imei"] or "", u["serial"] or ""),
                    )
                mark_units_sold(conn, units, sale_id)
            adjust_warehouse_stock(
                conn, warehouse_id, p["id"], -line["qty"],
                "sale", reference_id=sale_id, notes=f"Продажа #{sale_id}",
            )

        sale = conn.execute("SELECT * FROM sales WHERE id = ?", (sale_id,)).fetchone()
        items = conn.execute("SELECT * FROM sale_items WHERE sale_id = ?", (sale_id,)).fetchall()
        result = row_to_dict(sale)
        result["items"] = enrich_sale_items(conn, items)
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
        result["items"] = enrich_sale_items(conn, items)
    return result


@app.post("/api/sales/{sale_id}/void")
async def void_sale(sale_id: int, x_pin: str | None = Header(default=None, alias="X-Pin")):
    check_pin(x_pin, min_role="owner")
    with db() as conn:
        sale = conn.execute("SELECT * FROM sales WHERE id = ? AND status = 'completed'", (sale_id,)).fetchone()
        if not sale:
            raise HTTPException(status_code=404, detail="Продажа не найдена")
        warehouse_id = sale["warehouse_id"] or get_default_warehouse_id(conn)
        restore_units_for_sale(conn, sale_id)
        for item in conn.execute("SELECT * FROM sale_items WHERE sale_id = ?", (sale_id,)).fetchall():
            if item["product_id"]:
                adjust_warehouse_stock(
                    conn, warehouse_id, item["product_id"], item["quantity"],
                    "void", reference_id=sale_id, notes=f"Отмена продажи #{sale_id}",
                )
        conn.execute("UPDATE sales SET status = 'voided' WHERE id = ?", (sale_id,))
    return {"ok": True}


# --- Trade-in ---


@app.get("/api/trade-ins")
async def list_trade_ins(
    limit: int = Query(default=50, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    x_pin: str | None = Header(default=None, alias="X-Pin"),
):
    check_pin(x_pin)
    with db() as conn:
        rows = conn.execute(
            """
            SELECT t.*,
                   gp.name AS given_product_name,
                   rp.name AS received_product_name,
                   gw.name AS given_warehouse_name,
                   rw.name AS received_warehouse_name
            FROM trade_ins t
            LEFT JOIN products gp ON gp.id = t.given_product_id
            LEFT JOIN products rp ON rp.id = t.received_product_id
            LEFT JOIN warehouses gw ON gw.id = t.given_warehouse_id
            LEFT JOIN warehouses rw ON rw.id = t.received_warehouse_id
            ORDER BY t.created_at DESC
            LIMIT ? OFFSET ?
            """,
            (limit, offset),
        ).fetchall()
        total = conn.execute("SELECT COUNT(*) FROM trade_ins").fetchone()[0]
    return {"items": [row_to_dict(r) for r in rows], "total": total}


@app.post("/api/trade-ins")
async def create_trade_in(body: TradeInIn, x_pin: str | None = Header(default=None, alias="X-Pin")):
    check_pin(x_pin)
    with db() as conn:
        given_product = conn.execute(
            "SELECT * FROM products WHERE id = ?", (body.given_product_id,)
        ).fetchone()
        if not given_product:
            raise HTTPException(status_code=404, detail="Выдаваемый товар не найден")
        given_wh = resolve_warehouse_id(conn, body.given_warehouse_id)
        received_wh = resolve_warehouse_id(conn, body.received_warehouse_id)
        wh_stock = get_warehouse_stock(conn, given_wh, body.given_product_id)
        if wh_stock < 1:
            raise HTTPException(
                status_code=400,
                detail=f"Недостаточно «{given_product['name']}» на складе: доступно {wh_stock}",
            )

        calc = calc_line(given_product, 1)
        subtotal = calc["subtotal"]
        total = max(0.0, subtotal)
        paid = body.cash_amount + body.card_amount + body.received_value
        if abs(paid - total) > 0.01:
            raise HTTPException(
                status_code=400,
                detail=f"Сумма оплаты ({paid:.2f}) не совпадает с ценой товара ({total:.2f})",
            )

        shift = get_open_shift(conn)
        if not shift:
            raise HTTPException(status_code=400, detail="Сначала откройте смену")

        now = utc_now()
        cur = conn.execute(
            """
            INSERT INTO sales
            (total, discount, payment_method, status, notes, created_at,
             warehouse_id, cash_amount, card_amount, trade_in_value, shift_id)
            VALUES (?, 0, 'trade_in', 'completed', ?, ?, ?, ?, ?, ?, ?)
            """,
            (total, body.notes or "Обмен (trade-in)", now,
             given_wh, body.cash_amount, body.card_amount, body.received_value, shift["id"]),
        )
        sale_id = cur.lastrowid

        cur_item = conn.execute(
            """
            INSERT INTO sale_items
            (sale_id, product_id, product_name, ownership_type, supplier_name, quantity,
             unit_price, purchase_price, supplier_due, shop_profit, subtotal)
            VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
            """,
            (
                sale_id, given_product["id"], given_product["name"],
                calc["ownership_type"], calc["supplier_name"],
                calc["unit_price"], calc["purchase_price"],
                calc["supplier_due"], calc["shop_profit"], calc["subtotal"],
            ),
        )
        sale_item_id = cur_item.lastrowid
        if int(given_product["track_units"] or 0):
            units = pick_units(
                conn, given_product["id"], given_wh, 1,
                [body.given_unit_id] if body.given_unit_id else None,
            )
            for u in units:
                conn.execute(
                    "INSERT INTO sale_item_units (sale_item_id, unit_id, imei, serial) VALUES (?, ?, ?, ?)",
                    (sale_item_id, u["id"], u["imei"] or "", u["serial"] or ""),
                )
            mark_units_sold(conn, units, sale_id)

        adjust_warehouse_stock(
            conn, given_wh, body.given_product_id, -1,
            "trade_in_given", reference_id=sale_id, notes="Trade-in: выдача товара клиенту",
        )

        recv_cur = conn.execute(
            """
            INSERT INTO products
            (name, category, ownership_type, supplier_name, brand, sku, barcode,
             purchase_price, sale_price, stock, min_stock, created_at,
             model, color, size, memory, ram, customs_cleared, customs_price, specs_extra, condition, track_units)
            VALUES (?, 'phone', 'own', '', ?, '', '', ?, ?, 0, 1, ?,
                    ?, ?, ?, ?, ?, 0, 0, ?, ?, 1)
            """,
            (
                body.received_name, body.received_brand, body.received_purchase_price,
                body.received_sale_price, now,
                body.received_model, body.received_color, body.received_size,
                body.received_memory, body.received_ram, body.received_specs_extra,
                body.received_condition,
            ),
        )
        received_product_id = recv_cur.lastrowid

        if body.received_imei.strip() or body.received_serial.strip():
            conn.execute(
                """
                INSERT INTO product_units
                (product_id, warehouse_id, imei, serial, status, notes, created_at)
                VALUES (?, ?, ?, ?, 'in_stock', 'Trade-in', ?)
                """,
                (
                    received_product_id, received_wh,
                    body.received_imei.strip(), body.received_serial.strip(), now,
                ),
            )
        adjust_warehouse_stock(
            conn, received_wh, received_product_id, 1,
            "trade_in_received", reference_id=sale_id,
            notes="Trade-in: принят устройство от клиента",
        )

        ti_cur = conn.execute(
            """
            INSERT INTO trade_ins
            (given_product_id, given_warehouse_id,
             received_name, received_brand, received_model, received_color,
             received_size, received_memory, received_ram, received_specs_extra,
             received_condition, received_purchase_price, received_sale_price,
             received_value, cash_amount, card_amount,
             received_product_id, received_warehouse_id, sale_id, notes, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                body.given_product_id, given_wh,
                body.received_name, body.received_brand, body.received_model, body.received_color,
                body.received_size, body.received_memory, body.received_ram, body.received_specs_extra,
                body.received_condition, body.received_purchase_price, body.received_sale_price,
                body.received_value, body.cash_amount, body.card_amount,
                received_product_id, received_wh, sale_id, body.notes, now,
            ),
        )

        row = conn.execute(
            """
            SELECT t.*,
                   gp.name AS given_product_name,
                   rp.name AS received_product_name,
                   gw.name AS given_warehouse_name,
                   rw.name AS received_warehouse_name
            FROM trade_ins t
            LEFT JOIN products gp ON gp.id = t.given_product_id
            LEFT JOIN products rp ON rp.id = t.received_product_id
            LEFT JOIN warehouses gw ON gw.id = t.given_warehouse_id
            LEFT JOIN warehouses rw ON rw.id = t.received_warehouse_id
            WHERE t.id = ?
            """,
            (ti_cur.lastrowid,),
        ).fetchone()
    return row_to_dict(row)


# --- Supplier payments ---


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

    payment_totals = conn.execute(
        f"""
        SELECT
            COALESCE(SUM(
                CASE WHEN s.payment_method = 'cash' THEN s.total
                     ELSE s.cash_amount END
            ), 0) AS total_cash,
            COALESCE(SUM(
                CASE WHEN s.payment_method = 'card' THEN s.total
                     ELSE s.card_amount END
            ), 0) AS total_card,
            COALESCE(SUM(s.trade_in_value), 0) AS total_trade_in
        FROM sales s
        WHERE s.status = 'completed' {since_clause.replace('s.created_at', 's.created_at') if since_clause else ''}
        """,
        params,
    ).fetchone()

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
        "total_cash": float(payment_totals["total_cash"]),
        "total_card": float(payment_totals["total_card"]),
        "total_trade_in": float(payment_totals["total_trade_in"]),
        "by_payment": [
            {"method": r["payment_method"], "count": r["cnt"], "amount": float(r["amount"])}
            for r in payment_rows
        ],
    }


@app.get("/api/reports/trade-ins")
async def trade_ins_report(
    period: str = Query(default="month", pattern="^(day|week|month|quarter|year|all)$"),
    date_from: str = "",
    date_to: str = "",
    x_pin: str | None = Header(default=None, alias="X-Pin"),
):
    check_pin(x_pin)
    with db() as conn:
        if date_from or date_to:
            since_clause, params = date_filter_sql(date_from, date_to, "t.created_at")
            period_label = f"{date_from or '…'} — {date_to or '…'}"
        elif period == "all":
            since_clause, params = "", []
            period_label = "Всё время"
        else:
            since_clause = " AND t.created_at >= ?"
            params = [period_start(period)]
            period_label = {
                "day": "Сегодня", "week": "Неделя", "month": "Месяц",
                "quarter": "Квартал", "year": "Год",
            }.get(period, period)

        agg = conn.execute(
            f"""
            SELECT COUNT(*) AS deals_count,
                   COALESCE(SUM(t.received_value), 0) AS total_trade_credit,
                   COALESCE(SUM(t.cash_amount), 0) AS total_cash,
                   COALESCE(SUM(t.card_amount), 0) AS total_card,
                   COALESCE(SUM(t.cash_amount + t.card_amount), 0) AS total_money,
                   COALESCE(SUM(t.cash_amount + t.card_amount + t.received_value), 0) AS total_deal_value
            FROM trade_ins t
            WHERE 1=1 {since_clause}
            """,
            params,
        ).fetchone()

        items = conn.execute(
            f"""
            SELECT t.*,
                   gp.name AS given_product_name, gp.sale_price AS given_sale_price,
                   rp.name AS received_product_name,
                   gw.name AS given_warehouse_name,
                   rw.name AS received_warehouse_name
            FROM trade_ins t
            LEFT JOIN products gp ON gp.id = t.given_product_id
            LEFT JOIN products rp ON rp.id = t.received_product_id
            LEFT JOIN warehouses gw ON gw.id = t.given_warehouse_id
            LEFT JOIN warehouses rw ON rw.id = t.received_warehouse_id
            WHERE 1=1 {since_clause}
            ORDER BY t.created_at DESC
            LIMIT 500
            """,
            params,
        ).fetchall()

        by_warehouse = conn.execute(
            f"""
            SELECT gw.name AS warehouse_name,
                   COUNT(*) AS deals,
                   COALESCE(SUM(t.cash_amount + t.card_amount), 0) AS money,
                   COALESCE(SUM(t.received_value), 0) AS trade_credit
            FROM trade_ins t
            JOIN warehouses gw ON gw.id = t.given_warehouse_id
            WHERE 1=1 {since_clause}
            GROUP BY gw.name
            ORDER BY deals DESC
            """,
            params,
        ).fetchall()

    return {
        "period": period,
        "period_label": period_label,
        "deals_count": agg["deals_count"],
        "total_trade_credit": float(agg["total_trade_credit"]),
        "total_cash": float(agg["total_cash"]),
        "total_card": float(agg["total_card"]),
        "total_money": float(agg["total_money"]),
        "total_deal_value": float(agg["total_deal_value"]),
        "items": [row_to_dict(i) for i in items],
        "by_warehouse": [row_to_dict(w) for w in by_warehouse],
    }


@app.get("/api/reports/finance")
async def finance_report(
    period: str = Query(default="month", pattern="^(day|week|month|quarter|year|all)$"),
    scope: ReportScope = "all",
    date_from: str = "",
    date_to: str = "",
    x_pin: str | None = Header(default=None, alias="X-Pin"),
):
    check_pin(x_pin, min_role="owner")
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
    check_pin(x_pin, min_role="owner")
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
    check_pin(x_pin, min_role="owner")
    with db() as conn:
        report = _finance_report(conn, period, scope, "", "")
        low_sql = "SELECT COUNT(*) FROM products WHERE stock <= min_stock"
        params: list[Any] = []
        if scope != "all":
            low_sql += " AND ownership_type = ?"
            params.append(scope)
        low_stock = conn.execute(low_sql, params).fetchone()[0]
        stock_sql = """
            SELECT COALESCE(SUM(p.purchase_price * ws.quantity), 0)
            FROM products p
            JOIN warehouse_stock ws ON ws.product_id = p.id
            WHERE 1=1
        """
        if scope != "all":
            stock_sql += " AND p.ownership_type = ?"
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
        "total_cash": report["total_cash"],
        "total_card": report["total_card"],
        "total_trade_in": report["total_trade_in"],
    }


@app.get("/api/analytics/top-products")
async def analytics_top(
    period: str = Query(default="month", pattern="^(day|week|month|quarter|year|all)$"),
    scope: ReportScope = "all",
    limit: int = Query(default=10, ge=1, le=50),
    x_pin: str | None = Header(default=None, alias="X-Pin"),
):
    check_pin(x_pin, min_role="owner")
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
    check_pin(x_pin, min_role="owner")
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
        warehouses = conn.execute(
            """
            SELECT w.id, w.name, w.is_default,
                   COALESCE(SUM(ws.quantity), 0) AS total_items,
                   COUNT(DISTINCT CASE WHEN ws.quantity > 0 THEN ws.product_id END) AS products_count
            FROM warehouses w
            LEFT JOIN warehouse_stock ws ON ws.warehouse_id = w.id
            GROUP BY w.id
            ORDER BY w.is_default DESC, w.name
            """
        ).fetchall()
    return {
        "today": today,
        "month": month,
        "own_month": own_month,
        "consignment_month": cons_month,
        "supplier_balances": balances,
        "low_stock_count": low_stock,
        "warehouses": [row_to_dict(w) for w in warehouses],
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app:app", host="0.0.0.0", port=settings.port, reload=False)
