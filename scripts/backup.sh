#!/usr/bin/env bash
# Бэкап базы данных.
#
#   scripts/backup.sh            — сделать дамп
#   scripts/backup.sh restore <файл>  — восстановить из дампа
#
# Дампы сжимаются и хранятся 7 дней. Восстановление проверяется вручную:
# бэкап, который ни разу не восстановили, — это не бэкап.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/dispatch-containers}"
BACKUP_DIR="${BACKUP_DIR:-$APP_DIR/backups}"
KEEP_DAYS="${KEEP_DAYS:-7}"
COMPOSE="$APP_DIR/docker-compose.yml"

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

db_exec() { docker compose -f "$COMPOSE" exec -T db "$@"; }

if [ "${1:-backup}" = "restore" ]; then
  FILE="${2:-}"
  [ -n "$FILE" ] || { echo "Укажите файл: scripts/backup.sh restore <файл>" >&2; exit 1; }
  [ -f "$FILE" ] || { echo "Нет файла: $FILE" >&2; exit 1; }
  echo "Восстановление в базу из $FILE. Существующие данные будут заменены."
  read -r -p "Продолжить? (yes/no): " ans
  [ "$ans" = "yes" ] || { echo "Отменено."; exit 1; }

  gunzip -c "$FILE" | db_exec psql -U dispatch -d dispatch -v ON_ERROR_STOP=1
  echo "Восстановлено. Проверьте количество заявок:"
  db_exec psql -U dispatch -d dispatch -c "SELECT count(*) AS requests FROM requests;"
  exit 0
fi

STAMP=$(date +%Y%m%d-%H%M%S)
TARGET="$BACKUP_DIR/dispatch-$STAMP.sql.gz"

db_exec pg_dump -U dispatch -d dispatch --clean --if-exists | gzip -9 > "$TARGET"
chmod 600 "$TARGET"

SIZE=$(du -h "$TARGET" | cut -f1)
echo "$(date -Is) дамп создан: $TARGET ($SIZE)"

find "$BACKUP_DIR" -name 'dispatch-*.sql.gz' -mtime "+$KEEP_DAYS" -delete
echo "Хранятся дампы за последние $KEEP_DAYS дней."
