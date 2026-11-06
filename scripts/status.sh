#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# status.sh — статус развёртывания «одним взглядом».
#
# Показывает, на каком шаге находится установка: Docker, код, образ, контейнеры,
# база, сертификат, вебхук. Только читает — ничего не меняет.
#
# Запуск на сервере:
#   bash /opt/dispatch-containers/scripts/status.sh
#   bash /opt/dispatch-containers/scripts/status.sh --domain dispatch-containers.ru
# ─────────────────────────────────────────────────────────────────────────────
set -u

APP_DIR="${APP_DIR:-/opt/dispatch-containers}"
DOMAIN=""
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "Неизвестный аргумент: $1" >&2; exit 1 ;;
  esac
done

OK="✓"; BAD="✗"; WARN="!"; STEP="→"
COMPOSE="$APP_DIR/docker-compose.yml"

section() { echo; echo "── $* ──────────────────────────────────────────"; }
have() { command -v "$1" >/dev/null 2>&1; }

echo "Статус развёртывания · $(date -Is)"

# ── 1. Docker ───────────────────────────────────────────────────────────────
section "1. Docker"
if have docker; then
  echo "  $OK $(docker --version 2>/dev/null)"
  if docker info >/dev/null 2>&1; then
    echo "  $OK демон работает"
  else
    echo "  $BAD демон не отвечает — systemctl start docker"
  fi
  if docker compose version >/dev/null 2>&1; then
    echo "  $OK compose $(docker compose version --short 2>/dev/null)"
  else
    echo "  $BAD нет плагина compose"
  fi
  echo "  место на диске:"
  docker system df 2>/dev/null | sed 's/^/    /'
else
  echo "  $BAD Docker не установлен"
fi

# ── 2. Код ──────────────────────────────────────────────────────────────────
section "2. Код"
if [ -d "$APP_DIR/.git" ]; then
  echo "  $OK клон в $APP_DIR"
  echo "    коммит: $(git -C "$APP_DIR" log --oneline -1 2>/dev/null)"
  BRANCH=$(git -C "$APP_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null)
  echo "    ветка:  $BRANCH"
  if git -C "$APP_DIR" status --porcelain 2>/dev/null | grep -q .; then
    echo "  $WARN есть незакоммиченные изменения:"
    git -C "$APP_DIR" status --short 2>/dev/null | head -5 | sed 's/^/      /'
  else
    echo "  $OK рабочее дерево чистое"
  fi
elif [ -d "$APP_DIR" ]; then
  echo "  $WARN $APP_DIR существует, но это не git-клон (распакованный архив)"
  echo "    обновлять код придётся вручную — распакуйте архив поверх"
else
  echo "  $BAD каталога $APP_DIR нет"
fi

# ── 3. Конфигурация ──────────────────────────────────────────────────────────
section "3. Конфигурация"
if [ -f "$APP_DIR/.env" ]; then
  echo "  $OK .env есть (права: $(stat -c '%a' "$APP_DIR/.env" 2>/dev/null))"
  getv() { grep -E "^$1=" "$APP_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'"'\r'; }
  for v in DOMAIN POSTGRES_PASSWORD MAX_BOT_TOKEN MAX_WEBHOOK_SECRET CRON_SECRET SEED_ADMIN_PHONE; do
    VAL="$(getv "$v")"
    if [ -n "$VAL" ]; then
      case "$v" in
        *PASSWORD|*TOKEN|*SECRET) echo "    $OK $v задан" ;;
        *) echo "    $OK $v = $VAL" ;;
      esac
    else
      echo "    $BAD $v НЕ ЗАДАН"
    fi
  done
  if [ -z "$(getv MAX_BOT_TOKEN)" ]; then
    echo "  $WARN без MAX_BOT_TOKEN бот работает в заглушке — водителям карточки не приходят"
  fi
else
  echo "  $BAD .env нет — развёртывание не завершено"
fi

# ── 4. Образ и контейнеры ────────────────────────────────────────────────────
section "4. Образ и контейнеры"
if have docker && [ -f "$COMPOSE" ]; then
  echo "  образы:"
  docker images --format '    {{.Repository}}:{{.Tag}}  {{.Size}}  {{.CreatedSince}}' 2>/dev/null \
    | grep -i dispatch | head -5 || echo "    (нет)"
  echo "  контейнеры:"
  docker compose -f "$COMPOSE" ps --format '    {{.Name}}  {{.State}}  {{.Status}}' 2>/dev/null || echo "    (нет)"
