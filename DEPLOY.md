# Деплой на Amvera — Магазин телефонов

Касса, учёт продаж и аналитика для магазина телефонов и аксессуаров.

**Сайт:** https://telephons-koujikin.amvera.io

---

## Быстрый деплой

### 1. Инициализация git (один раз)

```powershell
cd "C:\Users\nikit\OneDrive\Desktop\Магазин телефонов и акссесуаров"
git init
git remote add amvera https://git.amvera.ru/koujikin/telephons
```

### 2. Push на Amvera

**Через git** (если репозиторий доступен):

```powershell
git add .
git commit -m "Касса и аналитика магазина телефонов"
git push amvera main:master
```

**Через Amvera CLI** (если git push не работает):

```bash
amvera login -u YOUR_USER
git archive HEAD | tar -x -C /tmp/telephons-deploy
rm -rf /tmp/telephons-deploy/node_modules
printf 'yes\n' | amvera upload code --slug telephons --source /tmp/telephons-deploy --target /
amvera rebuild --slug telephons
```

Amvera автоматически соберёт приложение по `amvera.yml` и запустит на порту 80.

### 3. Переменные (опционально)

В панели Amvera → **Переменные**:

| Имя | Значение | Описание |
|-----|----------|----------|
| `STORE_PIN` | `1234` | PIN для входа (если пусто — без авторизации) |

---

## Локальный запуск

```powershell
cd "C:\Users\nikit\OneDrive\Desktop\Магазин телефонов и акссесуаров"
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
python app.py
```

Откройте http://localhost:80

База данных локально: папка `data/store.db`  
На Amvera: `/data/store.db` (постоянное хранилище)

---

## Возможности

| Раздел | Что умеет |
|--------|-----------|
| **Касса** | Поиск товаров, штрихкод (Enter), корзина, скидка, оплата наличные/карта/перевод, чек |
| **Продажи** | История чеков, просмотр состава, отмена (возврат на склад) |
| **Товары** | Добавление, редактирование, удаление, контроль остатков |
| **Аналитика** | Выручка, прибыль, маржа, топ товаров, график по дням, разбивка по категориям |

При первом запуске добавляются демо-товары (iPhone, Samsung, чехлы и т.д.) — их можно удалить или отредактировать.

---

## Troubleshooting

| Проблема | Решение |
|----------|---------|
| «Проект не развертывается» | Проверьте **Логи** в Amvera — обычно ошибка в `requirements.txt` или `app.py` |
| Данные пропали после перезапуска | Убедитесь, что в `amvera.yml` есть `persistenceMount: /data` |
| 401 Неверный PIN | Задайте `STORE_PIN` в переменных Amvera или очистите localStorage в браузере |
