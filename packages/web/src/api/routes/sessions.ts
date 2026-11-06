import { ORPCError } from "@orpc/server";
import { and, desc, eq, gt, ne } from "drizzle-orm";
import { z } from "zod";
import { db } from "../database";
import * as schema from "../database/schema";
import { deviceLabel, signOutEverywhere } from "../lib/access";
import { adminOnly, authed, logAccess } from "../lib/auth";

async function activeSessions(staffId: number, currentId?: number) {
  const rows = await db
    .select()
    .from(schema.sessions)
    .where(and(eq(schema.sessions.staffId, staffId), gt(schema.sessions.expiresAt, new Date())))
    .orderBy(desc(schema.sessions.lastSeenAt));
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind as "web" | "miniapp",
    device: deviceLabel(r.userAgent),
    ip: r.ip,
    createdAt: r.createdAt,
    lastSeenAt: r.lastSeenAt,
    expiresAt: r.expiresAt,
    current: r.id === currentId,
  }));
}

/** Сеансы панели: свои — каждому сотруднику, чужие — только администратору. */
export const sessions = {
  mine: authed.handler(({ context }) => activeSessions(context.user.id, context.sessionId)),

  /** Завершить один сеанс: свой — любой сотрудник, чужой — администратор. */
  revoke: authed.input(z.object({ id: z.number() })).handler(async ({ input, context }) => {
    const [row] = await db.select().from(schema.sessions).where(eq(schema.sessions.id, input.id));
    if (!row) return { ok: true };
    if (row.staffId !== context.user.id && context.user.role !== "admin") {
      throw new ORPCError("FORBIDDEN", { message: "Чужой сеанс может завершить только администратор" });
    }
    await db.delete(schema.sessions).where(eq(schema.sessions.id, input.id));
    await logAccess({
      kind: "sessions_revoked",
      staffId: row.staffId,
      detail: `Завершён сеанс «${deviceLabel(row.userAgent)}»${row.staffId !== context.user.id ? ` — ${context.user.fullName}` : ""}`,
    });
    return { ok: true };
  }),

  /** Выйти на всех устройствах, кроме текущего. */
  revokeOthers: authed.handler(async ({ context }) => {
    const removed = await db
      .delete(schema.sessions)
      .where(and(eq(schema.sessions.staffId, context.user.id), ne(schema.sessions.id, context.sessionId)))
      .returning({ id: schema.sessions.id });
    await logAccess({ kind: "sessions_revoked", staffId: context.user.id, detail: `Выход на других устройствах (${removed.length})` });
    return { removed: removed.length };
  }),

  forStaff: adminOnly
    .input(z.object({ staffId: z.number() }))
    .handler(({ input, context }) => activeSessions(input.staffId, context.sessionId)),

  /** Администратор: завершить все сеансы сотрудника. */
  revokeAllForStaff: adminOnly.input(z.object({ staffId: z.number() })).handler(async ({ input, context }) => {
    const [member] = await db.select().from(schema.staff).where(eq(schema.staff.id, input.staffId));
    if (!member) throw new ORPCError("NOT_FOUND", { message: "Сотрудник не найден" });
    await signOutEverywhere(member, `Все сеансы завершил ${context.user.fullName}`);
    return { ok: true, self: member.id === context.user.id };
  }),
};
