import { ORPCError } from "@orpc/server";
import { and, eq, gt, isNull } from "drizzle-orm";
import { z } from "zod";
import { base } from "../core/app";
import { db } from "../database";
import * as schema from "../database/schema";
import {
  assertCanRequestCode,
  assertNotLocked,
  clearLoginFailures,
  completeActivation,
  noticeNewDevice,
  registerLoginFailure,
  replaceMiniAppSession,
} from "../lib/access";
import {
  authed,
  bearerToken,
  clientMeta,
  createSession,
  devLoginEnabled,
  findStaffByMaxUserId,
  findStaffByPhone,
  logAccess,
  randomDigits,
  resolveSession,
} from "../lib/auth";
import { normalizePhone, CONSENT_VERSION } from "../lib/domain";
import { isStubMode, maxConfig } from "../max/client";
import { verifyContactHash, verifyInitData } from "../max/initdata";
import { otpMessage } from "../max/messages";
import { sendMessage } from "../max/client";

const OTP_TTL_MS = 5 * 60_000;
const MAX_ATTEMPTS = 5;

export const auth = {
  /** Шаг 1: телефон → код в личный чат MAX. */
  requestCode: base
    .input(z.object({ phone: z.string().min(5), consent: z.boolean() }))
    .handler(async ({ input }) => {
      const phone = normalizePhone(input.phone);
      const member = await findStaffByPhone(phone);

      // Согласие на обработку персональных данных обязательно (ст. 9 152-ФЗ):
      // без него номер телефона обрабатывать нельзя, даже чтобы отправить код.
      if (!input.consent) {
        throw new ORPCError("BAD_REQUEST", {
          message: "Нужно согласие на обработку персональных данных",
        });
      }
      if (member) {
        await db
          .update(schema.staff)
          .set({ consentAt: new Date(), consentVersion: CONSENT_VERSION, updatedAt: new Date() })
          .where(eq(schema.staff.id, member.id));
      }
      // До привязки MAX вход возможен только в режиме dev-входа (приёмка панели).
      const canDevLogin = !!member && member.status === "active" && devLoginEnabled();

      // Не раскрываем, есть ли такой сотрудник — одинаковый ответ в любом случае.
      if (!member || member.status !== "active" || (!member.maxUserId && !canDevLogin)) {
        await logAccess({
          kind: member ? "otp_failed" : "stranger",
          staffId: member?.id ?? null,
          phone,
          detail: member
            ? `Вход отклонён: статус «${member.status}», привязка MAX ${member.maxUserId ? "есть" : "отсутствует"}`
            : "Вход по неизвестному номеру",
        });
        return { sent: true, stub: false, devCode: null as string | null };
      }

      assertNotLocked(member);
      await assertCanRequestCode(member, phone);

      const code = randomDigits(6);
      await db.insert(schema.otpCodes).values({
        staffId: member.id,
        code,
        expiresAt: new Date(Date.now() + OTP_TTL_MS),
      });
      if (member.maxUserId) {
        await sendMessage({ maxUserId: member.maxUserId, staffId: member.id, body: otpMessage(code) });
      }
      await logAccess({ kind: "otp_sent", staffId: member.id, phone });

      // Заглушка или dev-вход: код показываем в панели — иначе войти невозможно.
      const showCode = isStubMode() || !member.maxUserId || devLoginEnabled();
      return { sent: true, stub: isStubMode(), devCode: showCode ? code : null };
    }),

  /** Шаг 2: проверка кода → сессия. */
  verifyCode: base
    .input(z.object({ phone: z.string().min(5), code: z.string().min(4).max(8) }))
    .handler(async ({ input, context }) => {
      const phone = normalizePhone(input.phone);
      const member = await findStaffByPhone(phone);
      if (!member || member.status !== "active") {
        throw new ORPCError("UNAUTHORIZED", { message: "Неверный номер или код" });
      }
      assertNotLocked(member);

      const [otp] = await db
        .select()
        .from(schema.otpCodes)
        .where(
          and(
            eq(schema.otpCodes.staffId, member.id),
            isNull(schema.otpCodes.usedAt),
            gt(schema.otpCodes.expiresAt, new Date()),
          ),
        )
        .orderBy(schema.otpCodes.id)
        .limit(10)
        .then((rows) => rows.reverse());

      if (!otp) {
        await logAccess({ kind: "otp_failed", staffId: member.id, phone, detail: "Код истёк или не запрошен" });
        throw new ORPCError("UNAUTHORIZED", { message: "Код истёк — запросите новый" });
      }
      if (otp.attempts >= MAX_ATTEMPTS) {
        throw new ORPCError("TOO_MANY_REQUESTS", { message: "Слишком много попыток — запросите новый код" });
      }
      if (otp.code !== input.code.trim()) {
        await db
          .update(schema.otpCodes)
          .set({ attempts: otp.attempts + 1 })
          .where(eq(schema.otpCodes.id, otp.id));
        await logAccess({ kind: "otp_failed", staffId: member.id, phone, detail: "Неверный код" });
        const result = await registerLoginFailure(member, phone);
        if (result.locked) {
          throw new ORPCError("TOO_MANY_REQUESTS", {
            message: "Слишком много неверных кодов. Вход временно заблокирован, администратор уведомлён.",
          });
        }
        throw new ORPCError("UNAUTHORIZED", { message: `Неверный код. Осталось попыток: ${result.left}` });
      }

      await db.update(schema.otpCodes).set({ usedAt: new Date() }).where(eq(schema.otpCodes.id, otp.id));
      await clearLoginFailures(member.id);
      const meta = clientMeta(context.headers);
      const session = await createSession(member.id, { kind: "web", ...meta });
      await logAccess({ kind: "login_ok", staffId: member.id, phone });
      await noticeNewDevice(member, { id: session.id, ...meta });

      return {
        token: session.token,
        expiresAt: session.expiresAt,
        user: {
          id: member.id,
          fullName: member.fullName,
          role: member.role,
          phone: member.phone,
        },
      };
    }),

  /**
   * Вход из мини-приложения MAX без кода: личность подтверждает подпись
   * стартовых параметров (initData), выданная клиентом MAX и проверенная
   * токеном бота. OTP в этом случае не нужен — пользователь уже внутри MAX.
   */
  miniAppLogin: base
    .input(z.object({ initData: z.string().min(10) }))
    .handler(async ({ input, context }) => {
      const verified = verifyInitData(input.initData);
      if (!verified.ok) {
        await logAccess({ kind: "miniapp_invalid", detail: verified.error });
        throw new ORPCError("UNAUTHORIZED", { message: verified.error });
      }
      const maxUserId = String(verified.data.user.id);
      const member = await findStaffByMaxUserId(maxUserId);

      if (!member) {
        await logAccess({
          kind: "miniapp_unknown",
          maxUserId,
          detail: "Аккаунт MAX не привязан ни к одной карточке сотрудника",
        });
        // Не ошибка: панель предложит войти по телефону + коду либо привязать аккаунт.
        return {
          linked: false as const,
          token: null,
          expiresAt: null,
          user: null,
          maxUserId,
          firstName: verified.data.user.first_name ?? null,
        };
      }
      if (member.status === "awaiting_approval") {
        throw new ORPCError("FORBIDDEN", {
          message: "Личность подтверждена. Доступ откроется после допуска администратором — бот пришлёт сообщение.",
        });
      }
      if (member.status !== "active") {
        await logAccess({
          kind: "access_denied",
          staffId: member.id,
          maxUserId,
          detail: `Вход из мини-приложения при статусе «${member.status}»`,
        });
        throw new ORPCError("FORBIDDEN", { message: "Доступ закрыт. Обратитесь к администратору." });
      }

      // Чат мини-приложения пригодится боту для отправки уведомлений.
      if (verified.data.chatId && member.maxChatId !== verified.data.chatId) {
        await db
          .update(schema.staff)
          .set({ maxChatId: verified.data.chatId, updatedAt: new Date() })
          .where(eq(schema.staff.id, member.id));
      }

      const meta = clientMeta(context.headers);
      const session = await createSession(member.id, { kind: "miniapp", ...meta });
      await replaceMiniAppSession(member.id, meta.userAgent, session.id);
      await logAccess({ kind: "login_ok", staffId: member.id, maxUserId, detail: "Вход из мини-приложения MAX" });
      return {
        linked: true as const,
        token: session.token,
        expiresAt: session.expiresAt,
        user: {
          id: member.id,
          fullName: member.fullName,
          role: member.role,
          phone: member.phone,
        },
        maxUserId,
        firstName: verified.data.user.first_name ?? null,
      };
    }),

  /**
   * Привязка аккаунта прямо из мини-приложения: номер берётся нативным окном
   * MAX (WebApp.requestContact) и приходит с подписью — сверяем её и номер
   * с карточкой сотрудника. Инвайт в этом сценарии не нужен: обе стороны
   * подтверждены подписями бота.
   */
  miniAppLink: base
    .input(
      z.object({
        initData: z.string().min(10),
        phone: z.string().min(5),
        authDate: z.string().min(1),
        hash: z.string().min(10),
      }),
    )
    .handler(async ({ input, context }) => {
      const verified = verifyInitData(input.initData);
      if (!verified.ok) throw new ORPCError("UNAUTHORIZED", { message: verified.error });
      const maxUserId = String(verified.data.user.id);

      const contactOk = verifyContactHash({
        phone: input.phone,
        authDate: input.authDate,
        hash: input.hash,
        userId: maxUserId,
      });
      if (!contactOk) {
        await logAccess({ kind: "contact_invalid", maxUserId, detail: "Подпись номера из мини-приложения не совпала" });
        throw new ORPCError("UNAUTHORIZED", { message: "MAX не подтвердил номер телефона." });
      }

      const phone = normalizePhone(input.phone);
      const member = await findStaffByPhone(phone);
      if (!member || member.status === "blocked") {
        await logAccess({
          kind: member ? "access_denied" : "stranger",
          staffId: member?.id ?? null,
          phone,
          maxUserId,
          detail: "Привязка из мини-приложения по номеру без активной карточки",
        });
        throw new ORPCError("FORBIDDEN", {
          message: "Доступ не предоставлен. Обратитесь к диспетчеру или администратору автопарка.",
        });
      }
      // Чужой MAX-аккаунт на уже привязанной карточке — подмена, не пускаем.
      if (member.maxUserId && member.maxUserId !== maxUserId) {
        await logAccess({
          kind: "access_denied",
          staffId: member.id,
          phone,
          maxUserId,
          detail: `Карточка уже привязана к другому аккаунту MAX (${member.maxUserId})`,
        });
        throw new ORPCError("FORBIDDEN", { message: "Карточка сотрудника привязана к другому аккаунту MAX." });
      }

      const alreadyActive = member.status === "active";
      await db
        .update(schema.staff)
        .set({
          maxUserId,
          maxChatId: verified.data.chatId ?? member.maxChatId,
          maxUsername: verified.data.user.username ?? member.maxUsername,
          updatedAt: new Date(),
        })
        .where(eq(schema.staff.id, member.id));
      const fresh = (await findStaffByMaxUserId(maxUserId)) ?? member;

      // Уже ждёт допуска — повторно админов не зовём.
      const status = alreadyActive
        ? "active"
        : fresh.status === "awaiting_approval"
          ? "awaiting_approval"
          : await completeActivation(fresh, "мини-приложение MAX");
      const user = { id: fresh.id, fullName: fresh.fullName, role: fresh.role, phone: fresh.phone };
      if (status === "awaiting_approval") {
        return { pending: true as const, token: null, expiresAt: null, user };
      }

      const meta = clientMeta(context.headers);
      const session = await createSession(member.id, { kind: "miniapp", ...meta });
      await replaceMiniAppSession(member.id, meta.userAgent, session.id);
      await logAccess({ kind: "login_ok", staffId: member.id, phone, maxUserId, detail: "Привязка и вход через мини-приложение MAX" });
      return { pending: false as const, token: session.token, expiresAt: session.expiresAt, user };
    }),

  /** Текущий пользователь (null, если не авторизован). */
  me: base.handler(async ({ context }) => {
    const member = await resolveSession(context.headers);
    if (!member) return null;
    return {
      id: member.id,
      fullName: member.fullName,
      role: member.role,
      phone: member.phone,
      maxUserId: member.maxUserId,
    };
  }),

  logout: authed.handler(async ({ context }) => {
    // Сеанс не удаляем, а гасим: браузер остаётся «знакомым» и следующий вход не вызовет тревогу о новом устройстве.
    const token = bearerToken(context.headers);
    if (token) {
      await db.update(schema.sessions).set({ expiresAt: new Date() }).where(eq(schema.sessions.token, token));
    }
    return { ok: true };
  }),

  /** Состояние интеграции с MAX — для экрана входа и настроек. */
  botStatus: base.handler(() => ({
    stub: isStubMode(),
    miniAppUrl: maxConfig.miniAppUrl,
    devLogin: devLoginEnabled(),
    hasToken: maxConfig.hasToken,
    baseUrl: maxConfig.baseUrl,
    botUsername: maxConfig.botUsername,
  })),
};
