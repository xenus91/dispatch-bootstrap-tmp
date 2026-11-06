import { eq } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { approveStaff, completeActivation, rejectStaff, signOutEverywhere } from "../lib/access";
import { CONSENT_VERSION } from "../lib/domain";
import { findStaffByMaxUserId, logAccess, touchActivity } from "../lib/auth";
import { canExecute, normalizePhone } from "../lib/domain";
import {
  notifyDispatchers,
  refreshDriverCard,
  reissueDriverCard,
  rememberDriverCard,
} from "../lib/notify";
import {
  acceptRequest,
  actionPhotoCount,
  activeRequestForDriver,
  addAttachment,
  addHistory,
  applyAction,
  getRequest,
  raiseAlert,
} from "../lib/requests-service";
import { loadContext, type RequestContext, type RequestRow } from "../lib/route";
import { isClosedStatus, nextAction, type OperationAction } from "../lib/route-def";
import { answerCallback, editMessage, sendMessage } from "./client";
import { claimWindow, releaseWindow } from "./dedupe";
import { extractMedia, flushMedia, type MediaBatch, messageAttachments, pushMedia, setMediaFlush } from "./media-buffer";
import {
  actionPhotoPrompt,
  attachmentNotification,
  awaitingApprovalMessage,
  CB,
  commentNotification,
  consentMessage,
  contactRequestMessage,
  contextHeader,
  driverCardMessage,
  freeTextPrompt,
  geoNotification,
  keyboard,
  nameConfirmMessage,
  noAccessMessage,
  parseCallback,
  plainText,
} from "./messages";
import type { MaxNewMessageBody, MaxUpdate } from "./types";

type StaffRow = typeof schema.staff.$inferSelect;

/* ─────────────── состояние диалога ─────────────── */

async function getState(maxUserId: string) {
  const [row] = await db.select().from(schema.botState).where(eq(schema.botState.maxUserId, maxUserId));
  return row ?? null;
}

async function setState(
  maxUserId: string,
  patch: Partial<typeof schema.botState.$inferInsert>,
) {
  await db
    .insert(schema.botState)
    .values({ maxUserId, step: "idle", ...patch, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: schema.botState.maxUserId,
      set: { ...patch, updatedAt: new Date() },
    });
}

async function clearStep(maxUserId: string) {
  await setState(maxUserId, { step: "idle", requestId: null, dataJson: null });
}

/** Телефон из VCF, который MAX присылает вместе с подписью `hash`. */
export function phoneFromVcf(vcf: string | undefined | null): string | null {
  if (!vcf) return null;
  const match = vcf.match(/TEL[^:]*:([+\d()\-\s]+)/i);
  if (!match) return null;
  const normalized = normalizePhone(match[1] ?? "");
  return normalized || null;
}

async function reply(maxUserId: string, staffId: number | null, body: Parameters<typeof sendMessage>[0]["body"]) {
  await sendMessage({ maxUserId, staffId, body });
}

/* ─────────────── bot_started: вход по инвайту ─────────────── */

