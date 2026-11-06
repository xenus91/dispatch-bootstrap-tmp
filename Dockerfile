# syntax=docker/dockerfile:1
#
# Сборка приложения для развёртывания на VPS.
#
# Стадии:
#   deps      — полная установка зависимостей (нужна для сборки и для миграций);
#   prod-deps — только production-зависимости (попадают в итоговый образ);
#   build     — сборка фронта (tsc --noEmit + vite build);
#   migrate   — образ для накатывания миграций БД (drizzle-kit);
#   runner    — итоговый образ: Bun + собранная статика + исходники API.
#
# Приложение — один процесс Bun: он отдаёт и API, и статику. Отдельный
# Node/nginx не нужен, наружу смотрит Caddy.

# ─────────────────────────────────────────────────────────────────────────────
FROM oven/bun:1.3.14-alpine AS deps
WORKDIR /app
# Манифесты копируем отдельно от кода — слой с зависимостями переиспользуется
# при изменении исходников.
COPY package.json bun.lock ./
COPY packages/web/package.json packages/web/package.json
RUN bun install --frozen-lockfile

# ─────────────────────────────────────────────────────────────────────────────
FROM oven/bun:1.3.14-alpine AS prod-deps
WORKDIR /app
COPY package.json bun.lock ./
COPY packages/web/package.json packages/web/package.json
RUN bun install --frozen-lockfile --production

# ─────────────────────────────────────────────────────────────────────────────
FROM oven/bun:1.3.14-alpine AS build
WORKDIR /app
# ffmpeg нужен плагину оптимизации ассетов (сжимает og-картинки и видео в public/).
# sharp ставится npm-пакетом и тянет прекомпилированные бинарники под linux.
RUN apk add --no-cache ffmpeg
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/web/node_modules ./packages/web/node_modules
COPY . .
RUN bun run build:web

# ─────────────────────────────────────────────────────────────────────────────
# Образ для миграций: полные зависимости (включая drizzle-kit) + SQL-файлы.
FROM deps AS migrate
WORKDIR /app/packages/web
COPY packages/web/drizzle.config.ts ./drizzle.config.ts
COPY packages/web/drizzle ./drizzle
CMD ["bun", "run", "db:migrate"]

# ─────────────────────────────────────────────────────────────────────────────
FROM oven/bun:1.3.14-alpine AS runner
WORKDIR /app

# ca-certificates — TLS к MAX и к CDN вложений.
# tzdata — приложение работает с таймзоной Europe/Moscow; без tzdata Intl
#            в Alpine считает время неверно.
RUN apk add --no-cache ca-certificates tzdata \
    && addgroup -g 10001 -S app \
    && adduser -u 10001 -S -G app -h /app app

# Корни Минцифры в системном хранилище. В коде они уже передаются в каждый
# запрос к MAX (api/max/tls.ts), но bundle нужен ещё и для служебных
# обращений из контейнера (curl в healthcheck, диагностика).
COPY certs/russian-trusted-root-ca.pem certs/russian-trusted-sub-ca.pem /usr/local/share/russian-ca/
RUN cat /etc/ssl/certs/ca-certificates.crt > /usr/local/share/ca-bundle-with-russian.crt \
    && printf '\n' >> /usr/local/share/ca-bundle-with-russian.crt \
    && cat /usr/local/share/russian-ca/russian-trusted-root-ca.pem >> /usr/local/share/ca-bundle-with-russian.crt \
    && printf '\n' >> /usr/local/share/ca-bundle-with-russian.crt \
    && cat /usr/local/share/russian-ca/russian-trusted-sub-ca.pem >> /usr/local/share/ca-bundle-with-russian.crt \
    && chmod 644 /usr/local/share/ca-bundle-with-russian.crt

ENV NODE_ENV=production \
    PORT=4200 \
    TZ=Europe/Moscow \
    SSL_CERT_FILE=/usr/local/share/ca-bundle-with-russian.crt \
    BUN_INSTALL_CACHE_DIR=/tmp/.bun-cache

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/packages/web/node_modules ./packages/web/node_modules
COPY --from=build /app/packages/web/dist ./packages/web/dist
COPY --from=build /app/packages/web/src ./packages/web/src
COPY --from=build /app/packages/web/package.json ./packages/web/package.json
COPY --from=build /app/packages/web/drizzle.config.ts ./packages/web/drizzle.config.ts
COPY --from=build /app/packages/web/drizzle ./packages/web/drizzle

USER app
EXPOSE 4200

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT||4200)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["bun", "packages/web/src/__server.ts"]
