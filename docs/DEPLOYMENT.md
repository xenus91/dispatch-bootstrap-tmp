# Эксплуатация и деплой

Ежедневные операции с приложением на VPS. Установка с нуля — отдельно:
[`NEW-VPS-FROM-SCRATCH.md`](./NEW-VPS-FROM-SCRATCH.md).

---

## Архитектура

```
                    Интернет
                       │  80 (ACME) + 443
                       ▼
              ┌─────────────────┐
              │  caddy:2-alpine │  TLS автоматически, редирект www
              │  reverse_proxy  │
              └────────┬────────┘
                       │ внутренняя сеть docker
        ┌──────────────▼───────────────┐      ┌────────────────────────┐
        │  app (oven/bun:1.3.14)        │─────▶│  db (postgres:16)     │
        │  non-root, read-only fs       │      │  только во внутренней  │
        │  /api → Hono+oRPC             │      │  сети, порт наружу нет │
        │  /    → статика dist/         │      │  volume: pgdata        │
        │  планировщик в процессе       │      └────────────────────────┘
        └───────────────────────────────┘
```

| Файл | Назначение |
|---|---|
| `docker-compose.yml` | 4 сервиса: `caddy`, `db`, `migrate`, `app` |
| `Dockerfile` | Сборка: `deps` → `prod-deps` → `build` → `migrate` / `runner` |
| `Caddyfile` | Роутинг домена, авто-TLS, заголовки безопасности |
| `.env` | Все секреты. На VPS: `/opt/dispatch-containers/.env`, права `600` |
| `packages/web/drizzle/` | SQL-миграции (порядковая нумерация) |
| `packages/web/src/api/database/client.ts` | Единый пул соединений с PostgreSQL |
| `scripts/` | Бутстрап, бэкапы, сторож вебхука |

**Пул соединений:** в приложении ровно один пул на процесс (`client.ts`).
Не создавайте новые `pg.Pool` в других модулях — импортируйте `db` из
`../database`. Размер пула задаётся `DATABASE_POOL_MAX` (по умолчанию 10).

---

## Ежедневные операции

```bash
ssh root@<ip-сервера>
cd /opt/dispatch-containers
```

**Статус контейнеров:**

```bash
docker compose ps
```

Ожидаемое состояние: `db` — healthy, `migrate` — exited (0), `app` — healthy,
`caddy` — up.

**Логи:**

```bash
docker compose logs -f app              # следить за приложением
docker compose logs --tail=100 app      # последние 100 строк
docker compose logs --tail=100 db       # логи PostgreSQL
docker compose logs caddy | grep -i certificate
```

**Перезапуск:**

```bash
docker compose restart app              # мягкий рестарт
docker compose restart caddy            # перезапуск прокси
```

---

## Обновление версии

```bash
cd /opt/dispatch-containers
git fetch origin
git checkout main
git pull origin main

# Сборка идёт 3–5 минут, вывод теряется — пишем в лог
nohup docker compose build app > /tmp/build.log 2>&1 &
tail -f /tmp/build.log
```

Сборка завершилась — пересоздаём контейнер:

```bash
docker compose up -d --force-recreate app
```

> **`--force-recreate` обязателен.** Без него контейнер не пересоздастся: новый
> образ не подхватится, переменные окружения не обновятся, а панель будет
> работать на старом коде. Вариант `--no-recreate` — та же проблема.
>
> Ошибка вида «removal of container … is already in progress» — **не** ошибка
> сборки: Docker уже удаляет контейнер. Подождите и повторите `up -d`.

**Миграции** применятся сами: сервис `migrate` запускается перед `app`
(`depends_on: service_completed_successfully`).

**Откат:**

```bash
cd /opt/dispatch-containers
git log --oneline -5
git checkout <предыдущий-коммит>
docker compose build app && docker compose up -d --force-recreate app
```

> Если миграция изменила схему необратимо (удаление колонки), откат кода
> потребует отката схемы. Миграции в этом проекте только добавляющие, поэтому
> обычно достаточно отката кода.

---

## Бэкапы

Бэкап настраивается в cron (см. `NEW-VPS-FROM-SCRATCH.md`, шаг 6).