async function handleBotStarted(update: MaxUpdate) {
  const maxUserId = String(update.user?.user_id ?? update.user_id ?? "");
  if (!maxUserId) return;
  const chatId = update.chat_id ? String(update.chat_id) : null;
  const code = (update.payload ?? "").trim().toUpperCase();
  // Повторный bot_started в течение минуты (двойной «Старт», переподключение) — без второго приветствия.
  if (!(await claimWindow(`start:${maxUserId}:${code}`, 60_000))) return;

  const existing = await findStaffByMaxUserId(maxUserId);
  if (existing && existing.status === "active") {
    if (chatId && existing.maxChatId !== chatId) {
      await db.update(schema.staff).set({ maxChatId: chatId }).where(eq(schema.staff.id, existing.id));
    }
    const active = canExecute(existing.role) ? await activeRequestForDriver(existing.id) : null;
    if (active) {
      await reissueDriverCard(active, `С возвращением, ${existing.fullName}!\nАктивная заявка ${active.number}`);
      return;
    }
    await reply(maxUserId, existing.id, {
      text: `С возвращением, ${existing.fullName}! Активных заявок нет — ожидайте назначения от диспетчера.`,
      format: "markdown",
    });
    return;
  }
  if (existing && existing.status === "blocked") {
    await logAccess({ kind: "blocked_attempt", staffId: existing.id, maxUserId });
    await reply(maxUserId, existing.id, noAccessMessage);
    return;
  }
  if (existing && existing.status === "awaiting_approval") {
    await reply(maxUserId, existing.id, awaitingApprovalMessage);
    return;
  }

  if (!code) {
    await logAccess({ kind: "stranger", maxUserId, detail: "bot_started без инвайт-кода" });
    await reply(maxUserId, null, noAccessMessage);
    return;
  }

  const [invite] = await db.select().from(schema.invites).where(eq(schema.invites.code, code));
  if (!invite || invite.revokedAt || invite.usedAt) {
    await logAccess({
      kind: "invite_invalid",
      maxUserId,
      detail: invite ? "Инвайт уже использован или отозван" : `Код не найден: ${code}`,
    });
    await reply(maxUserId, null, noAccessMessage);
    return;
  }
  if (invite.expiresAt.getTime() < Date.now()) {
    await logAccess({ kind: "invite_expired", staffId: invite.staffId, maxUserId, detail: code });
    await reply(maxUserId, null, {
      text: "Срок действия приглашения истёк. Попросите администратора выпустить новое.",
      format: "markdown",
    });
    return;
  }

  const [member] = await db.select().from(schema.staff).where(eq(schema.staff.id, invite.staffId));
  if (!member || member.status === "blocked") {
    await logAccess({ kind: "invite_invalid", maxUserId, detail: "Карточка сотрудника недоступна" });
    await reply(maxUserId, null, noAccessMessage);
    return;
  }

  await logAccess({ kind: "invite_ok", staffId: member.id, maxUserId, detail: code });
  await setState(maxUserId, {
    step: "awaiting_contact",
    staffId: member.id,
    inviteId: invite.id,
    dataJson: chatId ? JSON.stringify({ chatId }) : null,
  });
  await reply(maxUserId, member.id, contactRequestMessage(member.fullName));
}

/* ─────────────── подтверждение телефона ─────────────── */

async function handleContact(update: MaxUpdate, maxUserId: string) {
  const attachment = update.message?.body?.attachments?.find((a) => a.type === "contact");
  const state = await getState(maxUserId);
  if (!state || state.step !== "awaiting_contact" || !state.staffId) {
    await reply(maxUserId, null, noAccessMessage);
    return;
  }
  const [member] = await db.select().from(schema.staff).where(eq(schema.staff.id, state.staffId));
  if (!member) return;

  const phone = phoneFromVcf(attachment?.payload?.vcf_info as string | undefined);
  if (!phone) {
    await reply(maxUserId, member.id, {
      text: "Не удалось прочитать номер из контакта. Нажмите кнопку «Поделиться контактом» ещё раз.",
      format: "markdown",
    });
    return;
  }

  if (phone !== member.phone) {
    await logAccess({
      kind: "phone_mismatch",
      staffId: member.id,
      phone,
      maxUserId,
      detail: `Ожидался +${member.phone}, получен +${phone}`,
    });
    await notifyDispatchers({
      text:
        `🔐 *Подозрительная попытка активации*\n` +
        `Инвайт выдан на ${member.fullName} (+${member.phone}), ` +
        `а контакт подтверждён с номера +${phone}. Доступ отклонён.`,
      format: "markdown",
    }, { event: "security" });
    await clearStep(maxUserId);
    await reply(maxUserId, member.id, {
      text: "Номер не совпадает с карточкой сотрудника. Доступ отклонён, диспетчер уведомлён.",
      format: "markdown",
    });
    return;
  }

  const chatId = update.message?.recipient?.chat_id ? String(update.message.recipient.chat_id) : null;
  await db
    .update(schema.staff)
    .set({
      maxUserId,
      maxChatId: chatId ?? member.maxChatId,
      maxUsername: update.message?.sender?.username ?? member.maxUsername,
      updatedAt: new Date(),
    })
    .where(eq(schema.staff.id, member.id));
  await setState(maxUserId, { step: "awaiting_name_confirm", staffId: member.id });
  await reply(maxUserId, member.id, nameConfirmMessage(member.fullName));
}

