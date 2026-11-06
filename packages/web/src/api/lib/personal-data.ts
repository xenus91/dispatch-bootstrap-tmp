import { eq, or } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";

/**
 * Права субъекта персональных данных.
 *
 *   ст. 14 152-ФЗ — право на доступ к своим персональным данным и на выгрузку;
 *   ст. 15 152-ФЗ — право на уничтожение данных, если они не нужны;
 *   ст. 17 152-ФЗ — право на отзыв согласия.
 *
 * Здесь две операции:
 *   - `exportStaffData`  — собрать все данные о сотруднике в читаемом виде;
 *   - `eraseStaffData`   — обезличить сотрудника и вычистить связанные записи.
 *
 * Важное различие: `eraseStaffData` НЕ трогает бизнес-рекорды компании
 * (заявки, остановки, тревоги, фотографии товарно-транспортных документов).
 * Обезличивается только сам субъект и снимаются ссылки на него: в истории
 * заявок пропадает имя, но факт события и его содержание сохраняются.
 * Удалять документы компании — отдельное решение владельца данных.
 */

/** Что было сделано при стирании — показывается администратору и попадает в аудит. */
export interface EraseReport {
  staffId: number;
  sessions: number;
  otpCodes: number;
  invites: number;
  accessEvents: number;
  historyAnonymized: number;
  alertsAnonymized: number;
  requestsDetached: number;
  attachmentsDetached: number;
  outbox: number;
  botState: number;
  anonymizedFields: string[];
}

/** Полная выгрузка данных о сотруднике (ст. 14 152-ФЗ). */
export async function exportStaffData(staffId: number) {
  const [member] = await db.select().from(schema.staff).where(eq(schema.staff.id, staffId));
  if (!member) return null;

  const [sessions, otpCodes, invites, accessEvents, outbox, botState, history, alerts] =
    await Promise.all([
      db.select().from(schema.sessions).where(eq(schema.sessions.staffId, staffId)),
      db.select().from(schema.otpCodes).where(eq(schema.otpCodes.staffId, staffId)),
      db.select().from(schema.invites).where(eq(schema.invites.staffId, staffId)),
      db.select().from(schema.accessEvents).where(eq(schema.accessEvents.staffId, staffId)),
      db.select().from(schema.botOutbox).where(eq(schema.botOutbox.staffId, staffId)),
      db.select().from(schema.botState).where(eq(schema.botState.staffId, staffId)),
      db
        .select()
        .from(schema.statusHistory)
        .where(eq(schema.statusHistory.actorId, staffId)),
      db.select().from(schema.alerts).where(eq(schema.alerts.raisedById, staffId)),
    ]);

  const requestIds = history.map((h) => h.requestId);
  const requests = requestIds.length
    ? await db.select().from(schema.requests).where(eq(schema.requests.driverId, staffId))
    : [];

  return {
    exportedAt: new Date().toISOString(),
    subject: {
      id: member.id,
      role: member.role,
      fullName: member.fullName,
      phone: member.phone,
      vehicle: member.vehicle,
      note: member.note,
      maxUserId: member.maxUserId,
      maxChatId: member.maxChatId,
      maxUsername: member.maxUsername,
      status: member.status,
      accessUntil: member.accessUntil,
      consentAt: member.consentAt,
      consentVersion: member.consentVersion,
      erasedAt: member.erasedAt,
      createdAt: member.createdAt,
      activatedAt: member.activatedAt,
      lastActivityAt: member.lastActivityAt,
    },
    sessions: sessions.map((s) => ({
      id: s.id,
      kind: s.kind,
      ip: s.ip,
      userAgent: s.userAgent,
      createdAt: s.createdAt,
      lastSeenAt: s.lastSeenAt,
      expiresAt: s.expiresAt,
    })),
    oneTimeCodes: otpCodes.map((c) => ({
      id: c.id,
      attempts: c.attempts,
      createdAt: c.createdAt,
      expiresAt: c.expiresAt,
      usedAt: c.usedAt,
    })),
    invitations: invites.map((i) => ({
      id: i.id,
      createdAt: i.createdAt,
      expiresAt: i.expiresAt,
      usedAt: i.usedAt,
      revokedAt: i.revokedAt,
    })),
    accessEvents: accessEvents.map((e) => ({
      id: e.id,
      kind: e.kind,
      detail: e.detail,
      createdAt: e.createdAt,
    })),
    activityHistory: history.map((h) => ({
      id: h.id,
      requestId: h.requestId,
      status: h.status,
      actorKind: h.actorKind,
      comment: h.comment,
      latitude: h.latitude,
      longitude: h.longitude,
      createdAt: h.createdAt,
    })),
    alerts: alerts.map((a) => ({
      id: a.id,
      requestId: a.requestId,
      type: a.type,
      message: a.message,
      createdAt: a.createdAt,
      acknowledgedAt: a.acknowledgedAt,
    })),
    assignedRequests: requests.map((r) => ({
      id: r.id,
      number: r.number,
      status: r.status,
      createdAt: r.createdAt,
      completedAt: r.completedAt,
    })),
    outgoingMessages: outbox.map((m) => ({
      id: m.id,
      text: m.text,
      state: m.state,
      createdAt: m.createdAt,
    })),
    dialogState: botState.map((s) => ({
      maxUserId: s.maxUserId,
      step: s.step,
      requestId: s.requestId,
      updatedAt: s.updatedAt,
    })),
  };
}

