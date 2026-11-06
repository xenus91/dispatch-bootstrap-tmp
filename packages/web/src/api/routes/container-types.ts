import { ORPCError } from "@orpc/server";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../database";
import * as schema from "../database/schema";
import { adminOnly, dispatcherOnly } from "../lib/auth";

const input = z.object({
  code: z.string().trim().min(2, "Укажите код").max(16),
  name: z.string().max(200).optional().nullable(),
  sort: z.number().int().default(0),
});

const clean = (i: z.infer<typeof input>) => ({ code: i.code.trim().toUpperCase(), name: i.name?.trim() || null, sort: i.sort });

async function assertUnique(code: string, exceptId?: number) {
  const [dup] = await db.select().from(schema.containerTypes).where(eq(schema.containerTypes.code, code));
  if (dup && dup.id !== exceptId) throw new ORPCError("BAD_REQUEST", { message: `Тип «${code}» уже есть` });
}

/** Типы контейнеров: читают диспетчеры (форма заявки), ведёт админ. */
export const containerTypes = {
  list: dispatcherOnly
    .input(z.object({ includeArchived: z.boolean().default(false) }).optional())
    .handler(async ({ input: i }) => {
      const rows = await db
        .select()
        .from(schema.containerTypes)
        .orderBy(asc(schema.containerTypes.sort), asc(schema.containerTypes.code));
      return i?.includeArchived ? rows : rows.filter((r) => !r.archived);
    }),

  create: adminOnly.input(input).handler(async ({ input: i }) => {
    const values = clean(i);
    await assertUnique(values.code);
    const [row] = await db.insert(schema.containerTypes).values(values).returning();
    return row!;
  }),

  update: adminOnly.input(input.extend({ id: z.number() })).handler(async ({ input: i }) => {
    const values = clean(i);
    await assertUnique(values.code, i.id);
    const [row] = await db.update(schema.containerTypes).set(values).where(eq(schema.containerTypes.id, i.id)).returning();
    if (!row) throw new ORPCError("NOT_FOUND", { message: "Тип не найден" });
    return row;
  }),

  archive: adminOnly.input(z.object({ id: z.number(), archived: z.boolean() })).handler(async ({ input: i }) => {
    const [row] = await db
      .update(schema.containerTypes)
      .set({ archived: i.archived })
      .where(eq(schema.containerTypes.id, i.id))
      .returning();
    if (!row) throw new ORPCError("NOT_FOUND", { message: "Тип не найден" });
    return row;
  }),

  remove: adminOnly.input(z.object({ id: z.number() })).handler(async ({ input: i }) => {
    const used = await db
      .select({ id: schema.requests.id })
      .from(schema.requests)
      .where(eq(schema.requests.containerTypeId, i.id));
    if (used.length) throw new ORPCError("BAD_REQUEST", { message: `Тип используется в заявках (${used.length}) — переведите в архив` });
    await db.delete(schema.containerTypes).where(eq(schema.containerTypes.id, i.id));
    return { ok: true };
  }),
};