async function handleNameConfirm(maxUserId: string, confirmed: boolean) {
  const state = await getState(maxUserId);
  // Повторное нажатие на старой кнопке не должно второй раз запускать активацию.
  if (!state?.staffId || state.step !== "awaiting_name_confirm") return;
  const [member] = await db.select().from(schema.staff).where(eq(schema.staff.id, state.staffId));
  if (!member) return;

  if (!confirmed) {
    await logAccess({ kind: "name_rejected", staffId: member.id, maxUserId });
    await notifyDispatchers({
      text:
        `⚠️ *Регистрация приостановлена*\n` +
        `${member.fullName} (+${member.phone}) не подтвердил ФИО при активации. Требуется ручная проверка.`,
      format: "markdown",
    }, { event: "security" });
    await clearStep(maxUserId);
    await reply(maxUserId, member.id, {
      text: "Регистрация приостановлена. С вами свяжется диспетчер.",
      format: "markdown",
    });
    return;
  }

  if (state.inviteId) {
    await db
      .update(schema.invites)
      .set({ usedAt: new Date() })
      .where(eq(schema.invites.id, state.inviteId));
  }
  // Дальше — явное согласие на обработку персональных данных (ст. 9 152-ФЗ).
  // Это отдельный шаг, а не часть подтверждения ФИО.
  await setState(maxUserId, {
    step: "awaiting_consent",
    staffId: member.id,
    inviteId: state.inviteId,
    dataJson: state.dataJson,
  });
  await reply(maxUserId, member.id, consentMessage(member.fullName, CONSENT_VERSION));
}

/**
 * Ответ на запрос согласия.
 *
 * Согласие — активация. Отказ — отказ от активации: сотрудник не получает
 * доступа, доступ не создаётся, диспетчер уведомляется.
 */
async function handleConsent(maxUserId: string, agreed: boolean) {
  const state = await getState(maxUserId);
  // Повторное нажатие на старой кнопке не должно второй раз запускать активацию.
  if (!state?.staffId || state.step !== "awaiting_consent") return;
  const [member] = await db.select().from(schema.staff).where(eq(schema.staff.id, state.staffId));
  if (!member) return;

  if (!agreed) {
    await logAccess({ kind: "consent_rejected", staffId: member.id, maxUserId });
    await notifyDispatchers({
      text:
        `⚠️ *Отказ от согласия на обработку персональных данных*\n` +
        `${member.fullName} (+${member.phone}) не согласился на обработку. Доступ не выдан.`,
      format: "markdown",
    }, { event: "security" });
    await clearStep(maxUserId);
    await reply(maxUserId, member.id, {
      text:
        "Вы отказались от обработки персональных данных — доступ к системе не выдан. " +
        "Обратитесь к диспетчеру, если передумаете.",
      format: "markdown",
    });
    return;
  }

  await db
    .update(schema.staff)
    .set({ consentAt: new Date(), consentVersion: CONSENT_VERSION, updatedAt: new Date() })
    .where(eq(schema.staff.id, member.id));
  await logAccess({
    kind: "consent_given",
    staffId: member.id,
    maxUserId,
    detail: CONSENT_VERSION,
  });

  await clearStep(maxUserId);
  const [fresh] = await db.select().from(schema.staff).where(eq(schema.staff.id, member.id));
  await completeActivation(fresh ?? member, "инвайт-ссылка, контакт, ФИО и согласие на обработку ПДн");
}

/* ─────────────── журнал доставки ─────────────── */

/**
 * Записать входящее событие и его исход.
 *
 * Ошибка записи не должна ломать обработку события — поэтому исключение
 * глушится: потеря одной строки журнала лучше, чем отказ в приёме события.
 */
export async function recordDelivery(
  updateType: string | null,
  outcome: "processed" | "duplicate" | "bad_secret" | "bad_json" | "failed",
  maxUserId: string | null,
  error: string | null,
): Promise<void> {
  try {
    await db.insert(schema.webhookEvents).values({
      updateType: updateType ?? null,
      outcome,
      maxUserId: maxUserId ?? null,
      error: error ? error.slice(0, 500) : null,
    });
  } catch (err) {
    console.error("[max webhook] не удалось записать доставку:", err);
  }
}

/* ─────────────── callback-кнопки ─────────────── */

/** Данные шага диалога в bot_state.data_json. */
interface StepData {
  stopId?: number | null;
  actionKey?: string | null;
  /** id сообщения-запроса (редактируется на месте) */
  mid?: string | null;
  count?: number;
  texts?: string[];
}

