import { ORPCError } from "@orpc/server";
import { and, desc, eq, gt, inArray, isNotNull, lt, ne, notInArray } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { sendMessage } from "../max/client";
import { approvalRequestMessage, awaitingApprovalMessage, newDeviceMessage } from "../max/messages";
import type { MaxNewMessageBody } from "../max/types";
import { logAccess, revokeSessions, type StaffRow } from "./auth";
import { notifyDispatchers, sendDriverCard } from "./notify";
import { canExecute } from "./domain";
import { CLOSED_STATUSES } from "./route-def";
import { activeRequestForDriver } from "./requests-service";
import { getSetting } from "./settings";

/* ─────────────── настройки безопасности ─────────────── */

export async function securitySettings() {
  const int = async (key: string, fallback: number) => {
    const n = Number.parseInt(await getSetting(key), 10);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  return {
    requireApproval: (await getSetting("requireApproval")) !== "0",
    webSessionHours: await int("webSessionHours", 12),
    miniAppSessionDays: await int("miniAppSessionDays", 30),
    inactivityDays: await int("inactivityDays", 30),
  };
}

/* ─────────────── сообщения администраторам ─────────────── */

/** Только администраторам и без учёта персональных фильтров: это запрос на действие. */
export async function notifyAdmins(body: MaxNewMessageBody, excludeStaffId?: number) {
  const admins = await db
    .select()
    .from(schema.staff)
    .where(and(eq(schema.staff.role, "admin"), eq(schema.staff.status, "active")));
  for (const admin of admins) {
    if (admin.id === excludeStaffId || !admin.maxUserId) continue;
    await sendMessage({ maxUserId: admin.maxUserId, staffId: admin.id, body });
  }
}

const text = (t: string): MaxNewMessageBody => ({ text: t, format: "markdown" });

/* ─────────────── допуск новых сотрудников ─────────────── */

/**
 * Личность подтверждена (контакт + ФИО или подпись Mini App). Если включён
 * ручной допуск — ставим «ждёт допуска» и зовём админов, иначе открываем сразу.
 * Возвращает итоговый статус.
 */
export async function completeActivation(member: StaffRow, via: string): Promise<"active" | "awaiting_approval"> {
  const { requireApproval } = await securitySettings();
  // Админа допускать некому, если он единственный, — его карточку завёл другой админ или сид.
  const needsApproval = requireApproval && member.role !== "admin";

  await db
    .update(schema.staff)
    .set({
      status: needsApproval ? "awaiting_approval" : "active",
      activatedAt: needsApproval ? member.activatedAt : new Date(),
      blockReason: null,
      lastActivityAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(schema.staff.id, member.id));

  if (needsApproval) {
    await logAccess({ kind: "approval_requested", staffId: member.id, phone: member.phone, maxUserId: member.maxUserId, detail: via });
    await notifyAdmins(approvalRequestMessage(member, via));
    if (member.maxUserId) {
      await sendMessage({ maxUserId: member.maxUserId, staffId: member.id, body: awaitingApprovalMessage });
    }
    return "awaiting_approval";
  }

  await logAccess({ kind: "activated", staffId: member.id, phone: member.phone, maxUserId: member.maxUserId, detail: via });
  const [fresh] = await db.select().from(schema.staff).where(eq(schema.staff.id, member.id));
  await welcomeActivated(fresh ?? member);
  return "active";
}

/** Сообщение сотруднику об открытом доступе + карточка, если заявка уже назначена. */
export async function welcomeActivated(member: StaffRow) {
  await notifyDispatchers(
    text(`✅ Сотрудник активирован: *${member.fullName}* (+${member.phone}).`),
    { event: "staff_activated", excludeStaffId: member.id },
  );
  if (!member.maxUserId) return;

  const active = canExecute(member.role) ? await activeRequestForDriver(member.id) : null;
  if (active) {
    await sendDriverCard(active, `Доступ открыт. Ваша заявка ${active.number}`);
    return;
  }
  await sendMessage({
    maxUserId: member.maxUserId,
    staffId: member.id,
    body: text(
      `Доступ открыт, ${member.fullName}.\n` +
        (member.role === "driver"
          ? "Новые заявки будут приходить сюда. Статусы переключаются кнопками под заявкой."
          : "Панель диспетчеризации доступна по ссылке, вход — по номеру телефона и коду из этого чата."),
    ),
  });
}

type Decision = { ok: true; member: StaffRow } | { ok: false; reason: string };

export async function approveStaff(staffId: number, actor: StaffRow): Promise<Decision> {
  const [member] = await db.select().from(schema.staff).where(eq(schema.staff.id, staffId));
  if (!member) return { ok: false, reason: "Сотрудник не найден" };
  if (member.status !== "awaiting_approval") {
    return { ok: false, reason: `Уже обработано: статус «${member.status === "active" ? "активен" : member.status}»` };
  }
  // CAS: два админа нажали одновременно — допуск сработает один раз.
  const [row] = await db
    .update(schema.staff)
    .set({ status: "active", activatedAt: new Date(), lastActivityAt: new Date(), updatedAt: new Date() })
    .where(and(eq(schema.staff.id, staffId), eq(schema.staff.status, "awaiting_approval")))
    .returning();
  if (!row) return { ok: false, reason: "Уже обработано другим администратором" };

  await logAccess({ kind: "approved", staffId, phone: row.phone, maxUserId: row.maxUserId, detail: `Допустил: ${actor.fullName}` });
  await welcomeActivated(row);
  return { ok: true, member: row };
}

export async function rejectStaff(staffId: number, actor: StaffRow): Promise<Decision> {
  const [member] = await db.select().from(schema.staff).where(eq(schema.staff.id, staffId));
  if (!member) return { ok: false, reason: "Сотрудник не найден" };
  if (member.status !== "awaiting_approval") return { ok: false, reason: "Уже обработано" };

  // Отвязываем MAX: карточка возвращается в «не подтверждён», админ при желании выпустит новый инвайт.
  const [row] = await db
    .update(schema.staff)
    .set({ status: "pending", maxUserId: null, maxChatId: null, maxUsername: null, updatedAt: new Date() })
    .where(and(eq(schema.staff.id, staffId), eq(schema.staff.status, "awaiting_approval")))
    .returning();
  if (!row) return { ok: false, reason: "Уже обработано другим администратором" };

  await logAccess({ kind: "rejected", staffId, phone: member.phone, maxUserId: member.maxUserId, detail: `Отклонил: ${actor.fullName}` });
  if (member.maxUserId) {
    await sendMessage({
      maxUserId: member.maxUserId,
      staffId: member.id,
      body: text("Администратор отклонил доступ. Если это ошибка — свяжитесь с диспетчером."),
    });
  }
  return { ok: true, member: row };
}

/* ─────────────── защита входа по коду ─────────────── */

export const LOGIN_MAX_FAILURES = 5;
export const LOGIN_LOCK_MINUTES = 15;
const OTP_RESEND_SECONDS = 60;
const OTP_PER_HOUR = 5;

const timeHm = (d: Date) =>
  new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Moscow" }).format(d);

export function assertNotLocked(member: StaffRow) {
  if (member.loginLockedUntil && member.loginLockedUntil.getTime() > Date.now()) {
    throw new ORPCError("TOO_MANY_REQUESTS", {
      message: `Вход временно заблокирован после ${LOGIN_MAX_FAILURES} неверных кодов. Попробуйте после ${timeHm(member.loginLockedUntil)} (МСК) или обратитесь к администратору.`,
    });
  }
}

/** Ограничение частоты запроса кода: не чаще раза в минуту и не больше 5 в час. */
export async function assertCanRequestCode(member: StaffRow, phone: string) {
  const hourAgo = new Date(Date.now() - 3_600_000);
  const recent = await db
    .select({ createdAt: schema.otpCodes.createdAt })
    .from(schema.otpCodes)
    .where(and(eq(schema.otpCodes.staffId, member.id), gt(schema.otpCodes.createdAt, hourAgo)))
    .orderBy(desc(schema.otpCodes.id));

  const last = recent[0]?.createdAt;
  if (last) {
    const wait = Math.ceil((last.getTime() + OTP_RESEND_SECONDS * 1000 - Date.now()) / 1000);
    if (wait > 0) {
      throw new ORPCError("TOO_MANY_REQUESTS", { message: `Новый код можно запросить через ${wait} с` });
    }
  }
  if (recent.length >= OTP_PER_HOUR) {
    await logAccess({ kind: "otp_throttled", staffId: member.id, phone, detail: `${recent.length} кодов за час` });
    const unlock = new Date(recent[recent.length - 1]!.createdAt.getTime() + 3_600_000);
    throw new ORPCError("TOO_MANY_REQUESTS", {
      message: `Слишком много запросов кода. Следующий — после ${timeHm(unlock)} (МСК).`,
    });
  }
}

/** Неверный код: счётчик подряд идущих ошибок, на пятой — блокировка входа и сигнал админам. */
export async function registerLoginFailure(member: StaffRow, phone: string) {
  const failures = member.loginFailures + 1;
  if (failures < LOGIN_MAX_FAILURES) {
    await db.update(schema.staff).set({ loginFailures: failures }).where(eq(schema.staff.id, member.id));
    return { locked: false, left: LOGIN_MAX_FAILURES - failures };
  }

  const until = new Date(Date.now() + LOGIN_LOCK_MINUTES * 60_000);
  await db
    .update(schema.staff)
    .set({ loginFailures: 0, loginLockedUntil: until })
    .where(eq(schema.staff.id, member.id));
  // Все ещё действующие коды гасим — перебор продолжить нельзя.
  await db
    .update(schema.otpCodes)
    .set({ usedAt: new Date() })
    .where(and(eq(schema.otpCodes.staffId, member.id), gt(schema.otpCodes.expiresAt, new Date())));
  await logAccess({ kind: "login_locked", staffId: member.id, phone, detail: `До ${timeHm(until)} МСК` });

  await notifyAdmins(
    text(
      `🔐 *Перебор кода входа*\n${member.fullName} (+${member.phone}): ${LOGIN_MAX_FAILURES} неверных кодов подряд. ` +
        `Вход заблокирован до ${timeHm(until)} МСК. Снять блокировку можно в разделе «Сотрудники».`,
    ),
    member.id,
  );
  if (member.maxUserId) {
    await sendMessage({
      maxUserId: member.maxUserId,
      staffId: member.id,
      body: text(
        `🔐 Кто-то ввёл неверный код входа ${LOGIN_MAX_FAILURES} раз подряд. Вход в панель закрыт до ${timeHm(until)} МСК. ` +
          `Никому не сообщайте коды из этого чата.`,
      ),
    });
  }
  return { locked: true, left: 0 };
}

export async function clearLoginFailures(staffId: number) {
  await db
    .update(schema.staff)
    .set({ loginFailures: 0, loginLockedUntil: null })
    .where(eq(schema.staff.id, staffId));
}

/* ─────────────── устройства и сеансы ─────────────── */

/** Короткое имя устройства из User-Agent: «Chrome · Windows». */
export function deviceLabel(ua: string | null | undefined): string {
  if (!ua) return "Неизвестное устройство";
  const browser = /\bMAX\/\d/.test(ua)
    ? "Приложение MAX"
    : /YaBrowser/i.test(ua)
    ? "Яндекс Браузер"
    : /Edg\//i.test(ua)
      ? "Edge"
      : /OPR\//i.test(ua)
        ? "Opera"
        : /Firefox\//i.test(ua)
          ? "Firefox"
          : /Chrome\//i.test(ua)
            ? "Chrome"
            : /Safari\//i.test(ua)
              ? "Safari"
              : "Браузер";
  const os = /Android/i.test(ua)
    ? "Android"
    : /iPhone|iPad|iOS/i.test(ua)
      ? "iOS"
      : /Windows/i.test(ua)
        ? "Windows"
        : /Mac OS X|Macintosh/i.test(ua)
          ? "macOS"
          : /Linux/i.test(ua)
            ? "Linux"
            : "";
  return os ? `${browser} · ${os}` : browser;
}

/**
 * Вход в браузере с устройства, которого раньше не было у сотрудника, — сообщение
 * в MAX с кнопкой «Это не я». Для повторных входов с того же браузера — тишина.
 */
export async function noticeNewDevice(
  member: StaffRow,
  session: { id: number; ip: string | null; userAgent: string | null },
) {
  const previous = await db
    .select({ userAgent: schema.sessions.userAgent })
    .from(schema.sessions)
    .where(and(eq(schema.sessions.staffId, member.id), ne(schema.sessions.id, session.id)));
  const known = previous.some((p) => p.userAgent && p.userAgent === session.userAgent);
  if (known) return false;
  const device = deviceLabel(session.userAgent);
  await logAccess({ kind: "new_device", staffId: member.id, phone: member.phone, detail: `${device}${session.ip ? ` · ${session.ip}` : ""}` });
  // Первый вход вообще (истории сеансов нет) тоже стоит отметить, но без тревоги в чате.
  if (!previous.length) return false;
  if (member.maxUserId) {
    await sendMessage({ maxUserId: member.maxUserId, staffId: member.id, body: newDeviceMessage(device, session.ip) });
  }
  return true;
}

/** Повторные входы из Mini App на одном устройстве не плодят сеансы: старый заменяется новым. */
export async function replaceMiniAppSession(staffId: number, userAgent: string | null, keepId: number) {
  const rows = await db
    .select({ id: schema.sessions.id, userAgent: schema.sessions.userAgent })
    .from(schema.sessions)
    .where(and(eq(schema.sessions.staffId, staffId), eq(schema.sessions.kind, "miniapp"), ne(schema.sessions.id, keepId)));
  const stale = rows.filter((r) => r.userAgent === userAgent).map((r) => r.id);
  if (stale.length) await db.delete(schema.sessions).where(inArray(schema.sessions.id, stale));
}

export async function signOutEverywhere(member: StaffRow, detail: string) {
  await revokeSessions(member.id);
  await logAccess({ kind: "sessions_revoked", staffId: member.id, phone: member.phone, detail });
}

/* ─────────────── автоприостановка ─────────────── */

async function suspend(member: StaffRow, reason: "inactive" | "expired", detail: string) {
  const [row] = await db
    .update(schema.staff)
    .set({ status: "blocked", blockReason: reason, blockedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(schema.staff.id, member.id), eq(schema.staff.status, "active")))
    .returning();
  if (!row) return null;
  await revokeSessions(member.id);
  await db
    .update(schema.invites)
    .set({ revokedAt: new Date() })
    .where(eq(schema.invites.staffId, member.id));
  await logAccess({ kind: "suspended", staffId: member.id, phone: member.phone, maxUserId: member.maxUserId, detail });
  if (member.maxUserId) {
    await sendMessage({
      maxUserId: member.maxUserId,
      staffId: member.id,
      body: text(`Доступ приостановлен: ${detail}. Для восстановления обратитесь к администратору.`),
    });
  }
  return row;
}

const fmtDate = (d: Date) =>
  new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Europe/Moscow" }).format(d);

let lastAccessCheck = 0;

/**
 * Раз в 10 минут: приостановить сотрудников с истёкшим сроком доступа и давно
 * неактивных. Админов не трогаем — иначе можно остаться без администратора.
 * Водителя с открытой заявкой по неактивности не приостанавливаем.
 */
export async function runAccessChecks(force = false) {
  if (!force && Date.now() - lastAccessCheck < 10 * 60_000) return [];
  lastAccessCheck = Date.now();

  const { inactivityDays } = await securitySettings();
  const members = await db
    .select()
    .from(schema.staff)
    .where(and(eq(schema.staff.status, "active"), ne(schema.staff.role, "admin")));

  const suspended: { member: StaffRow; detail: string; openRequests: string[] }[] = [];
  for (const member of members) {
    let reason: "inactive" | "expired" | null = null;
    let detail = "";
    if (member.accessUntil && member.accessUntil.getTime() <= Date.now()) {
      reason = "expired";
      detail = `срок доступа истёк ${fmtDate(member.accessUntil)}`;
    } else if (inactivityDays > 0) {
      const seen = member.lastActivityAt ?? member.activatedAt;
      if (seen && Date.now() - seen.getTime() > inactivityDays * 86_400_000) {
        reason = "inactive";
        detail = `не было активности ${inactivityDays} дн. (последняя ${fmtDate(seen)})`;
      }
    }
    if (!reason) continue;

    const open =
      member.role === "driver"
        ? await db
            .select({ number: schema.requests.number })
            .from(schema.requests)
            .where(and(eq(schema.requests.driverId, member.id), notInArray(schema.requests.status, [...CLOSED_STATUSES])))
        : [];
    if (reason === "inactive" && open.length) continue;

    const row = await suspend(member, reason, detail);
    if (row) suspended.push({ member, detail, openRequests: open.map((o) => o.number) });
  }

  await purgeOldSessions();
  if (suspended.length) {
    const lines = suspended.map(
      (s) =>
        `• ${s.member.fullName}: ${s.detail}` +
        (s.openRequests.length ? ` — ⚠️ открытые заявки ${s.openRequests.join(", ")}, переназначьте` : ""),
    );
    await notifyAdmins(text(`⏸ *Доступ приостановлен автоматически*\n${lines.join("\n")}`));
  }
  return suspended;
}

/** Старые сеансы (истёкшие больше 60 дней назад) больше не нужны даже для распознавания устройств. */
export async function purgeOldSessions() {
  await db
    .delete(schema.sessions)
    .where(and(isNotNull(schema.sessions.expiresAt), lt(schema.sessions.expiresAt, new Date(Date.now() - 60 * 86_400_000))));
}
