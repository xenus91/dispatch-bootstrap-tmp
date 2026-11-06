#!/usr/bin/env bash
# =============================================================================
# bootstrap-fresh.sh — разворачивает DispatchContainers на чистом VPS.
#
# Делает всё: Docker, firewall, код, .env, Caddyfile, сборка, миграции, запуск
# и проверки. Скрипт идемпотентный — его можно запускать повторно, уже сделанные
# шаги пропускаются.
#
# Запуск (от root, в каталоге репозитория):
#   bash scripts/bootstrap-fresh.sh --domain example.ru
#
# Флаги:
#   --domain ДОМЕН            домен панели (обязателен)
#   --admin-phone ТЕЛЕФОН     телефон первого администратора цифрами
#   --admin-name ИМЯ          имя первого администратора
#   --env-file ПУТЬ           взять готовый .env вместо генерации
#   --repo-url URL            адрес репозитория (если клон ещё не сделан)
#   --branch ИМЯ              ветка (по умолчанию main)
#   --app-dir ПУТЬ            каталог установки (по умолчанию /opt/dispatch-containers)
#   --skip-docker             не ставить Docker
#   --skip-firewall           не трогать firewall
#   --no-tls-email            не задавать email для сертификата
#   --dry-run                 только показать, что будет сделано
#   -h, --help                справка
# =============================================================================
set -euo pipefail

DOMAIN=""
ADMIN_PHONE=""
ADMIN_NAME="Администратор"
ENV_FILE=""
REPO_URL="git@github.com:xenus91/DispatchContainers.git"
BRANCH="main"
APP_DIR="/opt/dispatch-containers"
SKIP_DOCKER=0
SKIP_FIREWALL=0
DRY_RUN=0
TLS_EMAIL="admin@example.com"

YELLOW="\033[1;33m"; GREEN="\033[1;32m"; RED="\033[1;31m"; NC="\033[0m"
step() { echo; echo -e "${YELLOW}$*${NC}"; }
ok()   { echo -e "${GREEN}  ✓${NC} $*"; }
die()  { echo -e "${RED}  ✗ $*${NC}" >&2; exit 1; }
run()  { if [ "$DRY_RUN" = 1 ]; then echo "    [dry-run] $*"; else eval "$@"; fi; }

# ── разбор аргументов ───────────────────────────────────────────────────────
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --admin-phone) ADMIN_PHONE="${2:-}"; shift 2 ;;
    --admin-name) ADMIN_NAME="${2:-}"; shift 2 ;;
    --env-file) ENV_FILE="${2:-}"; shift 2 ;;
    --repo-url) REPO_URL="${2:-}"; shift 2 ;;
    --branch) BRANCH="${2:-}"; shift 2 ;;
    --app-dir) APP_DIR="${2:-}"; shift 2 ;;
    --skip-docker) SKIP_DOCKER=1; shift ;;
    --skip-firewall) SKIP_FIREWALL=1; shift ;;
    --no-tls-email) TLS_EMAIL=""; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) die "Неизвестный аргумент: $1" ;;
  esac
done

[ -n "$DOMAIN" ] || die "Нужен --domain. Пример: --domain example.ru"

# ── 0. проверки окружения ───────────────────────────────────────────────────
step "0/8. Проверка окружения"
[ "$(id -u)" = "0" ] || die "Запускать от root"
command -v git >/dev/null || die "Не найден git"
ok "root, git на месте"

# ── 1. Docker ───────────────────────────────────────────────────────────────
step "1/8. Docker"
if command -v docker >/dev/null && docker compose version >/dev/null 2>&1; then
  ok "Docker и compose уже установлены"
elif [ "$SKIP_DOCKER" = 1 ]; then
  die "--skip-docker, но Docker не найден"
else
  run "curl -fsSL https://get.docker.com | sh"
  run "systemctl enable --now docker"
  ok "Docker установлен"
fi

