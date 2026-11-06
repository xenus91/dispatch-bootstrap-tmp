import { ORPCError } from "@orpc/server";
import { and, eq, gt, isNull } from "drizzle-orm";
import { base } from "../core/app";
import { db } from "../database";
import * as schema from "../database/schema";
import { maxConfig } from "../max/client";
import { normalizePhone } from "./domain";
import { getSetting } from "./settings";

export type StaffRow = typeof schema.staff.$inferSelect;
export type SessionKind = "web" | "miniapp";

export function randomToken(bytes = 32): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Код из 6 цифр для OTP / инвайта. */
export function randomDigits(len = 6): string {
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => String(b % 10)).join("");
}

export function inviteCode(): string {
  // Без похожих символов — код диктуют голосом/пересылают вручную.
  const alphabet = "ACDEFGHJKLMNPQRTUVWXY34679";
  const arr = new Uint8Array(10);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => alphabet[b % alphabet.length]).join("");
}

/** IP и браузер клиента — для списка сеансов и распознавания нового устройства. */
export function clientMeta(headers: Headers) {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = forwarded || headers.get("x-real-ip") || headers.get("cf-connecting-ip") || null;
  const userAgent = headers.get("user-agent")?.slice(0, 400) || null;
  return { ip, userAgent };
}

async function sessionTtlMs(kind: SessionKind) {
  if (kind === "miniapp") {
    const days = Number.parseInt(await getSetting("miniAppSessionDays"), 10);
    return (Number.isFinite(days) && days > 0 ? days : 30) * 86_400_000;
  }
  const hours = Number.parseInt(await getSetting("webSessionHours"), 10);
  return (Number.isFinite(hours) && hours > 0 ? hours : 12) * 3_600_000;
}

export async function createSession(
  staffId: number,
  meta: { kind: SessionKind; ip?: string | null; userAgent?: string | null },
) {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + (await sessionTtlMs(meta.kind)));
  const [row] = await db
    .insert(schema.sessions)
    .values({ token, staffId, expiresAt, kind: meta.kind, ip: meta.ip ?? null, userAgent: meta.userAgent ?? null })
    .returning();
  return { token, expiresAt, id: row!.id };
}

/** Последняя активность пишется не чаще раза в 5 минут на сотрудника. */
const touched = new Map<number, number>();
export async function touchActivity(staffId: number) {
  const last = touched.get(staffId) ?? 0;
  if (Date.now() - last < 5 * 60_000) return;
  touched.set(staffId, Date.now());
  await db.update(schema.staff).set({ lastActivityAt: new Date() }).where(eq(schema.staff.id, staffId));
}

export function bearerToken(headers: Headers) {
  const raw = headers.get("authorization") ?? "";
  return raw.replace(/^Bearer\s+/i, "").trim();
}

export async function resolveSessionFull(headers: Headers) {
  const token = bearerToken(headers);
  if (!token) return null;

  const [session] = await db
    .select()
    .from(schema.sessions)
    .where(and(eq(schema.sessions.token, token), gt(schema.sessions.expiresAt, new Date())));
  if (!session) return null;

  const [member] = await db.select().from(schema.staff).where(eq(schema.staff.id, session.staffId));
  if (!member || member.status !== "active") return null;

  await db
    .update(schema.sessions)
    .set({ lastSeenAt: new Date() })
    .where(eq(schema.sessions.id, session.id));
  await touchActivity(member.id);
  return { member, session };
}

export async function resolveSession(headers: Headers): Promise<StaffRow | null> {
  return (await resolveSessionFull(headers))?.member ?? null;
}

export async function revokeSessions(staffId: number) {
  await db.delete(schema.sessions).where(eq(schema.sessions.staffId, staffId));
}

/** Процедуры, доступные любому авторизованному сотруднику. */
export const authed = base.use(async ({ context, next }) => {
  const resolved = await resolveSessionFull(context.headers);
  if (!resolved) throw new ORPCError("UNAUTHORIZED", { message: "Требуется вход" });
  return next({ context: { user: resolved.member, sessionId: resolved.session.id } });
});

