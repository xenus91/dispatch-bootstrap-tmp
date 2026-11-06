# RUNBOOK: что делать при сбоях

Сценарии отсортированы по частоте. Для каждого — признак, причина и действия.

---

## 1. Бот MAX не отвечает водителю

**Признак:** водитель пишет в MAX, бот молчит. В панели заявка есть, но статус
не меняется.

**Диагностика:**

```bash
cd /opt/dispatch-containers
set -a; . ./.env; set +a

# токен вообще рабочий?
curl -s -H "Authorization: $MAX_BOT_TOKEN" "$MAX_API_BASE_URL/me"

# есть ли подписка на вебхук?
curl -s -H "Authorization: $MAX_BOT_TOKEN" "$MAX_API_BASE_URL/subscriptions"
```

**Действия:**

1. Нет подписки или в списке чужой URL → переподписаться:
   ```bash
   curl -s -X POST -H "Authorization: $MAX_BOT_TOKEN" -H "Content-Type: application/json" \
     -d "{\"url\":\"https://$DOMAIN/api/webhooks/max\",\"secret\":\"$MAX_WEBHOOK_SECRET\",\"update_types\":[\"message_created\",\"message_callback\",\"bot_started\",\"bot_stopped\",\"bot_added\",\"bot_removed\"]}" \
     "$MAX_API_BASE_URL/subscriptions"
   ```
2. Подписка есть, но в логах `401` → не совпадает `MAX_WEBHOOK_SECRET` с тем,
   что записан в подписке. Переподписаться с текущим секретом из `.env`.
3. В логах `fetch failed` → приложение не может достучаться до MAX. Проверить
   `docker compose logs app | grep -i max`. Корни Минцифры уже вшиты в образ.
4. Сработал `MAX_STUB=1` — сообщения пишутся в `bot_outbox` вместо отправки.
   Проверить `grep MAX_STUB .env`.

**Сторож:** `scripts/max-webhook-guard.sh` в cron переподписывается сам.
Проверить `tail -20 /var/log/max-webhook-guard.log`.

---

## 2. Панель не открывается

**Диагностика:**

```bash
docker compose ps
curl -s -o /dev/null -w "%{http_code}\n" https://<домен>/
docker compose logs --tail=50 caddy
docker compose logs --tail=50 app
```

| Что видно | Причина | Что делать |
|---|---|---|
| `caddy` не запущен | контейнер упал | `docker compose up -d caddy` |
| `app` в статусе `restarting` | падает при старте | `docker compose logs app` — чаще всего не применены миграции |
| Caddy отдаёт 502 | `app` не готов или упал | `docker compose logs app` |
| `certificate error` в браузере | сертификат не выпущен | `docker compose logs caddy \| grep -i certificate`; проверить DNS и порт 80 |
| Панель открывается пустой страницей | не собран фронт | `docker compose build app && docker compose up -d --force-recreate app` |

---

## 3. Планировщик не работает

**Признак:** в «Настройках» индикатор планировщика красный; напоминания и
тревоги не приходят.

**Диагностика:**

```bash
docker compose exec -T db psql -U dispatch -d dispatch \
  -c "SELECT value FROM settings WHERE key='scheduler:heartbeat';"
```

Пусто или старая метка времени — планировщик не идёт.

**Действия:**

1. Проверить, что `app` перезапускается по кругу (планировщик стартует вместе
   с процессом):
   ```bash
   docker compose ps app
   docker compose logs --tail=100 app | grep -i scheduler
   ```
2. Убедиться, что `SCHEDULER_SELF_PING=0` на обычном VPS (самопинг нужен
   только там, где хостинг усыпляет приложение).
3. Ручной запуск прохода планировщика:
   ```bash
   set -a; . ./.env; set +a
   curl -s "https://<домен>/api/cron/tick?key=$CRON_SECRET&src=manual"
   ```
   Ответ `{"ok":true,"ms":...}` — проход выполнился.

---

## 4. После деплоя перестали приходить события

Классика: контейнер `app` пересоздаётся, Caddy несколько секунд отдаёт 502,
MAX снимает подписку, и бот молча перестаёт получать события.

**Действия:**

```bash
# разово
set -a; . ./.env; set +a
curl -s -H "Authorization: $MAX_BOT_TOKEN" "$MAX_API_BASE_URL/subscriptions"
```

Если нашего URL в списке нет — переподписаться (см. сценарий 1).

**Профилактика:** убедиться, что в cron стоит сторож:

```bash
cat /etc/cron.d/max-webhook-guard
```

---