fi

# ── 5. База и миграции ───────────────────────────────────────────────────────
section "5. База данных"
if have docker && [ -f "$COMPOSE" ]; then
  TABLES=$(docker compose -f "$COMPOSE" exec -T db psql -U dispatch -d dispatch -tAc \
    "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'" 2>/dev/null | tr -d ' \r\n')
  if [ -n "$TABLES" ] && [ "$TABLES" != "0" ]; then
    echo "  $OK таблиц в базе: $TABLES"
    for t in staff requests settings audit_log webhook_events; do
      N=$(docker compose -f "$COMPOSE" exec -T db psql -U dispatch -d dispatch -tAc \
        "SELECT count(*) FROM $t" 2>/dev/null | tr -d ' \r\n')
      [ -n "$N" ] && echo "    $t: $N"
    done
  else
    echo "  $WARN таблиц нет — миграции не применены"
  fi
fi

# ── 6. Приложение ────────────────────────────────────────────────────────────
section "6. Приложение"
if have docker && [ -f "$COMPOSE" ]; then
  H=$(docker compose -f "$COMPOSE" exec -T app bun -e \
    "fetch('http://127.0.0.1:4200/api/health').then(r=>r.text()).then(t=>console.log(t)).catch(()=>console.log('unreachable'))" 2>/dev/null | tr -d '\r\n')
  case "$H" in
    *'"status":"ok"'*) echo "  $OK /api/health отвечает: $H" ;;
    *) echo "  $WARN приложение не отвечает изнутри ($H)" ;;
  esac
  echo "  последние строки лога:"
  docker compose -f "$COMPOSE" logs --tail=6 app 2>/dev/null | sed 's/^/    /'
fi

# ── 7. Домен, сертификат, вебхук ────────────────────────────────────────────
section "7. Домен, TLS, вебхук"
if [ -n "$DOMAIN" ]; then
  RESOLVED=$(getent hosts "$DOMAIN" 2>/dev/null | awk '{print $1}' | head -1)
  PUB=$(curl -s -m 10 https://api.ipify.org 2>/dev/null)
  echo "    внешний IP сервера: ${PUB:-не определён}"
  if [ -n "$RESOLVED" ]; then
    echo "    $DOMAIN → $RESOLVED"
    [ "$RESOLVED" = "$PUB" ] && echo "  $OK домен указывает на этот сервер" \
                            || echo "  $WARN домен указывает на $RESOLVED, а не на $PUB"
  else
    echo "  $BAD домен не резолвится"
  fi
  CODE=$(curl -sk -o /dev/null -w '%{http_code}' -m 15 "https://$DOMAIN/api/health" 2>/dev/null)
  case "$CODE" in
    200) echo "  $OK https://$DOMAIN/api/health → 200" ;;
    000) echo "  $WARN https://$DOMAIN/api/health не отвечает — сертификат ещё не выпущен или Caddy не поднят" ;;
    *)   echo "  $WARN https://$DOMAIN/api/health → $CODE" ;;
  esac
  CERT=$(docker compose -f "$COMPOSE" logs caddy 2>/dev/null | grep -iE "certificate obtained|error.*certificate|challenge" | tail -3)
  [ -n "$CERT" ] && echo "$CERT" | sed 's/^/    /'
fi
if [ -f /etc/cron.d/max-webhook-guard ]; then
  echo "  $OK сторож вебхука стоит в cron"
else
  echo "  $WARN сторож вебхука не установлен (см. NEW-VPS-FROM-SCRATCH.md, шаг 5)"
fi

# ── 8. Итог ─────────────────────────────────────────────────────────────────
section "Итог"
if have docker && [ -f "$APP_DIR/.env" ] && [ -n "${DOMAIN:-}" ]; then
  echo "  Развёртывание выполнено. Дальше:"
  echo "    1. Проверьте MAX_BOT_TOKEN в .env → docker compose up -d --force-recreate app"
  echo "    2. В панели: Настройки → Интеграция с MAX → Подписать"
  echo "    3. Поставьте сторож: /etc/cron.d/max-webhook-guard"
else
  echo "  Развёртывание не завершено — начните с:"
  echo "    bash scripts/bootstrap-fresh.sh --domain <домен> --admin-phone <телефон>"
fi
echo
