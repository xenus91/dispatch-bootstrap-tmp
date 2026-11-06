import { ORPCError } from "@orpc/server";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../database";
import * as schema from "../database/schema";
import { adminOnly, dispatcherOnly } from "../lib/auth";
import { POINT_KINDS } from "../lib/route-def";

const stopSchema = z.object({
  label: z.string().trim().min(1, "Укажите название остановки").max(120),
  pointKind: z.enum(POINT_KINDS),
  operationTypeId: z.number(),
  optional: z.boolean().default(false),
});

const input = z.object({
  name: z.string().trim().min(1, "Укажите название").max(200),
  description: z.string().max(1000).optional().nullable(),
  sort: z.number().int().default(0),
  stops: z.array(stopSchema).min(1, "Добавьте хотя бы одну остановку").max(20),
});

async function withStops<T extends { id: number }>(rows: T[]) {
  const stops = await db.select().from(schema.requestTypeStops).orderBy(asc(schema.requestTypeStops.seq));
  return rows.map((r) => ({ ...r, stops: stops.filter((s) => s.requestTypeId === r.id) }));
}

async function writeStops(requestTypeId: number, stops: z.infer<typeof stopSchema>[]) {
  const ops = await db.select({ id: schema.operationTypes.id }).from(schema.operationTypes);
  for (const s of stops) {
    if (!ops.some((o) => o.id === s.operationTypeId)) throw new ORPCError("BAD_REQUEST", { message: "Операция не найдена" });
  }
  await db.delete(schema.requestTypeStops).where(eq(schema.requestTypeStops.requestTypeId, requestTypeId));
  if (stops.length) {
    await db.insert(schema.requestTypeStops).values(
      stops.map((s, i) => ({
        requestTypeId,
        seq: i + 1,
        label: s.label.trim(),
        pointKind: s.pointKind,
        operationTypeId: s.operationTypeId,
        optional: s.optional,
      })),
    );
  }
}

/** Типы заявок — шаблоны маршрута. Читают диспетчеры, ведёт админ. */
export const requestTypes = {
  list: dispatcherOnly
    .input(z.object({ includeArchived: z.boolean().default(false) }).optional())
    .handler(async ({ input: i }) => {
      const rows = await db.select().from(schema.requestTypes).orderBy(asc(schema.requestTypes.sort), asc(schema.requestTypes.id));
      return withStops(i?.includeArchived ? rows : rows.filter((r) => !r.archived));
    }),

  create: adminOnly.input(input).handler(async ({ input: i }) => {
    const [row] = await db
      .insert(schema.requestTypes)
      .values({ name: i.name.trim(), description: i.description?.trim() || null, sort: i.sort })
      .returning();
    await writeStops(row!.id, i.stops);
    return (await withStops([row!]))[0]!;
  }),

  update: adminOnly.input(input.extend({ id: z.number() })).handler(async ({ input: i }) => {
    const [row] = await db
      .update(schema.requestTypes)
      .set({ name: i.name.trim(), description: i.description?.trim() || null, sort: i.sort, updatedAt: new Date() })
      .where(eq(schema.requestTypes.id, i.id))
      .returning();
    if (!row) throw new ORPCError("NOT_FOUND", { message: "Тип заявки не найден" });
    // Шаблон влияет только на новые заявки: маршрут копируется в заявку при создании.
    await writeStops(row.id, i.stops);
    return (await withStops([row]))[0]!;
  }),

  archive: adminOnly.input(z.object({ id: z.number(), archived: z.boolean() })).handler(async ({ input: i }) => {
    const [row] = await db
      .update(schema.requestTypes)
      .set({ archived: i.archived, updatedAt: new Date() })
      .where(eq(schema.requestTypes.id, i.id))
      .returning();
    if (!row) throw new ORPCError("NOT_FOUND", { message: "Тип заявки не найден" });
    return row;
  }),

  remove: adminOnly.input(z.object({ id: z.number() })).handler(async ({ input: i }) => {
    const used = await db.select({ id: schema.requests.id }).from(schema.requests).where(eq(schema.requests.requestTypeId, i.id));
    if (used.length) throw new ORPCError("BAD_REQUEST", { message: `Тип используется в заявках (${used.length}) — переведите в архив` });
    await db.delete(schema.requestTypeStops).where(eq(schema.requestTypeStops.requestTypeId, i.id));
    await db.delete(schema.requestTypes).where(eq(schema.requestTypes.id, i.id));
    return { ok: true };
  }),
};
