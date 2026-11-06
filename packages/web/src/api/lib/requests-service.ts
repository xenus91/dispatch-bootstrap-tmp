import { and, desc, eq, inArray, isNull, like } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import {
  acceptedNotification,
  actionNotification,
  alertNotification,
  doneNotification,
  tripSummaryText,
} from "../max/messages";
import { notifyDispatchers } from "./notify";
import { getStops, listOperations, loadContext, snapshotOf, type RequestRow, type StopRow } from "./route";
import {
  currentStopOf,
  type DoneAction,
  isArrivalAction,
  isClosedStatus,
  nextAction,
  opEventKey,
  stopDone,
  stopSnapshot,
} from "./route-def";

type StaffRow = typeof schema.staff.$inferSelect;

/**
 * Следующий человекочитаемый номер заявки: З-2026-0001.
 *
 * Разрядность — 6 цифр, а не 4: при 4 цифрах после 9999 заявок за год
 * лексикографическая сортировка даёт «З-2026-9999» > «З-2026-10000», и счётчик
 * начинает считать назад. Шести цифр хватает на миллион заявок в год.
 *
 * Максимум ищется сравнением ЧИСЛА, а не строки: «З-2026-9» формально меньше
 * «З-2026-10», но номер 9 не встречается — он всегда дополнен нулями.
 */
const NUMBER_PAD = 6;

