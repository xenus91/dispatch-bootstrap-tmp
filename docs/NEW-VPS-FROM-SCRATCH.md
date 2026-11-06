# Запуск на новом VPS «с нуля»

Инструкция для администратора сервера. Весь процесс занимает 15–30 минут,
из которых основное время — сборка образа.

Полный маршрут передачи проекта заказчику — в [`HANDOVER-PLAN.md`](./HANDOVER-PLAN.md).

---

## Требования к серверу

| Параметр | Минимум | Рекомендуется |
|---|---|---|
| ОС | Ubuntu 22.04 / Debian 12 | Ubuntu 24.04 |
| CPU | 1 ядро | 2 ядра |
| RAM | 2 ГБ | 4 ГБ |
| Диск | 25 ГБ свободно | 40 ГБ |
| Сеть | открытые 80 и 443 | + 22 для SSH |

**Сервер должен находиться на территории Российской Федерации.** В базе
хранятся персональные данные (ФИО и телефоны сотрудников, данные о
местоположении, фотографии документов, ИНН клиентов), а ч. 5 ст. 18 152-ФЗ
прямо запрещает записывать персональные данные граждан РФ в базы,
расположенные за пределами России.

---

## Шаг 0. Подготовка

Нужен домен панели. Например `example.ru`.

**A-запись** домена должна указывать на IP сервера. Проверить:

```bash
curl -s ifconfig.me          # ваш публичный IP
getent hosts example.ru      # должен совпадать
```

Порты 80 и 443 должны быть открыты — иначе Caddy не пройдёт проверку ACME
и не выпустит сертификат.

> **Проверка выпуска сертификата заранее.** Let's Encrypt с июня 2026 года
> не выдаёт сертификаты для лиц и организаций из санкционных списков OFAC, а
> для доменов, чьи IP-адреса заблокированы Роскомнадзором, возможны технические
> сбои. Проверить заранее, не тратя лимиты:
> ```bash
> certbot certonly --dry-run -d example.ru
> ```
> Если в ответе есть `The dry run was successful` — всё в порядке. Слова
> `Unauthorized`, `Blocked` или `Policy` — повод разобраться с DNS или
> санкционным статусом.
>
> Запасной вариант, если Let's Encrypt не выпустит: сертификат российского УЦ,
> см. раздел «Сертификат российского УЦ» ниже.

---

## Шаг 1. Docker

```bash
curl -fsSL https://get.docker.com | sh
systemctl enable --now docker
docker compose version
```

---

## Шаг 2. Код

```bash
git clone --branch main git@github.com:xenus91/DispatchContainers.git /opt/dispatch-containers
cd /opt/dispatch-containers
```

Если репозиторий приватный, сначала настройте SSH-ключ на сервере:

```bash
ssh-keygen -t ed25519 -C "deploy@$(hostname)" -N ''
cat ~/.ssh/id_ed25519.pub    # добавить в GitHub → Settings → SSH keys
ssh -T git@github.com
```

---

## Шаг 3. Развёртывание одной командой

```bash
bash scripts/bootstrap-fresh.sh --domain example.ru --admin-phone 79001234567
```

Скрипт идемпотентный — его можно запускать повторно. Что он делает:

1. Проверяет окружение (root, git, Docker).
2. Ставит Docker, если его нет.
3. Открывает порты 22, 80, 443 (ufw или firewalld).
4. Клонирует или обновляет код в `/opt/dispatch-containers`.
5. Создаёт `.env` со **сгенерированными** секретами (пароль БД, секрет
   вебхука, секрет планировщика) и правами `600`. Уже существующий `.env`
   не трогает — секреты не перезаписываются.
6. Подставляет домен в `Caddyfile`.
7. Собирает образ, накатывает миграции, поднимает контейнеры.
8. Проверяет health-check и выпуск сертификата.

Полезные флаги:

| Флаг | Назначение |
|---|---|
| `--domain ДОМЕН` | домен панели (обязателен) |
| `--admin-phone ТЕЛЕФОН` | телефон первого администратора цифрами |
| `--admin-name ИМЯ` | имя первого администратора |
| `--env-file ПУТЬ` | взять готовый `.env` вместо генерации |
| `--repo-url URL` | другой адрес репозитория |
| `--branch ИМЯ` | другая ветка (по умолчанию `main`) |
| `--app-dir ПУТЬ` | другой каталог установки |
| `--skip-docker` | не ставить Docker |
| `--skip-firewall` | не трогать firewall |
| `--dry-run` | только показать, что будет сделано |

---

## Шаг 4. Токен MAX-бота

Без токена бот работает в режиме заглушки: сообщения не уходят, водители не
получают карточки заявок.

1. Откройте `business.max.ru` → раздел «Чат-боты» → «Настройки» → скопируйте
   токен.
2. Впишите его в `/opt/dispatch-containers/.env`:

```
MAX_BOT_TOKEN=<токен>
MAX_BOT_USERNAME=<username бота без @>
```

3. Перезапустите приложение:

```bash
cd /opt/dispatch-containers
docker compose up -d --force-recreate app
```

> `--force-recreate` обязателен. Без него контейнер не пересоздастся и новые
> переменные окружения не подхватятся.

---

## Шаг 5. Подписка на вебхук

События от MAX приходят на `https://<домен>/api/webhooks/max`.

**Через панель (рекомендуется):**
войдите администратором → «Настройки» → «Интеграция с MAX» → поле «URL вебхука
для регистрации в MAX» → «Подписать».

**Через API:**

```bash
set -a; . /opt/dispatch-containers/.env; set +a
curl -s -X POST -H "Authorization: $MAX_BOT_TOKEN" -H "Content-Type: application/json" \
  -d "{\"url\":\"https://$DOMAIN/api/webhooks/max\",\"secret\":\"$MAX_WEBHOOK_SECRET\",\"update_types\":[\"message_created\",\"message_callback\",\"bot_started\",\"bot_stopped\",\"bot_added\",\"bot_removed\"]}" \
  "$MAX_API_BASE_URL/subscriptions"
```

### Сторож вебхука

MAX снимает подписку, если endpoint долго недоступен — например, во время
деплоя, когда контейнер пересоздаётся и Caddy отдаёт 502. После этого бот
**молча** перестаёт получать события: водитель не получает карточку, кнопки
в чате не работают.

Чтобы этого не происходило, поставьте сторож в cron:

```bash
cat > /etc/cron.d/max-webhook-guard <<'EOF'
*/5 * * * * /opt/dispatch-containers/scripts/max-webhook-guard.sh >> /var/log/max-webhook-guard.log 2>&1
EOF
```

Сторож раз в 5 минут сверяет список подписок и переподписывается, если нашего
адреса там нет.

---

## Шаг 6. Бэкапы

```bash
cat > /etc/cron.d/dispatch-backup <<'EOF'
30 3 * * * /opt/dispatch-containers/scripts/backup.sh >> /var/log/dispatch-backup.log 2>&1
EOF
```

Дампы сжимаются и хранятся 7 дней в `/opt/dispatch-containers/backups`.

**Бэкап, который ни разу не восстановили, — это не бэкап.** Проверьте
восстановление на отдельной базе:

```bash
cd /opt/dispatch-containers
docker compose exec -T db psql -U dispatch -d dispatch -c "CREATE DATABASE restore_check;"
gunzip -c backups/dispatch-<файл>.sql.gz | docker compose exec -T db psql -U dispatch -d restore_check
docker compose exec -T db psql -U dispatch -d restore_check -c "SELECT count(*) FROM requests;"
docker compose exec -T db psql -U dispatch -d dispatch -c "DROP DATABASE restore_check;"
```

---

## Шаг 7. Проверки

Всё сразу — одной командой (только читает, ничего не меняет):