function parseData(raw: string | null | undefined): StepData {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as StepData;
  } catch {
    return {};
  }
}

const plain = plainText;

/** Ответ на нажатие — всегда с непустым телом (иначе MAX отвечает 400 и кнопка «висит»). */
const ack = (callbackId: string, text = "Принято") => answerCallback(callbackId, { notification: text });

/** Можно ли водителю сейчас работать с заявкой (своя и открытая). */
function ownOpen(request: RequestRow | null, member: StaffRow): request is RequestRow {
  return !!request && request.driverId === member.id && !isClosedStatus(request.status);
}

/**
 * Показать актуальную карточку: если нажали на текущей карточке — правим её на месте,
 * иначе подтверждаем всплывашкой и перевыпускаем карточку внизу чата.
 */
async function showCard(callbackId: string, request: RequestRow, pressedMid: string | undefined, note: string) {
  const ctx = await loadContext(request);
  if (!request.driverMessageId || (pressedMid && pressedMid === request.driverMessageId)) {
    await answerCallback(callbackId, { message: driverCardMessage(ctx), notification: note });
    if (pressedMid && pressedMid !== request.driverMessageId) await rememberDriverCard(request.id, pressedMid);
    return;
  }
  await ack(callbackId, note);
  await reissueDriverCard(request);
}

/** Сообщение-запрос: правим прежнее, а если не вышло — отправляем новое и запоминаем. */
async function upsertPrompt(maxUserId: string, member: StaffRow, mid: string | null | undefined, body: MaxNewMessageBody) {
  if (mid) {
    const edited = await editMessage(mid, body);
    if (edited.ok) return mid;
  }
  const sent = await sendMessage({ maxUserId, staffId: member.id, body });
  return sent.messageId ?? null;
}

async function finishTrip(maxUserId: string, member: StaffRow, request: RequestRow, summary: string | null) {
  if (request.driverMessageId) await refreshDriverCard(request);
  if (summary) await reply(maxUserId, member.id, { text: `${summary}\n\nСпасибо! Заявка закрыта.`, format: "markdown" });
}