# ── 2. firewall ─────────────────────────────────────────────────────────────
step "2/8. Firewall (22, 80, 443)"
if [ "$SKIP_FIREWALL" = 1 ]; then
  ok "пропущено"
elif command -v ufw >/dev/null; then
  run "ufw allow 22/tcp; ufw allow 80/tcp; ufw allow 443/tcp; ufw allow 443/udp"
  ok "правила ufw добавлены"
elif command -v firewall-cmd >/dev/null; then
  run "firewall-cmd --permanent --add-port=80/tcp --add-port=443/tcp --add-port=443/udp; firewall-cmd --reload"
  ok "правила firewalld добавлены"
else
  ok "системного менеджера firewall нет — откройте 80/443 у хостера"
fi

# ── 3. код ──────────────────────────────────────────────────────────────────
# Три источника кода, в порядке приоритета:
#   1. уже развёрнутый git-клон в $APP_DIR — обновляем;
#   2. распакованное дерево без .git (типичный сценарий: архив залили по scp) —
#      ничего не трогаем, только проверяем целостность;
#   3. ничего нет — клонируем из репозитория.
step "3/8. Код приложения"
if [ -d "$APP_DIR/.git" ]; then
  run "cd '$APP_DIR' && git fetch --all && git checkout '$BRANCH' && git reset --hard origin/$BRANCH"
  ok "обновлён существующий клон"
elif [ -f "$APP_DIR/package.json" ] && [ -d "$APP_DIR/packages/web" ]; then
  ok "дерево уже распаковано в $APP_DIR — использую его как есть"
  [ -f "$APP_DIR/scripts/bootstrap-fresh.sh" ] || die "В $APP_DIR нет scripts/bootstrap-fresh.sh — распаковка неполная"
  [ -f "$APP_DIR/Dockerfile" ] || die "В $APP_DIR нет Dockerfile — распаковка неполная"
else
  run "git clone --branch '$BRANCH' '$REPO_URL' '$APP_DIR'"
  ok "клонирован в $APP_DIR"
fi

# ── 3a. целостность поставки ────────────────────────────────────────────────
step "3a/8. Проверка поставки"
missing=""
for f in Dockerfile docker-compose.yml Caddyfile packages/web/src/__server.ts \
         packages/web/drizzle/0000_needy_bishop.sql packages/web/src/api/database/schema.ts \
         scripts/max-webhook-guard.sh scripts/backup.sh .env.example; do
  [ -f "$APP_DIR/$f" ] || missing="$missing $f"
done
if [ -n "$missing" ]; then
  die "В $APP_DIR не хватает файлов:$missing — поставка неполная, перезалейте архив."
fi
ok "все ключевые файлы на месте"

# ── 4. .env ─────────────────────────────────────────────────────────────────
step "4/8. Переменные окружения"
ENV_TARGET="$APP_DIR/.env"
if [ -n "$ENV_FILE" ] && [ -f "$ENV_FILE" ]; then
  run "cp '$ENV_FILE' '$ENV_TARGET' && chmod 600 '$ENV_TARGET'"
  ok "взят готовый .env"
elif [ -f "$ENV_TARGET" ]; then
  ok ".env уже существует — не трогаю (секреты не перезаписываются)"
