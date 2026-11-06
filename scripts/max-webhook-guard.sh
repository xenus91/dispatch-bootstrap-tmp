#!/usr/bin/env bash
# Сторож вебхука MAX.
#
# Зачем: MAX снимает подписку, если endpoint долго недоступен (например, во
# время деплоя контейнер app пересоздаётся и Caddy отдаёт 502). После этого бот
# молча перестаёт получать события: водитель не получает карточку заявки,
# кнопки в чате не работают, накопившиеся сообщения висят в очереди.
#
# Скрипт раз в 5 минут проверяет список подписок и, если нашего адреса там
# нет, подписывается заново.
#
# Запуск из cron:
#   */5 * * * * /opt/dispatch-containers/scripts/max-webhook-guard.sh >> /var/log/max-webhook-guard.log 2>&1
#
# Токен и секрет берутся из .env приложения.
set -u

APP_DIR="${APP_DIR:-/opt/dispatch-containers}"
ENV_FILE="${ENV_FILE:-$APP_DIR/.env}"
LOG="${LOG:-/var/log/max-webhook-guard.log}"
EXPECTED="${EXPECTED:-}"
API="${API:-https://platform-api2.max.ru}"

[ -f "$ENV_FILE" ] || { echo "$(date -Is) нет файла $ENV_FILE" >> "$LOG"; exit 1; }

getenv() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'"'\r'; }

TOKEN="$(getenv MAX_BOT_TOKEN)"
BASE="$(getenv MAX_API_BASE_URL)"
[ -n "$BASE" ] || BASE="$API"
[ -n "$EXPECTED" ] || EXPECTED="$(getenv WEBSITE_URL)/api/webhooks/max"

[ -n "$TOKEN" ] || { echo "$(date -Is) нет MAX_BOT_TOKEN в $ENV_FILE" >> "$LOG"; exit 1; }

# Секрет вебхука живёт в двух местах: в .env (исходное значение) и в настройках
# базы (если его ротировали из панели). Актуальным считаем тот, что в базе.
SECRET="$(getenv MAX_WEBHOOK_SECRET)"
DB_SECRET="$(docker compose -f "$APP_DIR/docker-compose.yml" exec -T db \
  psql -U dispatch -d dispatch -tAc \
  "SELECT value FROM settings WHERE key='maxWebhookSecret'" 2>/dev/null | tr -d ' \r\n' || true)"
[ -n "$DB_SECRET" ] && SECRET="$DB_SECRET"

[ -n "$SECRET" ] || { echo "$(date -Is) не найден секрет вебхука" >> "$LOG"; exit 1; }

# Текущие подписки. Заголовок Authorization — без префикса Bearer.
INFO=$(curl -s --max-time 25 -H "Authorization: $TOKEN" "$BASE/subscriptions")
CURRENT=$(printf '%s' "$INFO" | grep -o '"url":"[^"]*"' | sed 's/^"url":"//; s/"$//' | grep -F "$EXPECTED" | head -1)

# Подписка на месте — выходим тихо.
[ -n "$CURRENT" ] && exit 0

# Переподписываемся.
RES=$(curl -s --max-time 25 -X POST -H "Authorization: $TOKEN" -H "Content-Type: application/json" \
  -d "{\"url\":\"$EXPECTED\",\"secret\":\"$SECRET\",\"update_types\":[\"message_created\",\"message_callback\",\"bot_started\",\"bot_stopped\",\"bot_added\",\"bot_removed\"]}" \
  "$BASE/subscriptions")

echo "$(date -Is) вебхук $EXPECTED отсутствовал — восстановлен: $(printf '%s' "$RES" | head -c 200)" >> "$LOG"
