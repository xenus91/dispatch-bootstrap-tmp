import { ORPCError } from "@orpc/server";
import { and, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import { z } from "zod";
import { db } from "../database";
import * as schema from "../database/schema";
import {
  adminOnly,
  authed,
  dispatcherOnly,
  inviteCode,
  inviteLink,
  logAccess,
  revokeSessions,
} from "../lib/auth";
import { approveStaff, clearLoginFailures, rejectStaff } from "../lib/access";
import { INVITE_TTL_PRESETS, normalizePhone } from "../lib/domain";
import { clientIp, describeChanges, logAudit } from "../lib/audit";
import { eraseStaffData, exportStaffData } from "../lib/personal-data";

const roleEnum = z.enum(["admin", "dispatcher", "driver"]);
const ttlEnum = z.union([z.literal(1), z.literal(24), z.literal(72), z.literal(168)]);

export const staff = {
  /** Список сотрудников + актуальный инвайт по каждому. */
  list: adminOnly
    .input(z.object({ role: roleEnum.optional() }).optional())
    .handler(async ({ input }) => {
      const rows = input?.role
        ? await db.select().from(schema.staff).where(eq(schema.staff.role, input.role))
        : await db.select().from(schema.staff);

      const invites = await db
        .select()
        .from(schema.invites)
        .where(and(isNull(schema.invites.usedAt), isNull(schema.invites.revokedAt)))
        .orderBy(desc(schema.invites.id));

      return rows
        .sort((a, b) => a.fullName.localeCompare(b.fullName, "ru"))
        .map((member) => {
          const invite = invites.find((i) => i.staffId === member.id);
          return {
            ...member,
            invite: invite
              ? {
                  id: invite.id,
                  code: invite.code,
                  link: inviteLink(invite.code),
                  expiresAt: invite.expiresAt,
                  expired: invite.expiresAt.getTime() < Date.now(),
                  ttlHours: invite.ttlHours,
                }
              : null,
          };
        });
    }),

  /**
   * Водители для назначения: все незаблокированные; inBot — уже активирован в MAX.
   * Администратору в конец списка добавляется он сам (selfTest) — для тестового рейса.
   */
  assignableDrivers: dispatcherOnly.handler(async ({ context }) => {
    const rows = await db
      .select()
      .from(schema.staff)
      .where(and(eq(schema.staff.role, "driver"), ne(schema.staff.status, "blocked")));
    const toItem = (r: typeof schema.staff.$inferSelect, selfTest = false) => ({
      id: r.id,
      fullName: r.fullName,
      phone: r.phone,
      vehicle: r.vehicle,
      inBot: r.status === "active" && !!r.maxUserId,
      selfTest,
    });
    const list = rows.map((r) => toItem(r)).sort((a, b) => a.fullName.localeCompare(b.fullName, "ru"));
    if (context.user.role === "admin") {
      const [me] = await db.select().from(schema.staff).where(eq(schema.staff.id, context.user.id));
      if (me) list.push(toItem(me, true));
    }
    return list;
  }),

  create: adminOnly
    .input(
      z.object({
        role: roleEnum,
        fullName: z.string().min(3),
        phone: z.string().min(5),
        vehicle: z.string().optional(),
        note: z.string().optional(),
        /** Доступ до даты (окончание договора) */
        accessUntil: z.coerce.date().nullable().optional(),
        /** Сразу выпустить инвайт с выбранным сроком */
        inviteTtlHours: ttlEnum.optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      const phone = normalizePhone(input.phone);
      if (phone.length < 10) throw new ORPCError("BAD_REQUEST", { message: "Некорректный номер телефона" });

      const [existing] = await db.select().from(schema.staff).where(eq(schema.staff.phone, phone));
      if (existing) {
        throw new ORPCError("CONFLICT", {
          message: `Сотрудник с номером +${phone} уже есть: ${existing.fullName}`,
        });
      }

      const [member] = await db
        .insert(schema.staff)
        .values({
          role: input.role,
          fullName: input.fullName.trim(),
          phone,
          vehicle: input.vehicle?.trim() || null,
          note: input.note?.trim() || null,
          accessUntil: input.role === "admin" ? null : (input.accessUntil ?? null),
          status: "pending",
          createdById: context.user.id,
        })
        .returning();
      if (!member) throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "Не удалось создать карточку" });

      await logAudit({
        actor: context.user,
        action: "staff.create",
        targetType: "staff",
        targetId: member.id,
        detail: `Роль: ${input.role}, телефон: +${phone}`,
        ip: clientIp(context.headers),
      });

      let invite: { code: string; link: string; expiresAt: Date } | null = null;
      if (input.inviteTtlHours) {
        const code = inviteCode();
        const expiresAt = new Date(Date.now() + input.inviteTtlHours * 3_600_000);
        await db.insert(schema.invites).values({
          code,
          staffId: member.id,
          createdById: context.user.id,
          ttlHours: input.inviteTtlHours,
          expiresAt,
        });
        invite = { code, link: inviteLink(code), expiresAt };
      }

      return { member, invite };
    }),

  update: adminOnly
    .input(
      z.object({
        id: z.number(),
        fullName: z.string().min(3).optional(),
        phone: z.string().min(5).optional(),
        role: roleEnum.optional(),
        vehicle: z.string().nullable().optional(),
        note: z.string().nullable().optional(),
        accessUntil: z.coerce.date().nullable().optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      const { id, ...rest } = input;
      const [current] = await db.select().from(schema.staff).where(eq(schema.staff.id, id));
      if (!current) throw new ORPCError("NOT_FOUND", { message: "Сотрудник не найден" });

      const patch: Partial<typeof schema.staff.$inferInsert> = { updatedAt: new Date() };
      if (rest.fullName) patch.fullName = rest.fullName.trim();

      if (rest.role && rest.role !== current.role) {
        if (id === context.user.id) {
          throw new ORPCError("BAD_REQUEST", { message: "Нельзя изменить собственную роль" });
        }
        if (current.role === "admin") {
          const admins = await db
            .select({ id: schema.staff.id })
            .from(schema.staff)
            .where(and(eq(schema.staff.role, "admin"), ne(schema.staff.status, "blocked")));
          if (admins.length <= 1) {
            throw new ORPCError("BAD_REQUEST", { message: "Нельзя снять роль с последнего администратора" });
          }
        }
        if (current.role === "driver" || current.role === "admin") {
          // У админа могут быть тестовые рейсы, назначенные на себя.
          const open = await db
            .select({ id: schema.requests.id, status: schema.requests.status })
            .from(schema.requests)
            .where(eq(schema.requests.driverId, id));
          if (open.some((r) => r.status !== "cancelled" && r.status !== "delivered")) {
            throw new ORPCError("BAD_REQUEST", {
              message: "У сотрудника есть незакрытые заявки — переназначьте их перед сменой роли",
            });
          }
        }
        patch.role = rest.role;
      }
      if (rest.vehicle !== undefined) patch.vehicle = rest.vehicle?.trim() || null;
      if (rest.note !== undefined) patch.note = rest.note?.trim() || null;
      if (rest.accessUntil !== undefined) {
        // Срок доступа для админа не ставим — автоприостановка админов отключена.
        patch.accessUntil = (patch.role ?? current.role) === "admin" ? null : rest.accessUntil;
      }
      if (rest.phone) {
        const phone = normalizePhone(rest.phone);
        const [clash] = await db
          .select()
          .from(schema.staff)
          .where(and(eq(schema.staff.phone, phone), ne(schema.staff.id, id)));
        if (clash) throw new ORPCError("CONFLICT", { message: "Номер занят другим сотрудником" });
        if (phone !== current.phone) {
          patch.phone = phone;
          // Номер подтверждён в MAX — при смене привязку нужно пройти заново.
          if (current.maxUserId) {
            patch.maxUserId = null;
            patch.maxChatId = null;
            patch.maxUsername = null;
            if (current.status === "active" || current.status === "awaiting_approval") patch.status = "pending";
          }
        }
      }
      const [row] = await db.update(schema.staff).set(patch).where(eq(schema.staff.id, id)).returning();
      if (!row) throw new ORPCError("NOT_FOUND", { message: "Сотрудник не найден" });
      // Смена роли или отвязка MAX — завершаем активные сессии, права пересчитаются при входе.
      if (patch.role || patch.maxUserId === null) await revokeSessions(id);

      const changes = describeChanges(current, row);
      if (changes) {
        await logAudit({
          actor: context.user,
          action: "staff.update",
          targetType: "staff",
          targetId: id,
          detail: changes,
          ip: clientIp(context.headers),
        });
      }
      return { ...row, relinkRequired: patch.maxUserId === null };
    }),

  /** Выпуск нового инвайта: срок — из пресетов, старые активные отзываются. */
  issueInvite: adminOnly
    .input(z.object({ staffId: z.number(), ttlHours: ttlEnum }))
    .handler(async ({ input, context }) => {
      const [member] = await db.select().from(schema.staff).where(eq(schema.staff.id, input.staffId));
      if (!member) throw new ORPCError("NOT_FOUND", { message: "Сотрудник не найден" });
      if (member.status === "blocked") {
        throw new ORPCError("BAD_REQUEST", { message: "Сначала разблокируйте сотрудника" });
      }

      await db
        .update(schema.invites)
        .set({ revokedAt: new Date() })
        .where(and(eq(schema.invites.staffId, member.id), isNull(schema.invites.usedAt), isNull(schema.invites.revokedAt)));

      const code = inviteCode();
      const expiresAt = new Date(Date.now() + input.ttlHours * 3_600_000);
      const [invite] = await db
        .insert(schema.invites)
        .values({
          code,
          staffId: member.id,
          createdById: context.user.id,
          ttlHours: input.ttlHours,
          expiresAt,
        })
        .returning();

      await logAudit({
        actor: context.user,
        action: "staff.invite_issued",
        targetType: "staff",
        targetId: member.id,
        detail: `Приглашение на ${input.ttlHours} ч`,
        ip: clientIp(context.headers),
      });
      return { ...invite, link: inviteLink(code) };
    }),

  revokeInvite: adminOnly.input(z.object({ inviteId: z.number() })).handler(async ({ input, context }) => {
    await db
      .update(schema.invites)
      .set({ revokedAt: new Date() })
      .where(eq(schema.invites.id, input.inviteId));
    await logAudit({
      actor: context.user,
      action: "staff.invite_revoked",
      targetType: "staff",
      targetId: input.inviteId,
      detail: "Приглашение отозвано",
      ip: clientIp(context.headers),
    });
    return { ok: true };
  }),

  /** Блокировка/разблокировка: закрывает и бота, и панель. */
  setBlocked: adminOnly
    .input(z.object({ id: z.number(), blocked: z.boolean() }))
    .handler(async ({ input, context }) => {
      if (input.id === context.user.id) {
        throw new ORPCError("BAD_REQUEST", { message: "Нельзя заблокировать собственную учётную запись" });
      }
      const [member] = await db.select().from(schema.staff).where(eq(schema.staff.id, input.id));
      if (!member) throw new ORPCError("NOT_FOUND", { message: "Сотрудник не найден" });

      await logAudit({
        actor: context.user,
        action: input.blocked ? "staff.blocked" : "staff.unblocked",
        targetType: "staff",
        targetId: input.id,
        detail: `${member.fullName} (${member.role})`,
        ip: clientIp(context.headers),
      });
      if (!input.blocked && member.accessUntil && member.accessUntil.getTime() <= Date.now()) {
        throw new ORPCError("BAD_REQUEST", {
          message: "Срок доступа истёк — сначала продлите его в карточке сотрудника («Изменить» → «Доступ до»)",
        });
      }
      const status = input.blocked ? "blocked" : member.maxUserId ? "active" : "pending";
      const [row] = await db
        .update(schema.staff)
        .set({
          status,
          blockedAt: input.blocked ? new Date() : null,
          blockReason: input.blocked ? "manual" : null,
          // Отсчёт неактивности начинается заново, иначе планировщик сразу приостановит снова.
          lastActivityAt: input.blocked ? member.lastActivityAt : new Date(),
          updatedAt: new Date(),
        })
        .where(eq(schema.staff.id, input.id))
        .returning();

      if (input.blocked) {
        await revokeSessions(input.id);
        await db
          .update(schema.invites)
          .set({ revokedAt: new Date() })
          .where(and(eq(schema.invites.staffId, input.id), isNull(schema.invites.usedAt)));
      }
      await logAccess({
        kind: input.blocked ? "revoked" : "activated",
        staffId: input.id,
        phone: member.phone,
        detail: input.blocked ? "Заблокирован администратором" : "Разблокирован администратором",
      });
      return row;
    }),

  /** Допуск сотрудника, подтвердившего личность в MAX. */
  approve: adminOnly.input(z.object({ id: z.number() })).handler(async ({ input, context }) => {
    const result = await approveStaff(input.id, context.user);
    if (!result.ok) throw new ORPCError("BAD_REQUEST", { message: result.reason });
    await logAudit({
      actor: context.user,
      action: "staff.approved",
      targetType: "staff",
      targetId: input.id,
      detail: result.member.fullName,
      ip: clientIp(context.headers),
    });
    return result.member;
  }),

  /** Отказ в допуске: привязка MAX снимается, карточка возвращается в «не подтверждён». */
  reject: adminOnly.input(z.object({ id: z.number() })).handler(async ({ input, context }) => {
    const result = await rejectStaff(input.id, context.user);
    if (!result.ok) throw new ORPCError("BAD_REQUEST", { message: result.reason });
    await logAudit({
      actor: context.user,
      action: "staff.rejected",
      targetType: "staff",
      targetId: input.id,
      detail: result.member.fullName,
      ip: clientIp(context.headers),
    });
    return result.member;
  }),

  /** Снять блокировку входа после перебора кода. */
  unlockLogin: adminOnly.input(z.object({ id: z.number() })).handler(async ({ input, context }) => {
    await clearLoginFailures(input.id);
    await logAccess({ kind: "login_unlocked", staffId: input.id, detail: `Снял: ${context.user.fullName}` });
    await logAudit({
      actor: context.user,
      action: "staff.login_unlocked",
      targetType: "staff",
      targetId: input.id,
      detail: "Снята блокировка входа после перебора кода",
      ip: clientIp(context.headers),
    });
    return { ok: true };
  }),

  /** Полный сброс привязки MAX — сотрудник проходит регистрацию заново. */
  resetMaxLink: adminOnly
    .input(z.object({ id: z.number() }))
    .handler(async ({ input, context }) => {
    const [row] = await db
      .update(schema.staff)
      .set({
        maxUserId: null,
        maxChatId: null,
        maxUsername: null,
        status: "pending",
        activatedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(schema.staff.id, input.id))
      .returning();
    await revokeSessions(input.id);
    await logAudit({
      actor: context.user,
      action: "staff.reset_max_link",
      targetType: "staff",
      targetId: input.id,
      detail: "Привязка MAX сброшена, сотрудник проходит регистрацию заново",
      ip: clientIp(context.headers),
    });
    return row;
  }),

  /** Журнал событий доступа. */
  accessLog: adminOnly
    .input(z.object({ limit: z.number().min(1).max(200).default(50) }).optional())
    .handler(async ({ input }) => {
      const rows = await db
        .select()
        .from(schema.accessEvents)
        .orderBy(desc(schema.accessEvents.id))
        .limit(input?.limit ?? 50);
      const staffRows = rows.some((r) => r.staffId)
        ? await db
            .select({ id: schema.staff.id, fullName: schema.staff.fullName })
            .from(schema.staff)
            .where(
              inArray(
                schema.staff.id,
                rows.filter((r) => r.staffId).map((r) => r.staffId as number),
              ),
            )
        : [];
      return rows.map((row) => ({
        ...row,
        staffName: staffRows.find((s) => s.id === row.staffId)?.fullName ?? null,
      }));
    }),

  /**
   * Выгрузка персональных данных сотрудника (ст. 14 152-ФЗ).
   * Отдаёт всё, что известно о субъекте: карточка, сессии, коды, приглашения,
   * журнал доступа, история действий, назначенные заявки.
   */
  exportData: adminOnly
    .input(z.object({ id: z.number() }))
    .handler(async ({ input, context }) => {
      const data = await exportStaffData(input.id);
      if (!data) throw new ORPCError("NOT_FOUND", { message: "Сотрудник не найден" });
      await logAudit({
        actor: context.user,
        action: "staff.export",
        targetType: "staff",
        targetId: input.id,
        detail: "Выгрузка персональных данных",
        ip: clientIp(context.headers),
      });
      return data;
    }),

  /**
   * Стирание персональных данных сотрудника (ст. 15 и 17 152-ФЗ).
   * Субъект обезличивается, следы в операционных таблицах вычищаются.
   * Бизнес-рекорды компании (заявки, фотографии документов) сохраняются.
   */
  eraseData: adminOnly
    .input(z.object({ id: z.number(), confirm: z.literal("УДАЛИТЬ") }))
    .handler(async ({ input, context }) => {
      const [member] = await db.select().from(schema.staff).where(eq(schema.staff.id, input.id));
      if (!member) throw new ORPCError("NOT_FOUND", { message: "Сотрудник не найден" });
      if (input.id === context.user.id) {
        throw new ORPCError("BAD_REQUEST", {
          message: "Нельзя стереть собственные данные — попросите другого администратора",
        });
      }
      if (member.role === "admin") {
        const admins = await db
          .select({ id: schema.staff.id })
          .from(schema.staff)
          .where(and(eq(schema.staff.role, "admin"), ne(schema.staff.status, "blocked")));
        if (admins.length <= 1) {
          throw new ORPCError("BAD_REQUEST", {
            message: "Нельзя стереть данные последнего администратора",
          });
        }
      }
      const report = await eraseStaffData(input.id);
      await logAudit({
        actor: context.user,
        action: "staff.erase",
        targetType: "staff",
        targetId: input.id,
        detail:
          `Стерто: сессий ${report.sessions}, кодов ${report.otpCodes}, приглашений ${report.invites}, ` +
          `событий доступа ${report.accessEvents}; обезличено записей истории ${report.historyAnonymized}; ` +
          `отвязано заявок ${report.requestsDetached}, вложений ${report.attachmentsDetached}`,
        ip: clientIp(context.headers),
      });
      return report;
    }),

  /** Журнал административных действий (ст. 19 152-ФЗ, журналирование). */
  auditLog: adminOnly
    .input(
      z.object({
        limit: z.number().min(1).max(200).default(50),
        action: z.string().max(64).optional(),
        actorId: z.number().optional(),
      }).optional(),
    )
    .handler(async ({ input }) => {
      const limit = input?.limit ?? 50;
      const conditions = [];
      if (input?.action) conditions.push(eq(schema.auditLog.action, input.action));
      if (input?.actorId) conditions.push(eq(schema.auditLog.actorId, input.actorId));
      const where = conditions.length ? and(...conditions) : undefined;
      const rows = await db
        .select()
        .from(schema.auditLog)
        .where(where)
        .orderBy(desc(schema.auditLog.id))
        .limit(limit);
      const total = await db.select({ id: schema.auditLog.id }).from(schema.auditLog).where(where);
      return { rows, total: total.length };
    }),

  /** Полный перечень кодов действий — для фильтра в панели. */
  auditActions: adminOnly.handler(async () => {
    const rows = await db
      .selectDistinct({ action: schema.auditLog.action })
      .from(schema.auditLog)
      .orderBy(schema.auditLog.action);
    return rows.map((r) => r.action);
  }),

  ttlPresets: authed.handler(() => INVITE_TTL_PRESETS.map((p) => ({ ...p }))),
};