async function handleCallback(update: MaxUpdate) {
  const callback = update.callback;
  if (!callback) return;
  const id = callback.callback_id;
  const maxUserId = String(callback.user.user_id);
  const pressedMid = update.message?.body?.mid;
  const { kind, a, b } = parseCallback(callback.payload);

  // Двойное нажатие той же кнопки за 5 с — только всплывашка.
  if (!(await claimWindow(`tap:${maxUserId}:${callback.payload ?? ""}`, 5000))) {
    await ack(id, "Уже отмечено");
    return;
  }

  if (kind === "nm") {
    await ack(id);
    await handleNameConfirm(maxUserId, a === "1");
    return;
  }

  // Согласие обрабатывается так же до проверки статуса: на этом шаге сотрудник
  // ещё не активен.
  if (kind === "cs") {
    await ack(id);
    await handleConsent(maxUserId, a === "1");
    return;
  }

  const member = await findStaffByMaxUserId(maxUserId);
  if (member?.status === "awaiting_approval") {
    await ack(id, "Ожидайте допуска администратора");
    return;
  }
  if (!member || member.status !== "active") {
    await logAccess({ kind: member ? "blocked_attempt" : "stranger", staffId: member?.id, maxUserId });
    await answerCallback(id, { message: { ...noAccessMessage, attachments: [] } });
    return;
  }
  await touchActivity(member.id);

  if (kind === "so") {
    await signOutEverywhere(member, "Кнопка «Это не я» в MAX");
    await answerCallback(id, {
      message: plain("🚫 Все сеансы панели завершены. Чтобы войти снова, запросите новый код на странице входа."),
    });
    return;
  }
  if (kind === "ap" || kind === "rj") {
    if (member.role !== "admin") {
      await ack(id, "Доступно только администратору");
      return;
    }
    const staffId = Number.parseInt(a, 10);
    const result = kind === "ap" ? await approveStaff(staffId, member) : await rejectStaff(staffId, member);
    const who = result.ok ? `${result.member.fullName} (+${result.member.phone})` : "";
    await answerCallback(id, {
      message: plain(
        result.ok
          ? kind === "ap"
            ? `✅ Допущен: ${who}. Решение: ${member.fullName}.`
            : `⛔ Отклонён: ${who}. Привязка MAX снята. Решение: ${member.fullName}.`
          : `ℹ️ ${result.reason}`,
      ),
    });
    return;
  }
  if (kind === "esc") {
    await clearStep(maxUserId);
    await answerCallback(id, { message: plain("Отменено."), notification: "Отменено" });
    return;
  }

  // a/ad адресуют остановку, остальные — заявку.
  let request: RequestRow | null = null;
  let stopId: number | null = null;
  if (kind === "a" || kind === "ad") {
    stopId = Number.parseInt(a, 10);
    const [stop] = Number.isFinite(stopId)
      ? await db.select().from(schema.requestStops).where(eq(schema.requestStops.id, stopId))
      : [];
    request = stop ? await getRequest(stop.requestId) : null;
  } else {
    const requestId = Number.parseInt(a, 10);
    request = Number.isFinite(requestId) ? await getRequest(requestId) : null;
  }
  if (!request) {
    await answerCallback(id, { message: plain("Заявка не найдена."), notification: "Устарело" });
    return;
  }
  if (request.driverId !== member.id) {
    await logAccess({
      kind: "blocked_attempt",
      staffId: member.id,
      maxUserId,
      detail: `Попытка действия по чужой заявке ${request.number}`,
    });
    await answerCallback(id, { message: plain("Заявка больше не назначена на вас."), notification: "Устарело" });
    return;
  }

  switch (kind) {
    case "cd": {
      // Перевыдача карточки — не чаще раза в 30 с на заявку.
      if (!(await claimWindow(`card:${request.id}`, 30_000))) {
        await ack(id, "Карточка уже в чате ниже");
        return;
      }
      await ack(id, "Карточка ниже");
      await reissueDriverCard(request);
      return;
    }

    case "acc": {
      const result = await acceptRequest({ request, driver: member });
      if (!result.ok) {
        await ack(id, result.error);
        return;
      }
      await showCard(id, result.request, pressedMid, "Заявка принята");
      return;
    }

    case "a":
    case "ad": {
      if (kind === "ad") await flushMedia(maxUserId); // файлы альбома, ещё лежащие в буфере
      const state = await getState(maxUserId);
      const data = parseData(state?.dataJson);
      const result = await applyAction({ request, driver: member, stopId: stopId!, actionKey: b });
      if (!result.ok) {
        if ("needPhoto" in result && result.needPhoto) {
          // Нажатие не засчитано — повтор после фото не должен упираться в окно двойного нажатия.
          await releaseWindow(`tap:${maxUserId}:${callback.payload ?? ""}`);
          const ctx = await loadContext(request);
          const view = ctx.stops.find((v) => v.stop.id === result.stop.id)!;
          const sameStep =
            state?.step === "awaiting_action_photo" && data.stopId === result.stop.id && data.actionKey === result.action.key;
          if (kind === "ad") {
            await answerCallback(id, {
              message: actionPhotoPrompt(ctx, view, result.action, 0, "⚠️ Сначала пришлите хотя бы одно фото или скан."),
              notification: "Нужно фото",
            });
            return;
          }
          if (sameStep && data.mid) {
            await ack(id, "Пришлите фото — запрос выше");
            return;
          }
          await ack(id, "Пришлите фото");
          const mid = await upsertPrompt(maxUserId, member, null, actionPhotoPrompt(ctx, view, result.action, 0));
          await setState(maxUserId, {
            step: "awaiting_action_photo",
            staffId: member.id,
            requestId: request.id,
            dataJson: JSON.stringify({ stopId: result.stop.id, actionKey: result.action.key, mid, count: 0 } satisfies StepData),
          });
          return;
        }
        await ack(id, result.error);
        return;
      }
      if (state?.step === "awaiting_action_photo" || state?.step === "awaiting_photo") await clearStep(maxUserId);
      const label = `Отмечено: ${result.action.label}`;
      if (result.finishedTrip) {
        await answerCallback(id, {
          message: kind === "ad" ? plain(`✅ ${label}`) : driverCardMessage(result.ctx),
          notification: "Рейс завершён",
        });
        await finishTrip(maxUserId, member, result.request, result.summary);
        return;
      }
      if (kind === "ad") {
        await answerCallback(id, { message: plain(`✅ ${label} · файлов: ${result.view.done[result.view.done.length - 1]?.photos ?? 0}`), notification: label });
        await reissueDriverCard(result.request);
        return;
      }
      await showCard(id, result.request, pressedMid, label);
      return;
    }

    case "cm": {
      const state = await getState(maxUserId);
      if (state?.step === "awaiting_comment" && state.requestId === request.id) {
        await ack(id, "Напишите комментарий сообщением");
        return;
      }
      const ctx = await loadContext(request);
      await setState(maxUserId, { step: "awaiting_comment", staffId: member.id, requestId: request.id, dataJson: null });
      await ack(id, "Напишите комментарий");
      await reply(maxUserId, member.id, {
        text: `${contextHeader(ctx)}\n\n💬 Напишите комментарий одним сообщением.`,
        format: "markdown",
        attachments: keyboard([[{ type: "callback", text: "✖ Отмена", payload: CB.cancelInput() }]]),
      });
      return;
    }

    case "ph": {
      const state = await getState(maxUserId);
      if ((state?.step === "awaiting_photo" || state?.step === "awaiting_action_photo") && state.requestId === request.id) {
        await ack(id, "Пришлите фото — запрос выше");
        return;
      }
      const ctx = await loadContext(request);
      await ack(id, "Пришлите фото");
      const mid = await upsertPrompt(maxUserId, member, null, {
        text: `${contextHeader(ctx)}\n\n📷 Пришлите фото или сканы. Можно альбомом или несколькими сообщениями.`,
        format: "markdown",
        attachments: keyboard([[{ type: "callback", text: "✖ Закрыть", payload: CB.cancelInput() }]]),
      });
      await setState(maxUserId, {
        step: "awaiting_photo",
        staffId: member.id,
        requestId: request.id,
        dataJson: JSON.stringify({ stopId: ctx.current?.stop.id ?? null, mid, count: 0 } satisfies StepData),
      });
      return;
    }

    case "al": {
      const type = b === "failure" ? "failure" : "late";
      const { duplicate } = await raiseAlert({ request, type, raisedBy: member });
      await ack(id, duplicate ? "Сигнал уже передан" : "Сигнал отправлен диспетчеру");
      if (!duplicate) {
        await reply(maxUserId, member.id, {
          text:
            type === "failure"
              ? "🚨 Сигнал «Срыв заявки» отправлен диспетчеру. Ожидайте звонка."
              : "⏳ Сигнал «Возможно опоздание» отправлен диспетчеру.",
          format: "markdown",
        });
      }
      return;
    }

    case "tc": {
      const state = await getState(maxUserId);
      const data = parseData(state?.dataJson);
      if (state?.step !== "free_text" || state.requestId !== request.id || !data.texts?.length) {
        await ack(id, "Устарело");
        return;
      }
      const text = data.texts.join("\n");
      const ctx = await loadContext(request);
      await saveComment(ctx, member, text);
      await clearStep(maxUserId);
      await answerCallback(id, {
        message: plain(`💬 ${contextHeader(ctx)}\nКомментарий передан диспетчеру.`),
        notification: "Отправлено",
      });
      return;
    }

    default:
      await ack(id, "Команда не распознана");
  }
}

