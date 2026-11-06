import { ORPCError } from "@orpc/server";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../database";
import * as schema from "../database/schema";
import { dispatcherOnly } from "../lib/auth";
import { POINT_KINDS } from "../lib/route-def";

const opt = z.string().max(500).optional().nullable();
const pointInput = z.object({
  kind: z.enum(POINT_KINDS),
  name: z.string().trim().min(1, "Укажите название").max(200),
  address: opt,
  lat: z.number().min(-90).max(90).optional().nullable(),
  lon: z.number().min(-180).max(180).optional().nullable(),
  contactName: opt,
  phone: opt,
  schedule: opt,
  comment: z.string().max(2000).optional().nullable(),
  clientId: z.number().optional().nullable(),
});

function clean(input: z.infer<typeof pointInput>) {
  const hasCoords = input.lat != null && input.lon != null;
  return {
    kind: input.kind,
    name: input.name.trim(),
    address: input.address?.trim() || null,
    lat: hasCoords ? input.lat! : null,
    lon: hasCoords ? input.lon! : null,
    contactName: input.contactName?.trim() || null,
    phone: input.phone?.trim() || null,
    schedule: input.schedule?.trim() || null,
    comment: input.comment?.trim() || null,
    // Привязка к клиенту — только у складов.
    clientId: input.kind === "warehouse" ? (input.clientId ?? null) : null,
  };
}

async function assertClient(clientId: number | null) {
  if (!clientId) return;
  const [c] = await db.select().from(schema.clients).where(eq(schema.clients.id, clientId));
  if (!c) throw new ORPCError("BAD_REQUEST", { message: "Клиент не найден" });
}

/** Пункты маршрута (терминалы, склады, места обработки): ведут админ и диспетчер. */
export const points = {
  list: dispatcherOnly
    .input(
      z
        .object({
          includeArchived: z.boolean().default(false),
          kind: z.enum(POINT_KINDS).optional(),
          clientId: z.number().optional(),
        })
        .optional(),
    )
    .handler(async ({ input }) => {
      const rows = await db.select().from(schema.points).orderBy(asc(schema.points.name));
      return rows.filter(
        (r) =>
          (input?.includeArchived || !r.archived) &&
          (!input?.kind || r.kind === input.kind) &&
          (!input?.clientId || r.clientId === input.clientId),
      );
    }),

  create: dispatcherOnly.input(pointInput).handler(async ({ input }) => {
    const values = clean(input);
    await assertClient(values.clientId);
    const [row] = await db.insert(schema.points).values(values).returning();
    return row!;
  }),

  update: dispatcherOnly.input(pointInput.extend({ id: z.number() })).handler(async ({ input }) => {
    const values = clean(input);
    await assertClient(values.clientId);
    const [row] = await db
      .update(schema.points)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(schema.points.id, input.id))
      .returning();
    if (!row) throw new ORPCError("NOT_FOUND", { message: "Пункт не найден" });
    return row;
  }),

  archive: dispatcherOnly.input(z.object({ id: z.number(), archived: z.boolean() })).handler(async ({ input }) => {
    const [row] = await db
      .update(schema.points)
      .set({ archived: input.archived, updatedAt: new Date() })
      .where(eq(schema.points.id, input.id))
      .returning();
    if (!row) throw new ORPCError("NOT_FOUND", { message: "Пункт не найден" });
    return row;
  }),

  remove: dispatcherOnly.input(z.object({ id: z.number() })).handler(async ({ input }) => {
    const used = await db
      .select({ id: schema.requestStops.id })
      .from(schema.requestStops)
      .where(eq(schema.requestStops.pointId, input.id));
    if (used.length) {
      throw new ORPCError("BAD_REQUEST", { message: `Пункт есть в маршрутах (${used.length}) — переведите его в архив` });
    }
    await db.delete(schema.points).where(eq(schema.points.id, input.id));
    return { ok: true };
  }),
};