/** Диспетчер и админ — работа с заявками. */
export const dispatcherOnly = authed.use(async ({ context, next }) => {
  if (context.user.role !== "dispatcher" && context.user.role !== "admin") {
    throw new ORPCError("FORBIDDEN", { message: "Доступно только диспетчеру" });
  }
  return next();
});

/** Только админ — управление сотрудниками и настройками. */
export const adminOnly = authed.use(async ({ context, next }) => {
  if (context.user.role !== "admin") {
    throw new ORPCError("FORBIDDEN", { message: "Доступно только администратору" });
  }
  return next();
});

export async function findStaffByPhone(phone: string) {
  const normalized = normalizePhone(phone);
  if (!normalized) return null;
  const [row] = await db.select().from(schema.staff).where(eq(schema.staff.phone, normalized));
  return row ?? null;
}

export async function findStaffByMaxUserId(maxUserId: string) {
  const [row] = await db.select().from(schema.staff).where(eq(schema.staff.maxUserId, maxUserId));
  return row ?? null;
}

export async function logAccess(event: {
  kind: string;
  staffId?: number | null;
  phone?: string | null;
  maxUserId?: string | null;
  detail?: string | null;
}) {
  await db.insert(schema.accessEvents).values({
    kind: event.kind,
    staffId: event.staffId ?? null,
    phone: event.phone ?? null,
    maxUserId: event.maxUserId ?? null,
    detail: event.detail ?? null,
  });
}

/** Deep-link на бота с кодом инвайта — им сотрудник привязывает свой MAX. */
export function inviteLink(code: string) {
  const username = maxConfig.botUsername || "bot";
  return `https://max.ru/${username}/start?start=${code}`;
}

/**
 * Режим dev-входа: код OTP возвращается в панель, даже если MAX ещё не привязан.
 * Нужен для приёмки панели до подключения бота; в продакшене выключен всегда.
 */
export const devLoginEnabled = () =>
  process.env.DEV_LOGIN === "1" && process.env.NODE_ENV !== "production";

/**
 * Пока у первого администратора нет привязки MAX, держим для него живой инвайт
 * и печатаем ссылку в лог — иначе привязать аккаунт не сможет никто.
 */
async function ensureBootstrapInvite(admin: StaffRow) {
  if (admin.maxUserId) return;
  const [live] = await db
    .select()
    .from(schema.invites)
    .where(
      and(
        eq(schema.invites.staffId, admin.id),
        isNull(schema.invites.usedAt),
        isNull(schema.invites.revokedAt),
        gt(schema.invites.expiresAt, new Date()),
      ),
    );
  const code = live?.code ?? inviteCode();
  if (!live) {
    await db.insert(schema.invites).values({
      code,
      staffId: admin.id,
      ttlHours: 168,
      expiresAt: new Date(Date.now() + 168 * 3_600_000),
    });
  }
  console.log(`[auth] привязка MAX для администратора: ${inviteLink(code)} (код ${code})`);
}

/**
 * Первый администратор заводится при разворачивании: без него в систему
 * невозможно войти (инвайты выдаёт только админ).
 * Телефон берётся из SEED_ADMIN_PHONE, ФИО — из SEED_ADMIN_NAME.
 */
export async function ensureSeedAdmin() {
  const phone = normalizePhone(process.env.SEED_ADMIN_PHONE ?? "");
  if (!phone) return;
  const existing = await findStaffByPhone(phone);
  if (existing) {
    await ensureBootstrapInvite(existing);
    return;
  }
  // Если админ уже есть (например, номер в карточке поменяли на реальный),
  // второго не создаём — иначе в системе появятся дубликаты карточек.
  const [anyAdmin] = await db
    .select()
    .from(schema.staff)
    .where(eq(schema.staff.role, "admin"))
    .orderBy(schema.staff.id);
  if (anyAdmin) {
    await ensureBootstrapInvite(anyAdmin);
    return;
  }
  const [created] = await db
    .insert(schema.staff)
    .values({
      role: "admin",
      fullName: process.env.SEED_ADMIN_NAME ?? "Администратор",
      phone,
      status: "active",
      activatedAt: new Date(),
      note: "Создан автоматически при разворачивании системы",
    })
    .returning();
  console.log(`[auth] создан первый администратор: +${phone}`);
  if (created) await ensureBootstrapInvite(created);
}
