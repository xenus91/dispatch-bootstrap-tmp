import { Hono } from "hono";
import { cors } from "hono/cors";
import { os, type Router } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";

/**
 * Сборка HTTP-приложения: CORS, заголовки безопасности, health-check и монтаж
 * oRPC-процедур.
 *
 * Отличие от платформенного шаблона, из которого этот файл вырос — CORS
 * зафиксирован на конкретные источники вместо отражения любого Origin. В шаблоне
 * стояло `origin: (origin) => origin ?? "*"` вместе с `credentials: true`: это
 * отражает заголовок Origin любого стороннего сайта и включает
 * `Access-Control-Allow-Credentials` — классическая неправильная конфигурация
 * CORS. Здесь источник выбирается из белого списка:
 *   - ALLOWED_ORIGINS — список через запятую (если задан, он главный);
 *   - WEBSITE_URL — домен самой панели;
 *   - https://*.max.ru — мини-приложение открывается в iframe/webview мессенджера.
 *
 * Заголовки безопасности дублируются на уровне Caddy: приложение отдаёт их и само,
 * чтобы их нельзя было случайно потерять при смене обратного прокси.
 */

/** Домены, которым разрешено обращаться к API панели. */
export function allowedOrigins(): string[] {
  const fromEnv = (process.env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (fromEnv.length > 0) return fromEnv;

  const site = (process.env.WEBSITE_URL ?? "").trim();
  const list = site ? [site.replace(/\/+$/, "")] : [];
  // Мини-приложение MAX: панель лежит в iframe мессенджера, origin которого —
  // один из доменов max.ru. Точный хост заранее неизвестен, поэтому разрешаем
  // домен и его поддомены; конкретный хост можно ужесточить через ALLOWED_ORIGINS.
  list.push("https://max.ru");
  return list;
}

function isAllowedOrigin(origin: string): boolean {
  const list = allowedOrigins();
  if (list.includes(origin)) return true;
  try {
    const url = new URL(origin);
    if (url.protocol !== "https:") return false;
    if (url.hostname === "max.ru" || url.hostname.endsWith(".max.ru")) return true;
  } catch {
    /* некорректный Origin — не разрешаем */
  }
  return false;
}

/** Заголовки безопасности. frame-ancestors разрешает MAX — иначе сломается мини-приложение. */
const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "SAMEORIGIN",
  "Permissions-Policy": "geolocation=(self), camera=(self), microphone=()",
  "Content-Security-Policy": [
    "default-src 'self'",
    // Мини-приложение MAX грузит свой скрипт и работает в iframe мессенджера.
    "script-src 'self' https://st.max.ru",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self'",
    "connect-src 'self' https://platform-api2.max.ru",
    "frame-ancestors 'self' https://max.ru https://*.max.ru",
  ].join("; "),
};

/** Per-request context available in every procedure via `context`. */
export interface RpcContext {
  /** Raw request headers — read cookies/authorization for auth. */
  headers: Headers;
}

/** Base procedure builder — chain .input()/.use()/.handler() off this. */
export const base = os.$context<RpcContext>();

/** Assembles the HTTP mount: CORS → /api/health → oRPC procedures at /api/rpc/*. */
export function createApp(router: Router<Record<never, never>, RpcContext>) {
  const app = new Hono().use(
    cors({
      origin: (origin) => (origin && isAllowedOrigin(origin) ? origin : ""),
      credentials: true,
      // Required so the browser can read the bearer token header set by Better Auth.
      exposeHeaders: ["set-auth-token"],
    }),
  );

  // Заголовки — на каждый ответ, включая статику и health-check.
  app.use("*", async (c, next) => {
    await next();
    for (const [key, value] of Object.entries(SECURITY_HEADERS)) c.header(key, value);
  });

  app.get("/api/health", (c) => c.json({ status: "ok" }, 200));

  const handler = new RPCHandler(router);
  app.use("/api/rpc/*", async (c, next) => {
    const { matched, response } = await handler.handle(c.req.raw, {
      prefix: "/api/rpc",
      context: { headers: c.req.raw.headers },
    });
    if (matched) return c.newResponse(response.body, response);
    await next();
  });

  return app;
}