/* ─────────────── входящие сообщения ─────────────── */

async function saveComment(ctx: RequestContext, member: StaffRow, text: string) {
  await addHistory({
    requestId: ctx.request.id,
    status: "comment",
    actorKind: "driver",
    actorId: member.id,
    actorName: member.fullName,
    comment: text,
    stopId: ctx.current?.stop.id ?? null,
  });
  await notifyDispatchers(commentNotification(ctx, ctx.current, member.fullName, text), {
    event: "comment",
    request: ctx.request,
    excludeStaffId: member.id,
  });
}

/** Заявка, к которой относится сообщение: из шага диалога или активная. */
async function targetRequest(member: StaffRow, state: Awaited<ReturnType<typeof getState>>) {
  const fromState = state?.requestId ? await getRequest(state.requestId) : null;
  if (ownOpen(fromState, member)) return { request: fromState, fromState: true };
  return { request: canExecute(member.role) ? await activeRequestForDriver(member.id) : null, fromState: false };
}

/**
 * Пачка медиа (альбом или серия за 2,5 с): одна запись истории, один ответ водителю,
 * одно уведомление диспетчерам. Привязка — к действию из запроса фото или к текущей остановке.
 */
async function flushMediaBatch(batch: MediaBatch) {
  const maxUserId = batch.maxUserId;
  const member = await findStaffByMaxUserId(maxUserId);
  if (!member || member.status !== "active") return;
  const state = await getState(maxUserId);
  const { request, fromState } = await targetRequest(member, state);

  if (!request) {
    await reply(maxUserId, member.id, plain("Нет активной заявки — файлы не сохранены."));
    return;
  }
  const ctx = await loadContext(request);
  if (!batch.items.length) {
    await reply(maxUserId, member.id, plain(`${contextHeader(ctx)}\n\nНе удалось распознать вложение. Пришлите фото как изображение или файл.`));
    return;
  }

  const data = fromState ? parseData(state?.dataJson) : {};
  let view = ctx.current;
  let action: OperationAction | null = null;
  if (fromState && state?.step === "awaiting_action_photo" && data.stopId && data.actionKey) {
    const v = ctx.stops.find((s) => s.stop.id === data.stopId);
    const next = v ? nextAction(v.stop) : null;
    if (v && next?.key === data.actionKey && ctx.current?.stop.id === v.stop.id) {
      view = v;
      action = next;
    }
  } else if (fromState && state?.step === "awaiting_photo" && data.stopId) {
    view = ctx.stops.find((s) => s.stop.id === data.stopId) ?? view;
  }

  const note = action ? `К действию «${action.label}»` : "Доп. фото";
  const history = await addHistory({
    requestId: request.id,
    status: "attachment",
    actorKind: "driver",
    actorId: member.id,
    actorName: member.fullName,
    comment: [note, ...batch.captions].join(" · "),
    stopId: view?.stop.id ?? null,
    actionKey: action?.key ?? null,
  });
  for (const item of batch.items) {
    await addAttachment({
      requestId: request.id,
      historyId: history?.id ?? null,
      uploadedById: member.id,
      kind: item.type,
      fileName: item.fileName,
      maxToken: item.token,
      maxUrl: item.url,
      sizeBytes: item.size,
      stopId: view?.stop.id ?? null,
      actionKey: action?.key ?? null,
    });
  }
  const n = batch.items.length;

  if (action && view) {
    const count = await actionPhotoCount(view.stop.id, action.key);
    const mid = await upsertPrompt(maxUserId, member, data.mid, actionPhotoPrompt(ctx, view, action, count));
    await setState(maxUserId, { dataJson: JSON.stringify({ ...data, mid, count } satisfies StepData) });
  } else if (fromState && state?.step === "awaiting_photo") {
    const count = (data.count ?? 0) + n;
    const mid = await upsertPrompt(maxUserId, member, data.mid, {
      text: `📎 ${contextHeader(ctx, view)}\nПринято файлов: *${count}*. Можно прислать ещё.`,
      format: "markdown",
      attachments: keyboard([[{ type: "callback", text: "✅ Готово", payload: CB.cancelInput(), intent: "positive" }]]),
    });
    await setState(maxUserId, { dataJson: JSON.stringify({ ...data, mid, count } satisfies StepData) });
  } else {
    await reply(maxUserId, member.id, plain(`📎 ${n} ${n === 1 ? "файл" : "файлов"} → ${contextHeader(ctx, view)}`));
  }

  await notifyDispatchers(attachmentNotification(ctx, view, member.fullName, n), {
    event: "attachment",
    request,
    excludeStaffId: member.id,
  });
}

