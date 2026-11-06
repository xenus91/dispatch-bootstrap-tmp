import { and, eq, inArray, isNotNull, isNull, lt } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { reminderMessage } from "../max/messages";
import { claimWindow, purgeProcessedUpdates } from "../max/dedupe";
import { runAccessChecks } from "./access";
import { notifyDispatchers, notifyStaff } from "./notify";
import { addHistory, raiseAlert } from "./requests-service";
import { getStops, loadContext } from "./route";
import { ALERT_LABELS, stopDone } from "./route-def";
import { getReminderMinutes, getSetting, getStopLateMinutes, setSetting } from "./settings";

const TICK_MS = 60_000;
const DAY_MS = 86_400_000;


/**
 * По остановкам маршрута: напоминание водителю за N минут до планового прибытия
 * и тревога диспетчерам, если через M минут после плана остановка не начата.
 * И то и другое — не чаще одного раза на остановку (reminder_sent_at / late_alert_at).
 */
export async function runStopTimers() {
  const [defaultReminder, lateMinutes] = await Promise.all([getReminderMinutes(), getStopLateMinutes()]);
  const requests = await db
    .select()
    .from(schema.requests)
    .where(
      and(
        inArray(schema.requests.status, ["assigned", "accepted", "in_progress"]),
        isNotNull(schema.requests.driverId),
      ),
    );
  const now = Date.now();

  for (const request of requests) {
    if (!request.driverId) continue;
    const stops = (await getStops(request.id)).filter((s) => !s.doneAt);
    const current = stops[0];
    const reminderMinutes = request.reminderMinutes ?? defaultReminder;

    for (const stop of stops) {
      const planned = stop.plannedArrivalAt?.getTime();
      if (!planned || stop.reminderSentAt || stop.arrivedAt || stopDone(stop).length) continue;
      // Только до планового времени: после него напоминание бессмысленно (например,
      // после простоя сервера) — просрочку покрывает тревога stop_late.
      if (now < planned - reminderMinutes * 60_000 || now > planned) continue;
      // Отметка до отправки: при сбое доставки повторов не будет.
      const [claimed] = await db
        .update(schema.requestStops)
        .set({ reminderSentAt: new Date() })
        .where(and(eq(schema.requestStops.id, stop.id), isNull(schema.requestStops.reminderSentAt)))
        .returning();
      if (!claimed) continue;
      const ctx = await loadContext(request);
      const view = ctx.stops.find((v) => v.stop.id === stop.id);
      if (!view) continue;
      const left = Math.max(0, Math.round((planned - now) / 60_000));
      const result = await notifyStaff(request.driverId, reminderMessage(ctx, view, left));
      await addHistory({
        requestId: request.id,
        status: "reminder",
        actorKind: "system",
        stopId: stop.id,
        comment: `Напоминание за ${reminderMinutes} мин${result.ok ? "" : ` (ошибка доставки: ${result.error ?? "неизвестно"})`}`,
      });
    }

    // Тревога — только по текущей (первой непройденной) остановке, если она не начата.
    const planned = current?.plannedArrivalAt?.getTime();
    if (!current || !planned || current.lateAlertAt || current.arrivedAt || stopDone(current).length) continue;
    if (now < planned + lateMinutes * 60_000 || now > planned + DAY_MS) continue;
    const [claimed] = await db
      .update(schema.requestStops)
      .set({ lateAlertAt: new Date() })
      .where(and(eq(schema.requestStops.id, current.id), isNull(schema.requestStops.lateAlertAt)))
      .returning();
    if (!claimed) continue;
    const [driver] = await db.select().from(schema.staff).where(eq(schema.staff.id, request.driverId));
    await raiseAlert({
      request,
      type: "stop_late",
      stopId: current.id,
      driver: driver ?? null,
      message: `Нет отметки через ${lateMinutes} мин после планового прибытия`,
    });
  }
}

/** Повторный пинг диспетчерам по тревогам, которые долго не подтверждены. */
async function runAlertEscalation() {
  const minutesRaw = await getSetting("alertEscalateMinutes");
  const minutes = Number.parseInt(minutesRaw, 10);
  if (!Number.isFinite(minutes) || minutes <= 0) return;

  const open = await db.select().from(schema.alerts).where(isNull(schema.alerts.acknowledgedAt));
  for (const alert of open) {
    if (Date.now() - alert.createdAt.getTime() < minutes * 60_000) continue;
    // Отметка в БД, а не в памяти: процесс может перезапускаться — повторного пинга не будет.
    if (!(await claimWindow(`esc:${alert.id}`, 3 * DAY_MS))) continue;
    const [request] = await db
      .select()
      .from(schema.requests)
      .where(eq(schema.requests.id, alert.requestId));
    await notifyDispatchers({
      text:
        `❗️ *Тревога не подтверждена ${minutes} мин*\n` +
        `Заявка ${request?.number ?? alert.requestId} · ${ALERT_LABELS[alert.type] ?? alert.type}\n` +
        (alert.raisedByName ? `Поднял: ${alert.raisedByName}\n` : "") +
        `Подтвердите сигнал в панели диспетчеризации.`,
      format: "markdown",
    }, { event: "alert_escalation", request });
  }
}

