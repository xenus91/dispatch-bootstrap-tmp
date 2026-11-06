import { and, eq, inArray } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { editMessage, sendMessage } from "../max/client";
import { driverCardMessage } from "../max/messages";
import type { MaxNewMessageBody } from "../max/types";
import { currentNotifyEvents, getNotifyPrefsMap, loadContext, type RequestRow } from "./route";
import { isEventEnabled, isLockedEvent, type NotifyEvent } from "./route-def";

export interface NotifyOptions {
  /**
   * Ключ события: `accepted`, `done`, `op:<операция>:<действие>`, `comment`, `attachment`, `geo`, `alert_late`,
   * `alert_failure`, `alert_escalation`, `security`, `staff_activated`.
   * Каждый диспетчер/админ сам решает в панели, какие события получать.
   */
  event: string;
  /** Заявка — для режима «только мои заявки». */
  request?: Pick<RequestRow, "createdById"> | null;
  excludeStaffId?: number;
}

/** Кому из диспетчеров/админов нужно это событие с учётом их личных настроек. */
export async function dispatcherRecipients(opts: NotifyOptions, catalog?: NotifyEvent[]) {
  const events = catalog ?? (await currentNotifyEvents());
  const people = await db
    .select()
    .from(schema.staff)
    .where(and(eq(schema.staff.status, "active"), inArray(schema.staff.role, ["dispatcher", "admin"])));
  const prefs = await getNotifyPrefsMap(people.map((p) => p.id));

  return people.filter((person) => {
    if (opts.excludeStaffId && person.id === opts.excludeStaffId) return false;
    const p = prefs.get(person.id);
    if (!p) return true;
    if (!isEventEnabled(events, p, opts.event)) return false;
    // «Только мои заявки»: фильтр по автору заявки. Заблокированные (критичные) тревоги — всем.
    if (!isLockedEvent(events, opts.event) && p.scope === "mine" && opts.request && opts.request.createdById != null) {
      return opts.request.createdById === person.id;
    }
    return true;
  });
}

/** Уведомление диспетчерам и админам — только тем, кто включил это событие. */
export async function notifyDispatchers(body: MaxNewMessageBody, opts: NotifyOptions) {
  const recipients = await dispatcherRecipients(opts);
  for (const person of recipients) {
    await sendMessage({ maxUserId: person.maxUserId, staffId: person.id, body });
  }
  return recipients.length;
}

export async function notifyStaff(staffId: number, body: MaxNewMessageBody) {
  const [person] = await db.select().from(schema.staff).where(eq(schema.staff.id, staffId));
  if (!person) return { ok: false, error: "Сотрудник не найден" };
  return sendMessage({ maxUserId: person.maxUserId, staffId: person.id, body });
}

/** Отправить водителю карточку заявки и запомнить id сообщения. */
export async function sendDriverCard(request: RequestRow, header?: string) {
  if (!request.driverId) return { ok: false, error: "Водитель не назначен" };
  const [driver] = await db.select().from(schema.staff).where(eq(schema.staff.id, request.driverId));
  if (!driver) return { ok: false, error: "Водитель не найден" };
  if (driver.status !== "active") {
    return { ok: false, error: "Водитель не активирован в боте MAX" };
  }

  const result = await sendMessage({
    maxUserId: driver.maxUserId,
    staffId: driver.id,
    body: driverCardMessage(await loadContext(request), header),
  });
  if (result.messageId) {
    await db
      .update(schema.requests)
      .set({ driverMessageId: result.messageId, updatedAt: new Date() })
      .where(eq(schema.requests.id, request.id));
  }
  return result;
}

/** Обновить ранее отправленную карточку (актуализировать статус и кнопки). */
export async function refreshDriverCard(request: RequestRow, header?: string) {
  if (!request.driverMessageId) return { ok: true, skipped: true };
  return editMessage(request.driverMessageId, driverCardMessage(await loadContext(request), header));
}

/**
 * Перевыпустить карточку внизу чата: у старой снять кнопки (чтобы не было двух
 * активных клавиатур), новую отправить и запомнить. Нужен, когда после карточки
 * в чате появились служебные сообщения (запрос фото, подтверждение).
 */
export async function reissueDriverCard(request: RequestRow, header?: string) {
  if (request.driverMessageId) {
    await editMessage(request.driverMessageId, {
      text: `Заявка ${request.number} — карточка обновлена, актуальная ниже.`,
      attachments: [],
      format: "markdown",
    });
  }
  return sendDriverCard(request, header);
}

/** Запомнить, что актуальная карточка — вот это сообщение (после правки через ответ на callback). */
export async function rememberDriverCard(requestId: number, messageId: string) {
  await db
    .update(schema.requests)
    .set({ driverMessageId: messageId })
    .where(eq(schema.requests.id, requestId));
}