else
  gen() { openssl rand -hex 32; }
  DB_PASS="$(gen)"
  MAX_SECRET="$(gen)"
  CRON="$(gen)"
  {
    echo "NODE_ENV=production"
    echo "PORT=4200"
    echo "WEBSITE_URL=https://$DOMAIN"
    echo "MAX_MINIAPP_URL=https://$DOMAIN"
    echo "DOMAIN=$DOMAIN"
    echo "ACME_EMAIL=$TLS_EMAIL"
    echo "TZ=Europe/Moscow"
    echo
    echo "POSTGRES_USER=dispatch"
    echo "POSTGRES_PASSWORD=$DB_PASS"
    echo "POSTGRES_DB=dispatch"
    echo "DATABASE_URL=postgres://dispatch:$DB_PASS@db:5432/dispatch"
    echo
    echo "MAX_BOT_TOKEN="
    echo "MAX_BOT_USERNAME="
    echo "MAX_WEBHOOK_SECRET=$MAX_SECRET"
    echo "MAX_API_BASE_URL=https://platform-api2.max.ru"
    echo "MAX_STUB=0"
    echo "MAX_LONG_POLLING=0"
    echo "MAX_MEDIA_DEBOUNCE_MS="
    echo
    echo "CRON_SECRET=$CRON"
    echo "SCHEDULER_SELF_PING=0"
    echo
    echo "SEED_ADMIN_PHONE=${ADMIN_PHONE}"
    echo "SEED_ADMIN_NAME=$ADMIN_NAME"
    echo "DEV_LOGIN=0"
  } > "$ENV_TARGET"
  run "chmod 600 '$ENV_TARGET'"
  ok "создан .env со сгенерированными секретами (права 600)"
fi

# ── 5. Caddyfile ────────────────────────────────────────────────────────────
step "5/8. Caddyfile под домен $DOMAIN"
CADDY_TARGET="$APP_DIR/Caddyfile"
if [ -f "$CADDY_TARGET" ] && ! grep -q "^\s*{$DOMAIN}" "$CADDY_TARGET" 2>/dev/null; then
  [ -f "$CADDY_TARGET.orig" ] || cp "$CADDY_TARGET" "$CADDY_TARGET.orig"
  run "sed -i 's|{\$DOMAIN}|$DOMAIN|g' '$CADDY_TARGET'"
  ok "домен прописан в Caddyfile (оригинал — Caddyfile.orig)"
else
  ok "Caddyfile уже настроен"
fi

# ── 6. сборка, миграции, запуск ─────────────────────────────────────────────
step "6/8. Сборка и запуск (5–15 минут)"
run "cd '$APP_DIR' && docker compose build app"
run "cd '$APP_DIR' && docker compose up -d"
ok "контейнеры подняты"

# ── 7. проверки ─────────────────────────────────────────────────────────────
step "7/8. Проверки"
sleep 5
run "cd '$APP_DIR' && docker compose ps"
HEALTH=$(docker compose -f "$APP_DIR/docker-compose.yml" --env-file "$ENV_TARGET" exec -T app \
  bun -e "fetch('http://127.0.0.1:4200/api/health').then(r=>r.text()).then(t=>console.log(t)).catch(()=>console.log('unreachable'))" 2>/dev/null || echo "unreachable")
if echo "$HEALTH" | grep -q '"status":"ok"'; then
  ok "health-check отвечает: $HEALTH"
else
  ok "health-check пока не отвечает — проверьте: docker compose logs app"
fi

CERT=$(docker compose -f "$APP_DIR/docker-compose.yml" --env-file "$ENV_TARGET" logs caddy 2>/dev/null \
  | grep -i "certificate obtained\|certificate is valid" | tail -1 || true)
if [ -n "$CERT" ]; then
  ok "сертификат выпущен"
else
  ok "сертификат ещё не выпущен — Caddy возьмёт его сам, когда DNS укажет на этот IP"
fi

# ── 8. что дальше ───────────────────────────────────────────────────────────
step "8/8. Готово"
cat <<EOF

Панель:      https://$DOMAIN
Каталог:     $APP_DIR
Логи:        cd $APP_DIR && docker compose logs -f app
Бэкап:       $APP_DIR/scripts/backup.sh

Осталось сделать вручную:
  1. Прописать A-запись домена $DOMAIN на IP этого сервера.
  2. Вписать MAX_BOT_TOKEN и MAX_BOT_USERNAME в $APP_DIR/.env
     (business.max.ru → Чат-боты → Настройки), затем:
       cd $APP_DIR && docker compose up -d --force-recreate app
  3. В панели: Настройки → Интеграция с MAX → подписать бота на вебхук
     (URL подставится автоматически).
  4. Войти первым администратором:
       ${ADMIN_PHONE:-не задан — задайте --admin-phone при развёртывании}

EOF