export async function nextRequestNumber(): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `З-${year}-`;
  const rows = await db
    .select({ number: schema.requests.number })
    .from(schema.requests)
    .where(like(schema.requests.number, `${prefix}%`));

  let max = 0;
  for (const row of rows) {
    const n = Number.parseInt(row.number.slice(prefix.length), 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  const seq = max + 1;
  return `${prefix}${String(seq).padStart(NUMBER_PAD, "0")}`;
}

export async function getRequest(id: number): Promise<RequestRow | null> {
  const [row] = await db.select().from(schema.requests).where(eq(schema.requests.id, id));
  return row ?? null;
}

export async function addHistory(entry: {
  requestId: number;
  status: string;
  actorKind?: "driver" | "dispatcher" | "system";
  actorId?: number | null;
  actorName?: string | null;
  comment?: string | null;
  latitude?: string | null;
  longitude?: string | null;
  stopId?: number | null;
  actionKey?: string | null;
}) {
  const [row] = await db
    .insert(schema.statusHistory)
    .values({
      requestId: entry.requestId,
      status: entry.status,
      actorKind: entry.actorKind ?? "system",
      actorId: entry.actorId ?? null,
      actorName: entry.actorName ?? null,
      comment: entry.comment ?? null,
      latitude: entry.latitude ?? null,
      longitude: entry.longitude ?? null,
      stopId: entry.stopId ?? null,
      actionKey: entry.actionKey ?? null,
    })
    .returning();
  return row;
}

/* ─────────────── маршрут ─────────────── */

export interface StopInput {
  /** id существующей остановки (при правке заявки) */
  id?: number | null;
  pointId: number;
  operationTypeId: number;
  plannedArrivalAt: Date | null;
}

/** Остановка уже начата водителем — менять её нельзя. */
export const stopLocked = (s: StopRow) => !!s.doneAt || stopDone(s).length > 0;

/**
 * Записать маршрут заявки. Пройденные/начатые остановки не меняются и должны
 * идти в начале списка; остальные обновляются, добавляются или удаляются.
 * Операция копируется в остановку (снимок) только при добавлении или смене операции.
 */
export async function syncStops(requestId: number, input: StopInput[]) {
  const existing = await getStops(requestId);
  const locked = existing.filter(stopLocked);
  const ops = new Map((await listOperations(true)).map((o) => [o.id, o]));

  for (const [i, s] of locked.entries()) {
    if (input[i]?.id !== s.id) {
      return { ok: false as const, error: "Пройденные остановки нельзя менять, удалять или переставлять" };
    }
  }
  const editable = input.slice(locked.length);
  for (const s of editable) {
    if (!ops.has(s.operationTypeId)) return { ok: false as const, error: "Операция не найдена" };
  }

  const keepIds = new Set(editable.map((s) => s.id).filter((id): id is number => !!id));
  const toDelete = existing.filter((s) => !stopLocked(s) && !keepIds.has(s.id)).map((s) => s.id);
  if (toDelete.length) await db.delete(schema.requestStops).where(inArray(schema.requestStops.id, toDelete));

  for (const [i, s] of editable.entries()) {
    const seq = locked.length + i + 1;
    const prev = s.id ? existing.find((e) => e.id === s.id && !stopLocked(e)) : undefined;
    const op = ops.get(s.operationTypeId)!;
    if (prev) {
      const planChanged = (prev.plannedArrivalAt?.getTime() ?? null) !== (s.plannedArrivalAt?.getTime() ?? null);
      await db
        .update(schema.requestStops)
        .set({
          seq,
          pointId: s.pointId,
          plannedArrivalAt: s.plannedArrivalAt,
          ...(prev.operationTypeId !== s.operationTypeId
            ? { operationTypeId: s.operationTypeId, operationSnapshotJson: JSON.stringify(snapshotOf(op)) }
            : {}),
          // Новое время — напоминание и тревога снова возможны.
          ...(planChanged ? { reminderSentAt: null, lateAlertAt: null } : {}),
        })
        .where(eq(schema.requestStops.id, prev.id));
    } else {
      await db.insert(schema.requestStops).values({
        requestId,
        seq,
        pointId: s.pointId,
        operationTypeId: s.operationTypeId,
        operationSnapshotJson: JSON.stringify(snapshotOf(op)),
        plannedArrivalAt: s.plannedArrivalAt,
      });
    }
  }
  for (const [i, s] of locked.entries()) {
    if (s.seq !== i + 1) await db.update(schema.requestStops).set({ seq: i + 1 }).where(eq(schema.requestStops.id, s.id));
  }

  const cur = currentStopOf(await getStops(requestId));
  await db
    .update(schema.requests)
    .set({ currentStopId: cur?.id ?? null, updatedAt: new Date() })
    .where(eq(schema.requests.id, requestId));
  return { ok: true as const };
}

/** Число файлов по остановкам заявки. */
export async function photoCountsByStop(requestId: number): Promise<Map<number, number>> {
  const rows = await db
    .select({ stopId: schema.attachments.stopId })
    .from(schema.attachments)
    .where(eq(schema.attachments.requestId, requestId));
  const map = new Map<number, number>();
  for (const r of rows) if (r.stopId) map.set(r.stopId, (map.get(r.stopId) ?? 0) + 1);
  return map;
}

/** Сколько файлов приложено к действию на остановке. */
export async function actionPhotoCount(stopId: number, actionKey: string): Promise<number> {
  const rows = await db
    .select({ id: schema.attachments.id })
    .from(schema.attachments)
    .where(and(eq(schema.attachments.stopId, stopId), eq(schema.attachments.actionKey, actionKey)));
  return rows.length;
}

/* ─────────────── действия водителя ─────────────── */

/** «Принял заявку»: одна кнопка на всю заявку. Повторное нажатие ничего не меняет. */
export async function acceptRequest(params: { request: RequestRow; driver: StaffRow }) {
  const { request, driver } = params;
  if (request.status !== "new" && request.status !== "assigned") {
    return { ok: false as const, stale: true as const, error: "Заявка уже принята" };
  }
  const [updated] = await db
    .update(schema.requests)
    .set({ status: "accepted", acceptedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(schema.requests.id, request.id), inArray(schema.requests.status, ["new", "assigned"])))
    .returning();
  if (!updated) return { ok: false as const, stale: true as const, error: "Заявка уже принята" };

  await addHistory({
    requestId: request.id,
    status: "accepted",
    actorKind: "driver",
    actorId: driver.id,
    actorName: driver.fullName,
  });
  const ctx = await loadContext(updated);
  await notifyDispatchers(acceptedNotification(ctx, driver.fullName), {
    event: "accepted",
    request: updated,
    excludeStaffId: driver.id,
  });
  return { ok: true as const, request: updated, ctx };
}

/**
 * Отметить действие на остановке. Срабатывает только для следующего по порядку
 * действия текущей остановки (защита от двойных нажатий и устаревших кнопок):
 * условная запись по прежнему `done_actions_json`.
 */
export async function applyAction(params: {
  request: RequestRow;
  driver: StaffRow;
  stopId: number;
  actionKey: string;
}) {
  const { request, driver, stopId, actionKey } = params;
  if (request.status !== "accepted" && request.status !== "in_progress") {
    return { ok: false as const, stale: true as const, error: "Заявка не в работе" };
  }
  const stops = await getStops(request.id);
  const stop = stops.find((s) => s.id === stopId);
  const current = currentStopOf(stops);
  if (!stop || !current || current.id !== stop.id) {
    return { ok: false as const, stale: true as const, error: "Уже отмечено" };
  }
  const action = nextAction(stop);
  if (!action || action.key !== actionKey) {
    return { ok: false as const, stale: true as const, error: "Уже отмечено" };
  }
  const photos = await actionPhotoCount(stop.id, action.key);
  if (action.photoRequired && photos < 1) {
    return { ok: false as const, needPhoto: true as const, action, stop, error: `Нужно фото: ${action.photoHint}` };
  }

  const now = new Date();
  const snapshot = stopSnapshot(stop);
  const done: DoneAction[] = [...stopDone(stop), { key: action.key, at: now.toISOString(), photos, byId: driver.id }];
  const finishedStop = snapshot.actions.every((a) => done.some((d) => d.key === a.key));
  const [savedStop] = await db
    .update(schema.requestStops)
    .set({
      doneActionsJson: JSON.stringify(done),
      ...(isArrivalAction(snapshot, action.key) && !stop.arrivedAt ? { arrivedAt: now } : {}),
      ...(finishedStop ? { doneAt: now } : {}),
    })
    .where(and(eq(schema.requestStops.id, stop.id), eq(schema.requestStops.doneActionsJson, stop.doneActionsJson)))
    .returning();
  if (!savedStop) return { ok: false as const, stale: true as const, error: "Уже отмечено" };

  const nextStop = finishedStop ? (stops.find((s) => s.seq > stop.seq && !s.doneAt) ?? null) : savedStop;
  const finishedTrip = finishedStop && !nextStop;
  const [updated] = await db
    .update(schema.requests)
    .set({
      status: finishedTrip ? "done" : "in_progress",
      currentStopId: nextStop?.id ?? null,
      ...(request.status === "accepted" ? { startedAt: request.startedAt ?? now } : {}),
      ...(finishedTrip ? { completedAt: now } : {}),
      updatedAt: now,
    })
    .where(eq(schema.requests.id, request.id))
    .returning();

  await addHistory({
    requestId: request.id,
    status: "action",
    actorKind: "driver",
    actorId: driver.id,
    actorName: driver.fullName,
    comment: action.label,
    stopId: stop.id,
    actionKey: action.key,
  });
  if (finishedTrip) {
    await addHistory({ requestId: request.id, status: "done", actorKind: "driver", actorId: driver.id, actorName: driver.fullName });
  }

  const ctx = await loadContext(updated!);
  const view = ctx.stops.find((v) => v.stop.id === stop.id)!;
  let summary: string | null = null;
  if (finishedTrip) {
    const counts = await photoCountsByStop(request.id);
    summary = tripSummaryText(ctx, counts);
    await notifyDispatchers(doneNotification(ctx, driver.fullName, counts), {
      event: "done",
      request: updated,
      excludeStaffId: driver.id,
    });
  } else {
    await notifyDispatchers(actionNotification({ ctx, view, action, driverName: driver.fullName, photos }), {
      event: opEventKey(snapshot.id, action.key),
      request: updated,
      excludeStaffId: driver.id,
    });
  }
  return { ok: true as const, request: updated!, ctx, action, view, finishedStop, finishedTrip, summary };
}

/* ─────────────── тревоги ─────────────── */

const ALERT_EVENT: Record<string, string> = {
  failure: "alert_failure",
  late: "alert_late",
  stop_late: "alert_stop_late",
  no_contact: "alert_late",
  security: "security",
};

/** Тревожное событие — выделенное уведомление диспетчерам. */
export async function raiseAlert(params: {
  request: RequestRow;
  type: "late" | "failure" | "security" | "no_contact" | "stop_late";
  raisedBy?: StaffRow | null;
  message?: string | null;
  stopId?: number | null;
  /** Для системных тревог: водитель заявки (имя/телефон в уведомлении) */
  driver?: StaffRow | null;
}) {
  const { request, type, raisedBy, message } = params;
  const ctx = await loadContext(request);
  const stopId = params.stopId ?? ctx.current?.stop.id ?? null;

  // Повтор той же тревоги, пока её не подтвердили, — без новой рассылки.
  const [open] = await db
    .select()
    .from(schema.alerts)
    .where(
      and(
        eq(schema.alerts.requestId, request.id),
        eq(schema.alerts.type, type),
        isNull(schema.alerts.acknowledgedAt),
        ...(type === "stop_late" && stopId ? [eq(schema.alerts.stopId, stopId)] : []),
      ),
    )
    .limit(1);
  if (open) return { alert: open, duplicate: true as const };

  const [alert] = await db
    .insert(schema.alerts)
    .values({
      requestId: request.id,
      type,
      stopId,
      message: message ?? null,
      raisedById: raisedBy?.id ?? null,
      raisedByName: raisedBy?.fullName ?? null,
    })
    .returning();

  await addHistory({
    requestId: request.id,
    status: `alert_${type === "no_contact" ? "no_contact" : type}`,
    actorKind: raisedBy ? (raisedBy.role === "driver" || raisedBy.id === request.driverId ? "driver" : "dispatcher") : "system",
    actorId: raisedBy?.id ?? null,
    actorName: raisedBy?.fullName ?? null,
    comment: message ?? null,
    stopId,
  });

  const person = params.driver ?? raisedBy ?? null;
  const view = ctx.stops.find((v) => v.stop.id === stopId) ?? null;
  await notifyDispatchers(
    alertNotification({
      ctx,
      type,
      view,
      driverName: person?.fullName ?? "—",
      driverPhone: person?.phone ?? null,
      message,
    }),
    // Тот, кто поднял тревогу (диспетчер из панели или админ на тестовом рейсе), сам её не получает.
    { event: ALERT_EVENT[type] ?? "alert_late", request, excludeStaffId: raisedBy?.id },
  );

  return { alert, duplicate: false as const };
}

export async function addAttachment(entry: {
  requestId: number;
  historyId?: number | null;
  uploadedById?: number | null;
  kind: string;
  fileName?: string | null;
  maxToken?: string | null;
  maxUrl?: string | null;
  sizeBytes?: number | null;
  stopId?: number | null;
  actionKey?: string | null;
}) {
  const [row] = await db
    .insert(schema.attachments)
    .values({
      requestId: entry.requestId,
      historyId: entry.historyId ?? null,
      uploadedById: entry.uploadedById ?? null,
      kind: entry.kind,
      fileName: entry.fileName ?? null,
      maxToken: entry.maxToken ?? null,
      maxUrl: entry.maxUrl ?? null,
      sizeBytes: entry.sizeBytes ?? null,
      stopId: entry.stopId ?? null,
      actionKey: entry.actionKey ?? null,
    })
    .returning();
  return row;
}

/** Активная заявка водителя — та, по которой он сейчас работает. */
export async function activeRequestForDriver(driverId: number): Promise<RequestRow | null> {
  const rows = await db
    .select()
    .from(schema.requests)
    .where(eq(schema.requests.driverId, driverId))
    .orderBy(desc(schema.requests.updatedAt));
  return rows.find((r) => !isClosedStatus(r.status)) ?? null;
}
