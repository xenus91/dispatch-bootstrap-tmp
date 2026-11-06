import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Проверка стартовых параметров мини-приложения MAX (WebAppData).
 *
 * Алгоритм — по документации dev.max.ru/docs/webapps/validation:
 *   secret_key = HMAC_SHA256(key: "WebAppData", data: BOT_TOKEN)
 *   hash       = hex(HMAC_SHA256(key: secret_key, data: launch_params))
 * где launch_params — пары key=value без hash, значения URL-декодированы,
 * ключи отсортированы a→z, разделитель \n.
 *
 * Без этой проверки мини-приложение нельзя считать доверенным источником
 * личности: initData приходит с клиента и подделывается тривиально.
 */

const TOKEN = process.env.MAX_BOT_TOKEN ?? "";
/** Данные старше этого срока считаем просроченными (рекомендация MAX — 1 час). */
const MAX_AGE_SEC = 3600;

export interface MaxInitDataUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string | null;
}

export interface VerifiedInitData {
  user: MaxInitDataUser;
  chatId: string | null;
  authDate: number;
  startParam: string | null;
  queryId: string | null;
}

export type InitDataResult =
  | { ok: true; data: VerifiedInitData }
  | { ok: false; error: string };

function hmac(key: Buffer | string, data: string) {
  return createHmac("sha256", key).update(data).digest();
}

function equalHex(a: string, b: string) {
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (ab.length === 0 || ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Принимает как «сырую» строку WebAppData (`user=...&hash=...`),
 * так и полный URL/фрагмент с `#WebAppData=...` — клиенты MAX отдают
 * initData в первом виде, но подстраховываемся.
 */
function extractAppData(raw: string): string {
  const trimmed = raw.trim();
  const fragment = trimmed.includes("#") ? trimmed.slice(trimmed.indexOf("#") + 1) : trimmed;
  if (fragment.includes("WebAppData=")) {
    const params = new URLSearchParams(fragment);
    return params.get("WebAppData") ?? "";
  }
  return fragment;
}

export function verifyInitData(raw: string): InitDataResult {
  if (!TOKEN) return { ok: false, error: "Токен бота не настроен — проверить подпись MAX нельзя." };
  const appData = extractAppData(raw ?? "");
  if (!appData) return { ok: false, error: "Пустые стартовые параметры." };

  const pairs = appData
    .split("&")
    .filter(Boolean)
    .map((chunk) => {
      const i = chunk.indexOf("=");
      return i === -1 ? [chunk, ""] : [chunk.slice(0, i), chunk.slice(i + 1)];
    }) as [string, string][];

  const hashes = pairs.filter(([k]) => k === "hash");
  if (hashes.length !== 1) return { ok: false, error: "Параметр hash отсутствует или дублируется." };
  const originalHash = hashes[0]?.[1] ?? "";
  if (!originalHash) return { ok: false, error: "Пустой hash." };

  const decoded = pairs.map(([k, v]) => {
    let value = v;
    try {
      value = decodeURIComponent(v);
    } catch {
      /* значение уже декодировано */
    }
    return [k, value] as [string, string];
  });

  // Ключи должны встречаться ровно один раз — иначе строку подписи можно подменить.
  const seen = new Set<string>();
  for (const [k] of decoded) {
    if (seen.has(k)) return { ok: false, error: `Дублирующийся параметр: ${k}` };
    seen.add(k);
  }

  const launchParams = decoded
    .filter(([k]) => k !== "hash")
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  const secretKey = hmac("WebAppData", TOKEN);
  const signature = hmac(secretKey, launchParams).toString("hex");
  if (!equalHex(signature, originalHash)) {
    return { ok: false, error: "Подпись стартовых параметров не совпала." };
  }

  const map = new Map(decoded);
  const authDate = Number.parseInt(map.get("auth_date") ?? "0", 10);
  if (!Number.isFinite(authDate) || authDate <= 0) {
    return { ok: false, error: "Некорректный auth_date." };
  }
  const ageSec = Math.floor(Date.now() / 1000) - authDate;
  if (ageSec > MAX_AGE_SEC) {
    return { ok: false, error: "Стартовые параметры просрочены — перезапустите мини-приложение." };
  }

  let user: MaxInitDataUser | null = null;
  try {
    const parsed = JSON.parse(map.get("user") ?? "null") as MaxInitDataUser | null;
    if (parsed && Number.isFinite(Number(parsed.id))) user = parsed;
  } catch {
    /* разбор ниже */
  }
  if (!user) return { ok: false, error: "В стартовых параметрах нет пользователя." };

  let chatId: string | null = null;
  try {
    const chat = JSON.parse(map.get("chat") ?? "null") as { id?: number } | null;
    if (chat?.id !== undefined) chatId = String(chat.id);
  } catch {
    /* ignore */
  }

  return {
    ok: true,
    data: {
      user,
      chatId,
      authDate,
      startParam: map.get("start_param") ?? null,
      queryId: map.get("query_id") ?? null,
    },
  };
}

/**
 * Проверка номера телефона, полученного через WebApp.requestContact():
 * hash = HMAC_SHA256(botToken, "authDate=..\nphone=..\nuserId=..") — параметры
 * в алфавитном порядке, phone без «+».
 */
export function verifyContactHash(input: {
  phone: string;
  authDate: string | number;
  hash: string;
  userId: string | number;
}): boolean {
  if (!TOKEN) return false;
  const phone = String(input.phone).replace(/[^\d]/g, "");
  const payload = [
    `authDate=${input.authDate}`,
    `phone=${phone}`,
    `userId=${input.userId}`,
  ].join("\n");
  const expected = createHmac("sha256", TOKEN).update(payload).digest("hex");
  return equalHex(expected, String(input.hash));
}
