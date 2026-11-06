import tls from "node:tls";

/**
 * Проверка достижимости вебхука MAX.
 *
 * Проверяем ровно то, на что смотрит MAX:
 *   - endpoint отвечает по HTTPS на 443;
 *   - сертификат выдан доверенным центром и имя домена в нём есть;
 *   - на запрос с корректным секретом приходит 200.
 *
 * Запрос уходит с пустым телом `{}`: он валидный JSON, событие не запустит,
 * а ответ будет 200 — этого достаточно, чтобы доказать, что путь до панели
 * работает и секрет совпадает.
 *
 * Тонкость с hairpin NAT: из контейнера до собственного публичного домена
 * достучаться often нельзя — сеть провайдера не заворачивает трафик на тот же
 * публичный IP. Если публичный адрес недоступен, проверка идёт на локальный
 * порт приложения, а в результате это отмечается явно: «снаружи не проверено».
 */

export interface WebhookCertInfo {
  subject: string;
  issuer: string;
  validTo: string;
}

export interface WebhookCheckResult {
  /** Всё в порядке: endpoint отвечает 200, сертификат валиден. */
  ok: boolean;
  /** Человекочитаемая причина проблемы. */
  error: string | null;
  /** HTTP-статус ответа, если дошли. */
  status: number | null;
  /** Время ответа в миллисекундах. */
  responseMs: number | null;
  /** Данные сертификата, если смогли снять. */
  cert: WebhookCertInfo | null;
  /** Проверяли снаружи или изнутри (hairpin NAT). */
  checkedFrom: "external" | "local";
  /** Подсказка, что делать. */
  hint: string | null;
}

/** Снять данные сертификата сервера. */
function certInfo(host: string, timeoutMs = 8000): Promise<WebhookCertInfo | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: WebhookCertInfo | null) => {
      if (settled) return;
      settled = true;
      try {
        socket.end();
      } catch {
        /* сокет уже закрыт */
      }
      resolve(value);
    };
    const socket = tls.connect({ host, port: 443, servername: host, timeout: timeoutMs }, () => {
      const cert = socket.getPeerCertificate();
      if (!cert || !cert.issuer) return finish(null);
      // В node:tls поля CN и O бывают string | string[] — приводим к строке.
      const one = (v: string | string[] | undefined): string =>
        Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
      finish({
        subject: one(cert.subject?.CN),
        issuer: one(cert.issuer?.O) || one(cert.issuer?.CN),
        validTo: cert.valid_to ?? "",
      });
    });
    socket.on("error", () => finish(null));
    socket.on("timeout", () => {
      socket.destroy();
      finish(null);
    });
  });
}

/** POST с секретом — тот же запрос, что пришлёт MAX. */
async function probe(
  url: string,
  secret: string,
): Promise<{ status: number; ms: number; body: string }> {
  const started = Date.now();
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Max-Bot-Api-Secret": secret,
    },
    body: "{}",
    signal: AbortSignal.timeout(15_000),
  });
  const body = await res.text().catch(() => "");
  return { status: res.status, ms: Date.now() - started, body: body.slice(0, 300) };
}

export async function checkWebhookEndpoint(
  rawUrl: string,
  secret: string,
): Promise<WebhookCheckResult> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return {
      ok: false,
      error: "Адрес не разбирается",
      status: null,
      responseMs: null,
      cert: null,
      checkedFrom: "external",
      hint: null,
    };
  }

  if (url.protocol !== "https:") {
    return {
      ok: false,
      error: "MAX принимает только HTTPS-адреса",
      status: null,
      responseMs: null,
      cert: null,
      checkedFrom: "external",
      hint: "Укажите адрес с https://",
    };
  }
  if (url.port && url.port !== "443") {
    return {
      ok: false,
      error: `Порт ${url.port} MAX не использует — только 443`,
      status: null,
      responseMs: null,
      cert: null,
      checkedFrom: "external",
      hint: "Уберите порт из адреса.",
    };
  }

  const cert = await certInfo(url.hostname);

  // Сначала пробуем снаружи — так проверка выглядит для MAX.
  try {
    const res = await probe(rawUrl, secret);
    if (res.status === 200) {
      return {
        ok: true,
        error: null,
        status: res.status,
        responseMs: res.ms,
        cert,
        checkedFrom: "external",
        hint: null,
      };
    }
    if (res.status === 401) {
      return {
        ok: false,
        error: "Секрет не совпадает (401)",
        status: res.status,
        responseMs: res.ms,
        cert,
        checkedFrom: "external",
        hint: "Проверьте MAX_WEBHOOK_SECRET или выполните ротацию секрета.",
      };
    }
    return {
      ok: false,
      error: `Endpoint ответил ${res.status}: ${res.body}`,
      status: res.status,
      responseMs: res.ms,
      cert,
      checkedFrom: "external",
      hint: "MAX ожидает 200 в течение 30 секунд.",
    };
  } catch (err) {
    // Снаружи недостижимо — возможно, hairpin NAT. Пробуем локально.
    const local = `http://127.0.0.1:${process.env.PORT ?? 4200}${url.pathname}`;
    try {
      const res = await probe(local, secret);
      return {
        ok: res.status === 200,
        error:
          res.status === 200
            ? null
            : `Локально endpoint ответил ${res.status}: ${res.body}`,
        status: res.status,
        responseMs: res.ms,
        cert,
        checkedFrom: "local",
        hint:
          res.status === 200
            ? "Публичный адрес изнутри сервера недоступен (hairpin NAT) — снаружи проверьте вручную."
            : "Проверьте, что Caddy отдаёт 200 на /api/webhooks/max.",
      };
    } catch (inner) {
      return {
        ok: false,
        error: `Недоступен ни снаружи, ни локально: ${
          inner instanceof Error ? inner.message : String(inner)
        }`,
        status: null,
        responseMs: null,
        cert,
        checkedFrom: "external",
        hint:
          err instanceof Error && /ENOTFOUND|EAI_AGAIN/i.test(err.message)
            ? "Домен не резолвится с сервера — проверьте DNS."
            : "Проверьте, что контейнер app запущен и Caddy проксирует на него.",
      };
    }
  }
}