```bash
bash /opt/dispatch-containers/scripts/status.sh --domain dispatch-containers.ru
```

Скрипт покажет по шагам: Docker, код, `.env` (какие секреты заданы, а какие
нет), образ, контейнеры, таблицы в базе, ответ приложения, состояние сертификата
и домена, сторож вебхука. Итоговая строка подсказывает следующий шаг.

Отдельно:

```bash
cd /opt/dispatch-containers
docker compose ps                                    # db healthy, migrate exited 0, app healthy, caddy up
curl -s https://<домен>/api/health                   # {"status":"ok"}
docker compose logs --tail=50 app | grep -i error
docker compose logs caddy | grep -i certificate      # сертификат выпущен
```

В браузере:

- панель открывается по HTTPS, замок в адресной строке;
- вход по номеру телефона и коду из MAX;
- панель открывается внутри мини-приложения MAX (не пустой экран) — это
  проверка `frame-ancestors` в Caddy;
- в «Настройках» зелёный индикатор планировщика.

---

## Сертификат российского УЦ

Если Let's Encrypt не выпускает сертификат (санкционные ограничения, блокировка
IP), возьмите сертификат в российском УЦ и смонтируйте его вручную:

```bash
mkdir -p /opt/dispatch-containers/certs
# положите сюда domain.crt и domain.key, права 600 на ключ
```

В `Caddyfile` для нужного блока домена:

```
example.ru {
	tls /etc/caddy/certs/example.ru.crt /etc/caddy/certs/example.ru.key
	reverse_proxy app:4200
}
```

И в `docker-compose.yml` у сервиса `caddy`:

```yaml
    volumes:
      - ./certs:/etc/caddy/certs:ro
```

> Сертификаты от Госуслус признаются только в России. Для зарубежных браузеров
> и для приёма вебхуков MAX такой сертификат не подойдёт — берите коммерческий
> УЦ.

---

## Гигиена диска

Docker build-cache способен занять десятки гигабайт. После серии сборок:

```bash
docker builder prune -af
docker system df
df -h /
```

Постоянная гигиена:

```bash
cat > /etc/cron.d/dispatch-disk-guard <<'EOF'
15 5 * * * docker builder prune -af --filter "until=24h" >/dev/null 2>&1; docker image prune -af --filter "until=72h" >/dev/null 2>&1; journalctl --vacuum-size=200M >/dev/null 2>&1
EOF
```

И лимит кэша в `/etc/docker/daemon.json`:

```json
{
  "builder": { "gc": { "enabled": true, "defaultKeepStorage": "2GB", "reservedSpace": "1GB" } }
}
```

После правки: `systemctl restart docker`. Контейнеры с `restart: unless-stopped`
поднимутся сами, будет секундный простой.

---

## Если что-то не так

| Симптом | Причина и решение |
|---|---|
| Caddy не выпускает сертификат | DNS ещё не указывает на IP сервера, или закрыт порт 80. Проверьте `docker compose logs caddy` |
| `container "db" is unhealthy` | Не сработал `pg_isready`. `docker compose logs db` |
| Панель открывается по HTTPS, но пустая | Не собрался фронт. `docker compose logs app`, проверьте наличие `packages/web/dist` |
| Мини-приложение MAX открывается пустым | В `Caddyfile` потерян `frame-ancestors` с `https://*.max.ru` |
| Бот отвечает «нет токена» | Не заполнен `MAX_BOT_TOKEN`, контейнер не пересоздан |
| События MAX не приходят | Проверьте подписку: `GET /subscriptions`. Работает сторож `scripts/max-webhook-guard.sh` |
| `Too many clients` в логах БД | Превышен `max_connections`. Уменьшите `DATABASE_POOL_MAX` или поднимите `max_connections` |
| Изменения в коде не видны | `docker compose up -d --force-recreate app` — без `--force-recreate` новый образ не подхватится |
| `permission denied` при записи в `.env` | `chmod 600 .env` и `chown root:root .env` |
