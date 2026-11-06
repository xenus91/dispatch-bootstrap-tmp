import { ORPCError } from "@orpc/server";
import { and, desc, eq, inArray, isNull, notInArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "../database";
import * as schema from "../database/schema";
import { dispatcherOnly } from "../lib/auth";
import { notifyStaff, refreshDriverCard, reissueDriverCard, sendDriverCard } from "../lib/notify";
import {
  addHistory,
  getRequest,
  nextRequestNumber,
  raiseAlert,
  type StopInput,
  syncStops,
} from "../lib/requests-service";
import { listOperations, loadContext, type RequestContext } from "../lib/route";
import { CLOSED_STATUSES, isClosedStatus, isRunning, pointKindLabel } from "../lib/route-def";

const stopInput = z.object({
  id: z.number().optional().nullable(),
  pointId: z.number({ error: "Выберите пункт" }),
  operationTypeId: z.number({ error: "Выберите операцию" }),
  /** ISO-строка из формы */
  plannedArrivalAt: z.string().optional().nullable(),
});

const requestInput = z.object({
  requestTypeId: z.number({ error: "Выберите тип заявки" }),
  clientId: z.number({ error: "Выберите клиента" }),
  containerNo: z.string().trim().min(4, "Укажите номер контейнера").max(20),
  containerTypeId: z.number({ error: "Выберите тип контейнера" }),
  cargoWeightT: z.number().positive("Укажите вес, т").max(100),
  comment: z.string().max(2000).optional().nullable(),
  driverId: z.number().nullable().optional(),
  reminderMinutes: z.number().min(5).max(2880).nullable().optional(),
  stops: z.array(stopInput).min(1, "Добавьте хотя бы одну остановку").max(20),
});

function toDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Проверка справочников и маршрута. Возвращает поля заявки, остановки и предупреждения. */
async function validateInput(input: z.infer<typeof requestInput>) {
  const [rt] = await db.select().from(schema.requestTypes).where(eq(schema.requestTypes.id, input.requestTypeId));
  if (!rt) throw new ORPCError("BAD_REQUEST", { message: "Тип заявки не найден" });
  const [client] = await db.select().from(schema.clients).where(eq(schema.clients.id, input.clientId));
  if (!client) throw new ORPCError("BAD_REQUEST", { message: "Клиент не найден" });
  const [ct] = await db.select().from(schema.containerTypes).where(eq(schema.containerTypes.id, input.containerTypeId));
  if (!ct) throw new ORPCError("BAD_REQUEST", { message: "Тип контейнера не найден" });

  const pointIds = [...new Set(input.stops.map((s) => s.pointId))];
  const pts = await db.select().from(schema.points).where(inArray(schema.points.id, pointIds));
  const ops = new Map((await listOperations(true)).map((o) => [o.id, o]));
  const stops: StopInput[] = [];
  const warnings: string[] = [];
  let prev: Date | null = null;
  for (const [i, s] of input.stops.entries()) {
    const n = i + 1;
    const point = pts.find((p) => p.id === s.pointId);
    if (!point) throw new ORPCError("BAD_REQUEST", { message: `Остановка ${n}: пункт не найден` });
    const op = ops.get(s.operationTypeId);
    if (!op) throw new ORPCError("BAD_REQUEST", { message: `Остановка ${n}: операция не найдена` });
    if (op.pointKinds.length && !op.pointKinds.includes(point.kind)) {
      throw new ORPCError("BAD_REQUEST", {
        message: `Остановка ${n}: операция «${op.name}» недоступна для пункта вида «${pointKindLabel(point.kind)}»`,
      });
    }
    const planned = toDate(s.plannedArrivalAt);
    if (planned && prev && planned < prev) warnings.push(`Остановка ${n}: время прибытия раньше предыдущей`);
    if (planned) prev = planned;
    stops.push({ id: s.id ?? null, pointId: s.pointId, operationTypeId: s.operationTypeId, plannedArrivalAt: planned });
  }
  return {
    values: {
      requestTypeId: rt.id,
      clientId: client.id,
      containerNo: input.containerNo.trim().toUpperCase().replace(/\s+/g, ""),
      containerTypeId: ct.id,
      cargoWeightT: Math.round(input.cargoWeightT * 1000) / 1000,
      comment: input.comment?.trim() || null,
      reminderMinutes: input.reminderMinutes ?? null,
    },
    stops,
    warnings,
  };
}

/** Сериализуемая карточка маршрута для панели. */
function routeView(ctx: RequestContext) {
  return {
    client: ctx.client,
    containerCode: ctx.containerCode,
    typeName: ctx.typeName,
    currentStopId: ctx.current?.stop.id ?? null,
    stops: ctx.stops.map((v) => ({
      ...v.stop,
      point: v.point,
      operationName: v.snapshot.name,
      actions: v.snapshot.actions,
      extraActions: v.snapshot.extraActions,
      done: v.done,
      index: v.index,
      total: v.total,
    })),
  };
}

/** Остановка просрочена: плановое время прошло, водитель её не начал. */
function isStopLate(ctx: RequestContext) {
  const v = ctx.current;
  const planned = v?.stop.plannedArrivalAt?.getTime();
  return !!planned && !isClosedStatus(ctx.request.status) && !v!.stop.arrivedAt && !v!.done.length && planned < Date.now();
}

/**
 * Исполнитель заявки — водитель. Исключение для тестов: администратор может
 * назначить рейс на себя (только на себя), чтобы пройти весь процесс в боте.
 */
async function assertAssignable(driverId: number, actor: { id: number; role: string }) {
  const [driver] = await db.select().from(schema.staff).where(eq(schema.staff.id, driverId));
  const selfTest = !!driver && driver.role === "admin" && actor.role === "admin" && driver.id === actor.id;
  if (!driver || (driver.role !== "driver" && !selfTest)) {
    throw new ORPCError("BAD_REQUEST", { message: "Водитель не найден" });
  }
  if (driver.status === "blocked") {
    throw new ORPCError("BAD_REQUEST", { message: `${driver.fullName} заблокирован — назначение невозможно` });
  }
  // Водителя без регистрации в боте назначить можно: карточка заявки уйдёт ему
  // автоматически сразу после активации по инвайт-ссылке.
  return driver;
}

export const requests = {
  /** Список заявок: тип, клиент, контейнер, текущая остановка, водитель, тревоги. */
  list: dispatcherOnly
    .input(
      z
        .object({
          scope: z.enum(["active", "all", "archive"]).default("active"),
          status: z.string().min(1).max(32).optional(),
          clientId: z.number().optional(),
          requestTypeId: z.number().optional(),
        })
        .optional(),
    )
    .handler(async ({ input }) => {
      const scope = input?.scope ?? "active";
      let rows = input?.status
        ? await db.select().from(schema.requests).where(eq(schema.requests.status, input.status))
        : scope === "active"
          ? await db.select().from(schema.requests).where(notInArray(schema.requests.status, [...CLOSED_STATUSES]))
          : scope === "archive"
            ? await db.select().from(schema.requests).where(inArray(schema.requests.status, [...CLOSED_STATUSES]))
            : await db.select().from(schema.requests);
      if (input?.clientId) rows = rows.filter((r) => r.clientId === input.clientId);
      if (input?.requestTypeId) rows = rows.filter((r) => r.requestTypeId === input.requestTypeId);

      const driverIds = [...new Set(rows.map((r) => r.driverId).filter((v): v is number => !!v))];
      const drivers = driverIds.length
        ? await db.select().from(schema.staff).where(inArray(schema.staff.id, driverIds))
        : [];
      const openAlerts = await db.select().from(schema.alerts).where(isNull(schema.alerts.acknowledgedAt));
      const contexts = await Promise.all(rows.map((r) => loadContext(r)));

      return contexts
        .map((ctx) => {
          const row = ctx.request;
          const driver = drivers.find((d) => d.id === row.driverId);
          const cur = ctx.current;
          return {
            ...row,
            clientName: ctx.client?.name ?? null,
            typeName: ctx.typeName,
            containerCode: ctx.containerCode,
            stopsTotal: ctx.stops.length,
            stopsDone: ctx.stops.filter((v) => v.stop.doneAt).length,
            currentStop: cur
              ? {
                  id: cur.stop.id,
                  index: cur.index,
                  pointName: cur.point?.name ?? null,
                  pointKind: cur.point?.kind ?? null,
                  operationName: cur.snapshot.name,
                  plannedArrivalAt: cur.stop.plannedArrivalAt,
                  arrivedAt: cur.stop.arrivedAt,
                }
              : null,
            nextPlannedAt: cur?.stop.plannedArrivalAt ?? null,
            driverName: driver?.fullName ?? null,
            driverPhone: driver?.phone ?? null,
            driverVehicle: driver?.vehicle ?? null,
            openAlertTypes: openAlerts.filter((a) => a.requestId === row.id).map((a) => a.type),
            isLate: isStopLate(ctx),
          };
        })
        .sort((a, b) => {
          const aAlert = a.openAlertTypes.length ? 1 : 0;
          const bAlert = b.openAlertTypes.length ? 1 : 0;
          if (aAlert !== bAlert) return bAlert - aAlert;
          if (scope !== "active") return b.id - a.id;
          const aTime = a.nextPlannedAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
          const bTime = b.nextPlannedAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
          return aTime - bTime;
        });
    }),

  /** Карточка заявки: поля, маршрут, история, вложения, тревоги. */
  get: dispatcherOnly.input(z.object({ id: z.number() })).handler(async ({ input }) => {
    const request = await getRequest(input.id);
    if (!request) throw new ORPCError("NOT_FOUND", { message: "Заявка не найдена" });

    const [ctx, history, files, alertRows] = await Promise.all([
      loadContext(request),
      db
        .select()
        .from(schema.statusHistory)
        .where(eq(schema.statusHistory.requestId, input.id))
        .orderBy(desc(schema.statusHistory.id)),
      db
        .select()
        .from(schema.attachments)
        .where(eq(schema.attachments.requestId, input.id))
        .orderBy(desc(schema.attachments.id)),
      db.select().from(schema.alerts).where(eq(schema.alerts.requestId, input.id)).orderBy(desc(schema.alerts.id)),
    ]);

    const driver = request.driverId
      ? (await db.select().from(schema.staff).where(eq(schema.staff.id, request.driverId)))[0]
      : null;

    return {
      request,
      route: routeView(ctx),
      isLate: isStopLate(ctx),
      driver: driver
        ? { id: driver.id, fullName: driver.fullName, phone: driver.phone, vehicle: driver.vehicle, status: driver.status }
        : null,
      history,
      attachments: files,
      alerts: alertRows,
    };
  }),

  create: dispatcherOnly.input(requestInput).handler(async ({ input, context }) => {
    const { values, stops, warnings } = await validateInput(input);
    const driver = input.driverId ? await assertAssignable(input.driverId, context.user) : null;

    const number = await nextRequestNumber();
    const [row] = await db
      .insert(schema.requests)
      .values({
        ...values,
        number,
        status: driver ? "assigned" : "new",
        driverId: driver?.id ?? null,
        isTest: driver?.role === "admin",
        createdById: context.user.id,
        assignedAt: driver ? new Date() : null,
      })
      .returning();
    if (!row) throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "Не удалось создать заявку" });
    const synced = await syncStops(row.id, stops.map((s) => ({ ...s, id: null })));
    if (!synced.ok) throw new ORPCError("BAD_REQUEST", { message: synced.error });

    await addHistory({
      requestId: row.id,
      status: "created",
      actorKind: "dispatcher",
      actorId: context.user.id,
      actorName: context.user.fullName,
    });

    const fresh = (await getRequest(row.id))!;
    if (driver) {
      await addHistory({
        requestId: row.id,
        status: "assigned",
        actorKind: "dispatcher",
        actorId: context.user.id,
        actorName: context.user.fullName,
        comment: `Водитель: ${driver.fullName}`,
      });
      const sent = await sendDriverCard(fresh, `Новая заявка ${row.number}`);
      return { ...fresh, delivery: sent, warnings };
    }
    return { ...fresh, delivery: null, warnings };
  }),

  /** Правка заявки. Пройденные и начатые остановки не меняются. */
  update: dispatcherOnly
    .input(requestInput.omit({ driverId: true }).extend({ id: z.number() }))
    .handler(async ({ input, context }) => {
      const current = await getRequest(input.id);
      if (!current) throw new ORPCError("NOT_FOUND", { message: "Заявка не найдена" });
      if (isClosedStatus(current.status)) {
        throw new ORPCError("BAD_REQUEST", { message: "Закрытую заявку нельзя редактировать" });
      }
      const { values, stops, warnings } = await validateInput({ ...input, driverId: null });
      const synced = await syncStops(current.id, stops);
      if (!synced.ok) throw new ORPCError("BAD_REQUEST", { message: synced.error });

      const [row] = await db
        .update(schema.requests)
        .set({ ...values, updatedAt: new Date() })
        .where(eq(schema.requests.id, input.id))
        .returning();
      if (!row) throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "Не удалось сохранить заявку" });

      await addHistory({
        requestId: row.id,
        status: "updated",
        actorKind: "dispatcher",
        actorId: context.user.id,
        actorName: context.user.fullName,
      });

      if (row.driverId) {
        // Одна свежая карточка внизу чата; у прежней снимаются кнопки.
        await reissueDriverCard(row, `✏️ Заявка ${row.number} обновлена диспетчером — проверьте маршрут`);
      }
      return { ...row, warnings };
    }),

  /** Назначение и переназначение водителя. */
  assign: dispatcherOnly
    .input(z.object({ id: z.number(), driverId: z.number() }))
    .handler(async ({ input, context }) => {
      const current = await getRequest(input.id);
      if (!current) throw new ORPCError("NOT_FOUND", { message: "Заявка не найдена" });
      if (isClosedStatus(current.status)) {
        throw new ORPCError("BAD_REQUEST", { message: "Заявка уже закрыта" });
      }
      const driver = await assertAssignable(input.driverId, context.user);
      const previousDriverId = current.driverId;
      if (previousDriverId === driver.id) {
        throw new ORPCError("BAD_REQUEST", { message: "Заявка уже назначена этому водителю" });
      }

      // Старому водителю снимаем кнопки и уведомляем об отзыве.
      if (previousDriverId) {
        if (current.driverMessageId) {
          await refreshDriverCard(
            { ...current, status: "cancelled" },
            `Заявка ${current.number} переназначена другому водителю`,
          );
        }
        await notifyStaff(previousDriverId, {
          text: `🚫 *Заявка ${current.number} снята с вас* и передана другому водителю. Действия по ней больше недоступны.`,
          format: "markdown",
        });
      }

      const [row] = await db
        .update(schema.requests)
        .set({
          driverId: driver.id,
          status: "assigned",
          assignedAt: new Date(),
          driverMessageId: null,
          acceptedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(schema.requests.id, input.id))
        .returning();
      if (!row) throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "Не удалось назначить водителя" });

      await addHistory({
        requestId: row.id,
        status: previousDriverId ? "reassigned" : "assigned",
        actorKind: "dispatcher",
        actorId: context.user.id,
        actorName: context.user.fullName,
        comment: `Водитель: ${driver.fullName}`,
      });

      const sent = await sendDriverCard(row, `Новая заявка ${row.number}`);
      return { ...row, delivery: sent };
    }),

  cancel: dispatcherOnly
    .input(z.object({ id: z.number(), reason: z.string().optional() }))
    .handler(async ({ input, context }) => {
      const current = await getRequest(input.id);
      if (!current) throw new ORPCError("NOT_FOUND", { message: "Заявка не найдена" });
      if (current.status === "cancelled") return current;

      const [row] = await db
        .update(schema.requests)
        .set({
          status: "cancelled",
          cancelledAt: new Date(),
          cancelReason: input.reason?.trim() || null,
          updatedAt: new Date(),
        })
        .where(eq(schema.requests.id, input.id))
        .returning();
      if (!row) throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "Не удалось отменить заявку" });

      await addHistory({
        requestId: row.id,
        status: "cancelled",
        actorKind: "dispatcher",
        actorId: context.user.id,
        actorName: context.user.fullName,
        comment: input.reason?.trim() || null,
      });

      if (row.driverId) {
        await refreshDriverCard(row, `Заявка ${row.number} отменена`);
        await notifyStaff(row.driverId, {
          text:
            `🚫 *Заявка ${row.number} отменена диспетчером.*` +
            (input.reason?.trim() ? `\nПричина: ${input.reason.trim()}` : ""),
          format: "markdown",
        });
      }
      // Закрываем неподтверждённые тревоги по отменённой заявке.
      await db
        .update(schema.alerts)
        .set({ acknowledgedAt: new Date(), acknowledgedById: context.user.id })
        .where(and(eq(schema.alerts.requestId, row.id), isNull(schema.alerts.acknowledgedAt)));
      return row;
    }),

  /** Повторная отправка карточки водителю (если он «потерял» сообщение). */
  resendCard: dispatcherOnly.input(z.object({ id: z.number() })).handler(async ({ input }) => {
    const request = await getRequest(input.id);
    if (!request) throw new ORPCError("NOT_FOUND", { message: "Заявка не найдена" });
    if (!request.driverId) throw new ORPCError("BAD_REQUEST", { message: "Водитель не назначен" });
    return reissueDriverCard(request, `Заявка ${request.number}`);
  }),

  /** Диспетчер может добавить комментарий в историю (и переслать водителю). */
  addComment: dispatcherOnly
    .input(z.object({ id: z.number(), comment: z.string().min(1), notifyDriver: z.boolean().default(false) }))
    .handler(async ({ input, context }) => {
      const request = await getRequest(input.id);
      if (!request) throw new ORPCError("NOT_FOUND", { message: "Заявка не найдена" });
      await addHistory({
        requestId: request.id,
        status: "comment",
        actorKind: "dispatcher",
        actorId: context.user.id,
        actorName: context.user.fullName,
        comment: input.comment.trim(),
      });
      if (input.notifyDriver && request.driverId) {
        await notifyStaff(request.driverId, {
          text: `💬 *Диспетчер по заявке ${request.number}:*\n${input.comment.trim()}`,
          format: "markdown",
        });
      }
      return { ok: true };
    }),

  /** Лента открытых тревог для шапки панели. */
  openAlerts: dispatcherOnly.handler(async () => {
    const rows = await db
      .select()
      .from(schema.alerts)
      .where(isNull(schema.alerts.acknowledgedAt))
      .orderBy(desc(schema.alerts.id));
    const ids = [...new Set(rows.map((r) => r.requestId))];
    const reqs = ids.length
      ? await db.select().from(schema.requests).where(inArray(schema.requests.id, ids))
      : [];
    return rows.map((alert) => {
      const request = reqs.find((r) => r.id === alert.requestId);
      return {
        ...alert,
        requestNumber: request?.number ?? null,
        containerNo: request?.containerNo ?? null,
        requestStatus: request?.status ?? null,
      };
    });
  }),

  acknowledgeAlert: dispatcherOnly
    .input(z.object({ alertId: z.number() }))
    .handler(async ({ input, context }) => {
      const [row] = await db
        .update(schema.alerts)
        .set({ acknowledgedAt: new Date(), acknowledgedById: context.user.id })
        .where(eq(schema.alerts.id, input.alertId))
        .returning();
      if (!row) throw new ORPCError("NOT_FOUND", { message: "Тревога не найдена" });
      return row;
    }),

  /** Диспетчер сам может поднять тревогу (например, водитель сообщил по телефону). */
  raiseAlert: dispatcherOnly
    .input(
      z.object({
        id: z.number(),
        type: z.enum(["late", "failure", "no_contact"]),
        message: z.string().optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      const request = await getRequest(input.id);
      if (!request) throw new ORPCError("NOT_FOUND", { message: "Заявка не найдена" });
      return raiseAlert({
        request,
        type: input.type,
        raisedBy: context.user,
        message: input.message?.trim() || null,
      });
    }),

  /** Сводка для дашборда. */
  stats: dispatcherOnly.handler(async () => {
    const rows = await db.select().from(schema.requests);
    const openAlerts = await db.select().from(schema.alerts).where(isNull(schema.alerts.acknowledgedAt));
    const active = rows.filter((r) => !isClosedStatus(r.status));
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return {
      active: active.length,
      unassigned: rows.filter((r) => r.status === "new").length,
      late: (await Promise.all(active.map((r) => loadContext(r)))).filter(isStopLate).length,
      running: active.filter((r) => isRunning(r.status)).length,
      deliveredToday: rows.filter((r) => r.completedAt && r.completedAt >= today).length,
      openAlerts: openAlerts.length,
    };
  }),
};
