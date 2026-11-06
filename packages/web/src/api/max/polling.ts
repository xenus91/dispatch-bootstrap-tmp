import { getSetting, setSetting } from "../lib/settings";
import { maxFetch } from "./tls";
import { isStubMode, maxConfig } from "./client";
import type { MaxUpdate } from "./types";
import { claimUpdate } from "./dedupe";
import { handleUpdate } from "./webhook";

/**
 * Long Polling (GET /updates) — способ получать события без публичного HTTPS.
 * MAX прямо указывает: это только для разработки и тестирования, в продакшене
 * работает вебхук (POST /subscriptions). Включается через MAX_LONG_POLLING=1
 * и автоматически выключается, если у бота уже есть подписка на вебхук.
 *
 * Маркер (указатель на следующее непрочитанное событие) храним в settings,
 * чтобы перезапуск сервера не терял и не дублировал события.
 */

const MARKER_KEY = "maxUpdatesMarker";
const TIMEOUT_SEC = 30;
const LIMIT = 100;

/**
 * Состояние цикла живёт в globalThis, а не в переменной модуля: при hot-reload
 * Vite заново выполняет модуль, и модульный флаг сбрасывался — запускался второй,
 * третий цикл с тем же маркером, и каждое событие обрабатывалось несколько раз.
 * Теперь новый запуск забирает «эстафету», а старый цикл завершается сам.
 */
interface PollingState {
  activeId: number;
  seq: number;
}
const g = globalThis as unknown as { __maxDispatchPolling?: PollingState };
const state = (g.__maxDispatchPolling ??= { activeId: 0, seq: 0 });

function errText(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as { cause?: unknown }).cause;
  const first = err.message.split("\n")[0];
  return cause instanceof Error ? `${first} — ${cause.message}` : first;
}

/** Сохранение маркера с повтором: потерянный маркер = повторная обработка после рестарта. */
async function saveMarker(value: number) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await setSetting(MARKER_KEY, String(value));
      return;
    } catch (err) {
      if (attempt === 3) console.error("[max] не удалось сохранить маркер:", errText(err));
      else await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
}

interface UpdateList {
  updates: MaxUpdate[];
  marker?: number | null;
}

async function fetchUpdates(marker: number | null): Promise<UpdateList> {
  const url = new URL(`${maxConfig.baseUrl}/updates`);
  url.searchParams.set("limit", String(LIMIT));
  url.searchParams.set("timeout", String(TIMEOUT_SEC));
  if (marker !== null) url.searchParams.set("marker", String(marker));

  const res = await maxFetch(url, {
    headers: { Authorization: process.env.MAX_BOT_TOKEN ?? "" },
    signal: AbortSignal.timeout((TIMEOUT_SEC + 15) * 1000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GET /updates → ${res.status}: ${text.slice(0, 200)}`);
  return (text ? JSON.parse(text) : { updates: [] }) as UpdateList;
}

async function loadMarker(): Promise<number | null> {
  const raw = await getSetting(MARKER_KEY);
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Запуск фонового цикла опроса. Безопасно вызывать повторно (в т.ч. при hot-reload):
 * активен всегда только последний цикл, предыдущий выходит после текущего запроса.
 * Пересечение на время одного запроса закрывает claimUpdate (дедупликация в БД).
 */
export function startLongPolling() {
  if (isStubMode()) {
    console.log("[max] long polling не запущен: режим заглушки");
    return;
  }
  const myId = ++state.seq;
  const takeover = state.activeId !== 0;
  state.activeId = myId;
  console.log(`[max] long polling ${takeover ? "перезапущен после обновления кода" : "запущен"} (режим разработки)`);

  const alive = () => state.activeId === myId;

  void (async () => {
    let marker = await loadMarker().catch(() => null);
    let backoff = 1000;

    while (alive()) {
      try {
        const { updates, marker: next } = await fetchUpdates(marker);
        backoff = 1000;

        for (const update of updates) {
          try {
            if (!(await claimUpdate(update))) continue;
            await handleUpdate(update);
          } catch (err) {
            console.error("[max] ошибка обработки события", update.update_type, err);
          }
        }

        if (typeof next === "number") {
          marker = next;
          await saveMarker(next);
        }
      } catch (err) {
        const msg = errText(err);
        // Таймаут длинного опроса — нормальная ситуация, не шумим.
        if (!/timeout|aborted|TimeoutError/i.test(msg)) {
          console.error("[max] long polling:", msg);
        }
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
  })();
}

export function stopLongPolling() {
  state.activeId = 0;
}

export const longPollingEnabled = () => process.env.MAX_LONG_POLLING === "1" && !isStubMode();