let running: Promise<void> | null = null;
let lastStartedAt = 0;

export type TickSource = "interval" | "self" | "cron" | "boot";

/**
 * Один проход планировщика. Вызывается таймером процесса, внешним cron (/api/cron/tick)
 *. Параллельные вызовы склеиваются,
 * а все отметки (напоминание, тревога, эскалация) захватываются в БД — повторов нет.
 */
export function runSchedulerTick(source: TickSource = "interval"): Promise<void> {
  if (running) return running;
  // Самопинг и внешний cron могут прийти почти одновременно с таймером — один проход в 20 с.
  if (source !== "boot" && Date.now() - lastStartedAt < 20_000) return Promise.resolve();
  lastStartedAt = Date.now();
  running = tick()
    .then(() => setSetting("scheduler:heartbeat", JSON.stringify({ at: new Date().toISOString(), source })))
    .catch((e) => console.error("[scheduler] heartbeat:", describeError(e)))
    .finally(() => {
      running = null;
    });
  return running;
}

/** Последний проход планировщика — для индикатора в настройках. */
export async function schedulerHeartbeat(): Promise<{ at: string | null; source: string | null }> {
  try {
    const v = JSON.parse((await getSetting("scheduler:heartbeat")) || "{}") as { at?: string; source?: string };
    return { at: v.at ?? null, source: v.source ?? null };
  } catch {
    return { at: null, source: null };
  }
}

/**
 * Публичный адрес, через который процесс будит сам себя. Хостинг усыпляет приложение
 * без входящих запросов; запрос через внешний адрес считается входящим трафиком,
 * поэтому раз в минуту процесс стучится в свой /api/cron/tick — и не засыпает,
 * а проход планировщика идёт независимо от того, открыт ли кто-то приложение.
 */
function selfPingUrl(): string | null {
  const base = (process.env.SCHEDULER_SELF_URL || process.env.WEBSITE_URL || "").replace(/\/+$/, "");
  const key = process.env.CRON_SECRET || process.env.MAX_WEBHOOK_SECRET || "";
  if (!base.startsWith("https://") || !key || process.env.SCHEDULER_SELF_PING === "0") return null;
  return `${base}/api/cron/tick?key=${encodeURIComponent(key)}&src=self`;
}

async function beat() {
  const url = selfPingUrl();
  if (url) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(45_000) });
      if (res.ok) return; // проход уже выполнен обработчиком запроса
      console.warn(`[scheduler] самопинг: HTTP ${res.status}, проход локально`);
    } catch (e) {
      console.warn("[scheduler] самопинг не удался, проход локально:", e instanceof Error ? e.message : e);
    }
  }
  await runSchedulerTick("interval");
}

/** Сообщение ошибки вместе с цепочкой cause (drizzle прячет сетевую причину туда). */
function describeError(e: unknown): string {
  const parts: string[] = [];
  let cur: unknown = e;
  for (let i = 0; cur && i < 5; i++) {
    if (cur instanceof Error) {
      const code = (cur as { code?: string }).code;
      parts.push(`${cur.message.split("\n")[0].slice(0, 200)}${code ? ` [${code}]` : ""}`);
      cur = (cur as { cause?: unknown }).cause;
    } else {
      parts.push(String(cur));
      break;
    }
  }
  return parts.join(" ← ");
}

/** Журнал доставки вебхуков: 14 дней хватает для разбора инцидентов. */
async function purgeWebhookEvents() {
  await db
    .delete(schema.webhookEvents)
    .where(lt(schema.webhookEvents.createdAt, new Date(Date.now() - 14 * 86_400_000)));
}

async function tick() {
  try {
    await runStopTimers();
    await runAlertEscalation();
    await runAccessChecks();
    await purgeProcessedUpdates();
    await purgeWebhookEvents();
  } catch (e) {
    console.error("[scheduler] tick failed:", describeError(e));
  }
}

/** Запускается один раз на процесс (защита от повторного запуска при hot-reload). */
export function startScheduler() {
  const g = globalThis as unknown as { __maxDispatchScheduler?: ReturnType<typeof setInterval> };
  if (g.__maxDispatchScheduler) return;
  g.__maxDispatchScheduler = setInterval(() => void beat(), TICK_MS);
  void runSchedulerTick("boot");
  const url = selfPingUrl();
  console.log(
    `[scheduler] планировщик запущен${url ? `, самопинг через ${new URL(url).origin}` : " (без самопинга: нет WEBSITE_URL/секрета)"}`,
  );
}
