# Agent: TeleStore ERP

Phone & accessories shop: POS, inventory, consignment, analytics.

**Stack:** FastAPI + SQLite monolith (`app.py`) + static SPA, Amvera deploy.

**UI:** по умолчанию **простой режим** (`SIMPLE_UI=1`) — касса, продажи, склад, отчёты. Расширенный ERP — в Настройках (владелец) или `SIMPLE_UI=0`.

**Run:** `pip install -r requirements.txt` → `python app.py` → http://localhost:80