## 5. База данных недоступна или переполнена

**Диагностика:**

```bash
docker compose ps db
docker compose logs --tail=50 db
docker compose exec -T db psql -U dispatch -d dispatch -c "SELECT count(*) FROM requests;"
df -h /
```

**Действия:**

| Признак | Решение |
|---|---|
| `could not connect to server` | `docker compose up -d db`, затем проверить `pg_isready` |
| `Too many clients` | уменьшить `DATABASE_POOL_MAX` в `.env` или поднять `max_connections` |
| `no space left on device` | `docker builder prune -af`, `journalctl --vacuum-size=200M`, см. гигиену диска |
| БД растёт | проверить объём `bot_outbox` и `processed_updates` — они чистятся автоматически |

---

## 6. Утечка персональных данных

**Регламент (ч. 3.1 ст. 21 152-ФЗ):**

1. **24 часа** с момента обнаружения — первичное уведомление в Роскомнадзор.
2. **72 часа** — уведомление с результатами внутреннего расследования.

**Первые шаги:**

```bash
# оценить объём
docker compose exec -T db psql -U dispatch -d dispatch \
  -c "SELECT count(*) FROM staff; SELECT count(*) FROM access_events WHERE created_at > now() - interval '1 day';"

# журнал доступа — кто и когда заходил
docker compose exec -T db psql -U dispatch -d dispatch \
  -c "SELECT * FROM access_events ORDER BY id DESC LIMIT 100;"
```

**Затем:** изолировать скомпрометированную учётную запись (блокировка сотрудника
в панели), сменить секреты (см. `DEPLOYMENT.md`), собрать перечень утёкших
данных, подготовить уведомление в РКН по шаблону из `152FZ.md`.

---

## 7. Ошибочный вход, заблокирован сотрудник

**Вход заблокирован после 5 неверных кодов** — это штатная защита, снимается
автоматически через 15 минут либо администратором вручную: «Сотрудники» →
карточка → «Снять блокировку входа».

**Забыт пароль/код, MAX недоступен:** сотрудник привязан к MAX через
`max_userId`. Восстановление:

```bash
# посмотреть карточку
docker compose exec -T db psql -U dispatch -d dispatch \
  -c "SELECT id, full_name, phone, status, max_user_id FROM staff WHERE phone='79...';"

# сбросить привязку MAX — сотрудник пройдёт активацию заново
docker compose exec -T db psql -U dispatch -d dispatch \
  -c "UPDATE staff SET max_user_id=NULL, max_chat_id=NULL, status='pending' WHERE id=<id>;"
```

В панели это же делает кнопка «Сбросить привязку MAX».

---

## 8. Диск кончился

```bash
df -h /
docker system df
```

**Разовый:**

```bash
docker builder prune -af
docker image prune -af
journalctl --vacuum-size=200M
```

**Постоянно:** крон `disk-guard` и лимит кэша Docker в
`/etc/docker/daemon.json` (см. `NEW-VPS-FROM-SCRATCH.md`).

---

## 9. Подозрение на компрометацию

1. Сменить все секреты (`DEPLOYMENT.md`, раздел «Ротация секретов»).
2. Пересоздать контейнеры: `docker compose up -d --force-recreate app caddy`.
3. Сменить пароль БД.
4. Проверить журнал доступа: `access_events`.
5. Проверить список активных сессий: панель → «Сеансы», отозвать лишние.
6. Проверить вебхук: `GET /subscriptions` — там не должно быть посторонних URL.

---

## 10. Вебхук MAX не проходит проверку TLS

MAX проверяет сертификат endpoint'а: он должен быть выдан доверенным центром
(или Минцифры), имя домена — в CN/SAN, цепочка — полная, порт — 443.

**Проверка:**

```bash
echo | openssl s_client -connect <домен>:443 -servername <домен> 2>/dev/null \
  | openssl x509 -noout -subject -issuer -dates
```

**Если сертификат не от доверенного центра** (например, самоподписанный или от
Госуслус, признанный только в России) — вебхуки работать не будут. Нужен
Let's Encrypt или коммерческий УЦ.

---

## Быстрая шпаргалка

```bash
cd /opt/dispatch-containers

docker compose ps                              # что живо
docker compose logs -f app                     # логи в реальном времени
docker compose restart app                     # мягкий рестарт
docker compose up -d --force-recreate app      # пересоздать с новым образом/env
docker compose build app                       # пересобрать образ
scripts/backup.sh                              # дамп БД
set -a; . ./.env; set +a                      # загрузить секреты в окружение
```