setMediaFlush(flushMediaBatch);

async function handleMessage(update: MaxUpdate) {
  const maxUserId = String(update.message?.sender?.user_id ?? "");
  if (!maxUserId) return;

  const attachments = messageAttachments(update);
  if (attachments.some((a) => a.type === "contact")) {
    await handleContact(update, maxUserId);
    return;
  }

  const member = await findStaffByMaxUserId(maxUserId);
  if (member?.status === "awaiting_approval") {
    await reply(maxUserId, member.id, awaitingApprovalMessage);
    return;
  }
  if (!member || member.status !== "active") {
    const state = await getState(maxUserId);
    if (state?.step === "awaiting_contact") {
      const [pending] = state.staffId
        ? await db.select().from(schema.staff).where(eq(schema.staff.id, state.staffId))
        : [];
      if (pending) {
        await reply(maxUserId, pending.id, contactRequestMessage(pending.fullName));
        return;
      }
    }
    await logAccess({ kind: member ? "blocked_attempt" : "stranger", staffId: member?.id, maxUserId });
    await reply(maxUserId, member?.id ?? null, noAccessMessage);
    return;
  }

  await touchActivity(member.id);
  const text = (update.message?.body?.text ?? "").trim();

  /* — медиа: в буфер, ответ один на пачку (никогда не перевыпускает карточку) — */
  const { items, unknownTypes } = extractMedia(attachments);
  if (items.length || unknownTypes.length) {
    pushMedia(maxUserId, { items, caption: text || null, unknown: !items.length });
    return;
  }

  const state = await getState(maxUserId);
  const { request, fromState } = await targetRequest(member, state);
  if (state && state.step !== "idle" && state.requestId && !fromState) {
    // Заявку закрыли/переназначили, пока водитель отвечал.
    await clearStep(maxUserId);
  }

  /* — геолокация: к текущей остановке — */
  const geo = attachments.find((a) => a.type === "location");
  if (geo) {
    if (!request) {
      await reply(maxUserId, member.id, plain("Нет активной заявки — геолокация не сохранена."));
      return;
    }
    const lat = Number(geo.payload?.latitude);
    const lon = Number(geo.payload?.longitude);
    const ctx = await loadContext(request);
    await addHistory({
      requestId: request.id,
      status: "geo",
      actorKind: "driver",
      actorId: member.id,
      actorName: member.fullName,
      comment: "Геолокация водителя",
      latitude: String(lat),
      longitude: String(lon),
      stopId: ctx.current?.stop.id ?? null,
    });
    await notifyDispatchers(geoNotification(ctx, ctx.current, member.fullName, lat, lon), {
      event: "geo",
      request,
      excludeStaffId: member.id,
    });
    await reply(maxUserId, member.id, plain(`📍 Геолокация сохранена → ${contextHeader(ctx)}`));
    return;
  }

  if (!text) return;

  /* — комментарий по кнопке «💬» — */
  if (state?.step === "awaiting_comment" && fromState && request) {
    const ctx = await loadContext(request);
    await saveComment(ctx, member, text);
    await clearStep(maxUserId);
    await reply(maxUserId, member.id, plain(`💬 ${contextHeader(ctx)}\nКомментарий передан диспетчеру.`));
    return;
  }

  /* — ждём фото к действию, а пришёл текст — */
  if (state?.step === "awaiting_action_photo" && fromState && request) {
    await reply(maxUserId, member.id, plain("Жду фото или скан. Пришлите файл или нажмите «Отмена» в запросе выше."));
    return;
  }

  /* — свободный текст: один вопрос «это комментарий?», правится на месте — */
  if (request) {
    const ctx = await loadContext(request);
    const data = state?.step === "free_text" && state.requestId === request.id ? parseData(state.dataJson) : {};
    const texts = [...(data.texts ?? []), text].slice(-20);
    const mid = await upsertPrompt(maxUserId, member, data.mid, freeTextPrompt(ctx, texts.length));
    await setState(maxUserId, {
      step: "free_text",
      staffId: member.id,
      requestId: request.id,
      dataJson: JSON.stringify({ texts, mid } satisfies StepData),
    });
    return;
  }
  await reply(maxUserId, member.id, {
    text:
      member.role === "driver"
        ? "Активных заявок нет. Новая заявка придёт в этот чат."
        : "Управление заявками — в панели диспетчеризации. Вход по номеру телефона и коду из этого чата.",
    format: "markdown",
  });
}

/* ─────────────── точка входа вебхука ─────────────── */

export async function handleUpdate(update: MaxUpdate) {
  switch (update.update_type) {
    case "bot_started":
      return handleBotStarted(update);
    case "message_created":
      return handleMessage(update);
    case "message_callback":
      return handleCallback(update);
    case "bot_stopped":
    case "bot_removed": {
      const maxUserId = String(update.user?.user_id ?? update.user_id ?? "");
      if (maxUserId) {
        await logAccess({ kind: "revoked", maxUserId, detail: update.update_type });
      }
      return;
    }
    default:
      return;
  }
}
