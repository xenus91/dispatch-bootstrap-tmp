import { ORPCError } from "@orpc/server";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../database";
import * as schema from "../database/schema";
import { dispatcherOnly } from "../lib/auth";

const opt = z.string().max(500).optional().nullable();
const clientInput = z.object({
  name: z.string().trim().min(1, "Укажите название").max(200),
  inn: z.string().trim().max(12).optional().nullable(),
  address: opt,
  contactName: opt,
  phone: opt,
  email: opt,
  comment: z.string().max(2000).optional().nullable(),
});

const clean = (input: z.infer<typeof clientInput>) => ({
  name: input.name.trim(),
  inn: input.inn?.trim() || null,
  address: input.address?.trim() || null,
  contactName: input.contactName?.trim() || null,
  phone: input.phone?.trim() || null,
  email: input.email?.trim() || null,
  comment: input.comment?.trim() || null,
});

async function usage(id: number) {
  const [req, pts] = await Promise.all([
    db.select({ id: schema.requests.id }).from(schema.requests).where(eq(schema.requests.clientId, id)),
    db.select({ id: schema.points.id }).from(schema.points).where(eq(schema.points.clientId, id)),
  ]);
  return { requests: req.length, points: pts.length };
}

/** Клиенты: ведут админ и диспетчер (в том числе прямо из формы заявки). */
export const clients = {
  list: dispatcherOnly
    .input(z.object({ includeArchived: z.boolean().default(false) }).optional())
    .handler(async ({ input }) => {
      const rows = await db.select().from(schema.clients).orderBy(asc(schema.clients.name));
      return input?.includeArchived ? rows : rows.filter((r) => !r.archived);
    }),

  create: dispatcherOnly.input(clientInput).handler(async ({ input }) => {
    const [row] = await db.insert(schema.clients).values(clean(input)).returning();
    return row!;
  }),

  update: dispatcherOnly.input(clientInput.extend({ id: z.number() })).handler(async ({ input }) => {
    const [row] = await db
      .update(schema.clients)
      .set({ ...clean(input), updatedAt: new Date() })
      .where(eq(schema.clients.id, input.id))
      .returning();
    if (!row) throw new ORPCError("NOT_FOUND", { message: "Клиент не найден" });
    return row;
  }),

  archive: dispatcherOnly.input(z.object({ id: z.number(), archived: z.boolean() })).handler(async ({ input }) => {
    const [row] = await db
      .update(schema.clients)
      .set({ archived: input.archived, updatedAt: new Date() })
      .where(eq(schema.clients.id, input.id))
      .returning();
    if (!row) throw new ORPCError("NOT_FOUND", { message: "Клиент не найден" });
    return row;
  }),

  /** Удаление — только если клиент нигде не используется, иначе архив. */
  remove: dispatcherOnly.input(z.object({ id: z.number() })).handler(async ({ input }) => {
    const u = await usage(input.id);
    if (u.requests || u.points) {
      throw new ORPCError("BAD_REQUEST", {
        message: `Клиент используется (заявок: ${u.requests}, пунктов: ${u.points}) — переведите его в архив`,
      });
    }
    await db.delete(schema.clients).where(eq(schema.clients.id, input.id));
    return { ok: true };
  }),
};