/**
 * Стирание персональных данных сотрудника (ст. 15 и 17 152-ФЗ).
 *
 * Карточка не удаляется целиком — иначе рвётся история заявок и ссылочная
 * целостность. Вместо этого субъект обезличивается, а все его персональные
 * следы в операционных таблицах вычищаются.
 */
export async function eraseStaffData(staffId: number): Promise<EraseReport> {
  const [member] = await db.select().from(schema.staff).where(eq(schema.staff.id, staffId));
  if (!member) throw new Error("Сотрудник не найден");

  const stamp = new Date();

  // Уникальное «пустое» значение вместо телефона: номер уникален, а настоящий
  // телефон субъекта мы стираем.
  const ghostPhone = `79${String(9_000_000_000 + staffId).slice(-9)}`;

  const report: EraseReport = {
    staffId,
    sessions: 0,
    otpCodes: 0,
    invites: 0,
    accessEvents: 0,
    historyAnonymized: 0,
    alertsAnonymized: 0,
    requestsDetached: 0,
    attachmentsDetached: 0,
    outbox: 0,
    botState: 0,
    anonymizedFields: [],
  };

  // 1. Сессии, одноразовые коды, приглашения — удаляем целиком.
  report.sessions = (await db.delete(schema.sessions).where(eq(schema.sessions.staffId, staffId)))
    .rowCount ?? 0;
  report.otpCodes = (await db.delete(schema.otpCodes).where(eq(schema.otpCodes.staffId, staffId)))
    .rowCount ?? 0;
  report.invites = (await db.delete(schema.invites).where(eq(schema.invites.staffId, staffId)))
    .rowCount ?? 0;

  // 2. Журнал доступа — удаляем: там телефон и идентификатор MAX.
  report.accessEvents = (
    await db
      .delete(schema.accessEvents)
      .where(
        or(
          eq(schema.accessEvents.staffId, staffId),
          eq(schema.accessEvents.phone, member.phone),
        ),
      )
  ).rowCount ?? 0;

  // 3. История по заявкам — снимаем имя актора, событие сохраняем.
  report.historyAnonymized = (
    await db
      .update(schema.statusHistory)
      .set({ actorId: null, actorName: null })
      .where(eq(schema.statusHistory.actorId, staffId))
  ).rowCount ?? 0;

  // 4. Тревоги — снимаем автора.
  report.alertsAnonymized = (
    await db
      .update(schema.alerts)
      .set({ raisedById: null, raisedByName: null })
      .where(eq(schema.alerts.raisedById, staffId))
  ).rowCount ?? 0;

  // 5. Заявки — водитель отвязывается, сама заявка остаётся.
  report.requestsDetached = (
    await db
      .update(schema.requests)
      .set({ driverId: null })
      .where(eq(schema.requests.driverId, staffId))
  ).rowCount ?? 0;

  // 6. Вложения — автор отвязывается, файлы остаются (документы компании).
  report.attachmentsDetached = (
    await db
      .update(schema.attachments)
      .set({ uploadedById: null })
      .where(eq(schema.attachments.uploadedById, staffId))
  ).rowCount ?? 0;

  // 7. Исходящие сообщения и состояние диалога — удаляем.
  report.outbox = (await db.delete(schema.botOutbox).where(eq(schema.botOutbox.staffId, staffId)))
    .rowCount ?? 0;
  report.botState = (await db.delete(schema.botState).where(eq(schema.botState.staffId, staffId)))
    .rowCount ?? 0;

  // 8. Карточка — обезличиваем.
  await db
    .update(schema.staff)
    .set({
      fullName: `Сотрудник №${staffId} (данные удалены)`,
      phone: ghostPhone,
      vehicle: null,
      note: null,
      maxUserId: null,
      maxChatId: null,
      maxUsername: null,
      status: "blocked",
      blockReason: "erased",
      accessUntil: null,
      consentAt: null,
      consentVersion: null,
      lastActivityAt: null,
      erasedAt: stamp,
      updatedAt: stamp,
    })
    .where(eq(schema.staff.id, staffId));

  report.anonymizedFields = [
    "ФИО",
    "телефон",
    "госномер",
    "примечание",
    "идентификатор MAX",
    "согласие",
    "дата последней активности",
  ];

  return report;
}

/** Запросить удаление сессий конкретного сотрудника (используется при сбросе привязки). */
export async function purgeStaffSessions(staffId: number): Promise<number> {
  const res = await db.delete(schema.sessions).where(eq(schema.sessions.staffId, staffId));
  return res.rowCount ?? 0;
}

/** Найти сотрудника, чьи данные уже стёрты. */
export async function isErased(staffId: number): Promise<boolean> {
  const [row] = await db
    .select({ erasedAt: schema.staff.erasedAt })
    .from(schema.staff)
    .where(eq(schema.staff.id, staffId));
  return !!row?.erasedAt;
}