```bash
# разовый дамп
scripts/backup.sh

# список
ls -lh backups/

# восстановление
scripts/backup.sh restore backups/dispatch-20261104-033000.sql.gz
```

Дампы сжимаются, хранятся 7 дней, права `600`, каталог `backups` — `700`.
Каталог в `.gitignore` и в `.dockerignore` — в репозиторий и в образ он не
попадёт.

**Восстановление проверяйте.** Дамп, который ни разу не восстановили, ничем не
лучше отсутствия бэкапа. Инструкция — в `NEW-VPS-FROM-SCRATCH.md`, шаг 6.

---

## Ротация секретов

| Секрет | Где | Как ротировать |
|---|---|---|
| `MAX_WEBHOOK_SECRET` | `.env` | Заменить значение → `docker compose up -d --force-recreate app` → **переподписаться на вебхук** (панель или `POST /subscriptions`) |
| `CRON_SECRET` | `.env` | Заменить → пересоздать контейнер |
| `MAX_BOT_TOKEN` | `.env`, кабинет MAX | Заменить в кабинете MAX и в `.env` → пересоздать контейнер → переподписаться на вебхук |
| `POSTGRES_PASSWORD` | `.env` | `ALTER ROLE dispatch PASSWORD '...'` в БД → заменить в `.env` → пересоздать |

> При ротации `MAX_WEBHOOK_SECRET` старый секрет перестаёт совпадать с
> заголовком `X-Max-Bot-Api-Secret`, и MAX начнёт получать 401 на вебхук, пока
> подписка не пересоздана с новым секретом. Порядок: сначала переподписка с
> новым секретом, потом перезапуск приложения.

---

## Ограничение частоты запросов

Caddy из коробки не умеет ограничивать частоту запросов (нужен сторонний
плагин `caddy-ratelimit` и своя сборка образа). Сейчас ограничения сделаны на
уровне приложения:

- не более 5 попыток ввода кода подряд — блокировка на 15 минут;
- не более 1 запроса кода в минуту и не более 5 в час на номер;
- сигнал администраторам при блокировке.

Если клиенту нужен общий лимит на уровне прокси (например, защита от перебора
пароля админки), варианты:

1. Собрать Caddy с плагином `caddy-ratelimit` (требует замены образа в
   `docker-compose.yml`).
2. Поставить перед Caddy nginx с `limit_req`.

---

## Проверка состояния

```bash
# приложение отвечает
curl -s https://<домен>/api/health

# БД отвечает
docker compose exec -T db psql -U dispatch -d dispatch -c "SELECT count(*) FROM staff;"

# планировщик жив: в панели «Настройки» индикатор должен быть зелёным
docker compose exec -T db psql -U dispatch -d dispatch \
  -c "SELECT value FROM settings WHERE key='scheduler:heartbeat';"

# вебхук MAX на месте
set -a; . ./.env; set +a
curl -s -H "Authorization: $MAX_BOT_TOKEN" "$MAX_API_BASE_URL/subscriptions"
```

---

## Обслуживание

**Обновление образа после изменения в `.env`:**

```bash
docker compose up -d --force-recreate app
```

**Пересборка после изменения кода:**

```bash
docker compose build app
docker compose up -d --force-recreate app
```

**Сброс БД (полное удаление данных — необратимо):**

```bash
docker compose down
docker volume rm dispatch-containers_pgdata
docker compose up -d
```

Перед этим обязательно сделайте бэкап.

---

## Связанные документы

| Документ | О чём |
|---|---|
| [`NEW-VPS-FROM-SCRATCH.md`](./NEW-VPS-FROM-SCRATCH.md) | Установка с нуля |
| [`VPS-MIGRATION.md`](./VPS-MIGRATION.md) | Перенос на другой сервер |
| [`OPERATIONS.md`](./OPERATIONS.md) | Планировщик, тревоги, очистка данных |
| [`RUNBOOK.md`](./RUNBOOK.md) | Действия при сбоях |
| [`SECURITY.md`](./SECURITY.md) | Модель угроз и меры защиты |
| [`ADMIN.md`](./ADMIN.md) | Руководство администратора |
