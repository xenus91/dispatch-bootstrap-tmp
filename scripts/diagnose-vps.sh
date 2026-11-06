#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# diagnose-vps.sh — быстрая диагностика сервера перед развёртыванием.
#
# Показывает, что мешает развернуть приложение: нет Docker, закрыт порт,
# не сходится DNS, не выдаётся сертификат. Ничего не меняет — только читает.
#
# Запуск:
#   bash scripts/diagnose-vps.sh
#   bash scripts/diagnose-vps.sh --domain example.ru
# ─────────────────────────────────────────────────────────────────────────────
set -u

DOMAIN=""
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "Неизвестный аргумент: $1" >&2; exit 1 ;;
  esac
done

OK="✓"; BAD="✗"; WARN="!"
section() { echo; echo "── $* ────────────────────────────────"; }
have() { command -v "$1" >/dev/null 2>&1; }

echo "Диагностика сервера · $(date -Is)"

section "Система"
echo "  hostname: $(hostname)"
echo "  OS:       $(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME")"
echo "  ядер:     $(nproc 2>/dev/null || echo '?')"
echo "  память:   $(free -m 2>/dev/null | awk '/^Mem:/{print $2" МБ всего, "$7" МБ свободно"}')"
echo "  диск /:   $(df -h / | awk 'NR==2{print $4" свободно из "$2" ("$5" занято)"}')"

section "Сеть"
if have ip; then
  echo "  адреса:"
  ip -4 -o addr show 2>/dev/null | awk '{print "    "$2" → "$4}'
  echo "  маршрут по умолчанию: $(ip route show default 2>/dev/null | awk '{print $3}')"
else
  echo "  $WARN нет команды ip"
fi

section "Порты"
for p in 22 80 443; do
  if have ss; then
    LISTEN=$(ss -tln 2>/dev/null | awk -v p=":$p\$" '$4 ~ p {print $4}' | head -3 | tr '\n' ' ')
  else
    LISTEN=""
  fi
  if [ -n "$LISTEN" ]; then
    echo "  $OK порт $p слушается: $LISTEN"
  else
    echo "  $WARN порт $p не слушается"
  fi
done

section "SSH-сервер"
if have systemctl; then
  if systemctl is-active --quiet sshd 2>/dev/null || systemctl is-active --quiet ssh 2>/dev/null; then
    echo "  $OK sshd активен"
  else
    echo "  $BAD sshd не запущен: systemctl status ssh"
  fi
  # Проверяем, отвечает ли sshd локально — если да, проблема не в нём.
  if timeout 5 bash -c 'exec 3<>/dev/tcp/127.0.0.1/22; head -c 20 <&3' >/dev/null 2>&1; then
    echo "  $OK sshd отвечает локально на 127.0.0.1:22"
  else
    echo "  $BAD sshd не отвечает локально — смотрите systemctl status ssh и журнал"
  fi
else
  echo "  $WARN нет systemctl"
fi

section "Firewall"
if have ufw; then
  ufw status 2>/dev/null | head -8 | sed 's/^/    /'
elif have firewall-cmd; then
  firewall-cmd --list-ports 2>/dev/null | sed 's/^/    /'
else
  echo "  $WARN нет ufw/firewalld"
fi

section "Docker"
if have docker; then
  if docker compose version >/dev/null 2>&1; then
    echo "  $OK $(docker --version), $(docker compose version --short 2>/dev/null)"
    docker system df 2>/dev/null | sed 's/^/    /'
  else
    echo "  $BAD docker есть, но нет плагина compose"
  fi
else
  echo "  $BAD Docker не установлен — ставится скриптом bootstrap-fresh.sh"
fi

section "Ресурсы Docker (если установлен)"
if have docker; then
  docker ps --format '    {{.Names}}\t{{.Status}}' 2>/dev/null | head -10
fi

if [ -n "$DOMAIN" ]; then
  section "Домен $DOMAIN"
  RESOLVED=$(getent hosts "$DOMAIN" 2>/dev/null | awk '{print $1}' | head -1)
  if [ -n "$RESOLVED" ]; then
    echo "  $OK резолвится в $RESOLVED"
    PUB=$(curl -s -m 10 https://api.ipify.org 2>/dev/null)
    echo "    внешний IP сервера: ${PUB:-не определён}"
    if [ -n "$RESOLVED" ] && [ "$RESOLVED" = "${PUB}" ]; then
      echo "  $OK домен указывает на этот сервер"
    else
      echo "  $WARN домен указывает на $RESOLVED, а не на ${PUB:-IP сервера}"
    fi
  else
    echo "  $BAD домен не резолвится — не прописаны NS/A-записи или ещё не обновились"
  fi
  if have curl; then
    CODE=$(curl -sk -o /dev/null -w '%{http_code}' -m 15 "https://$DOMAIN/api/health" 2>/dev/null)
    echo "  https://$DOMAIN/api/health → ${CODE:-нет ответа}"
  fi
fi

section "Итог"
echo "  Что чинить (если что-то не так):"
echo "    • Docker нет        → bash scripts/bootstrap-fresh.sh --domain <домен> --admin-phone <телефон>"
echo "    • порт 22 закрыт    → откройте 22/tcp (ufw allow 22/tcp)"
echo "    • домен не резолвится → пропишите NS и A-запись на IP сервера"
echo
