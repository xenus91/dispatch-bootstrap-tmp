import { ORPCError } from "@orpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../database";
import * as schema from "../database/schema";
import { adminOnly, dispatcherOnly } from "../lib/auth";
import { listOperations, normalizeAction, operationView, sanitizeExtras } from "../lib/route";
import { EXTRA_ACTIONS, POINT_KINDS, validateActions } from "../lib/route-def";

const actionSchema = z.object({
  key: z.string().min(1).max(32),
  label: z.string().max(64),
  buttonText: z.string().max(64),
  photoRequired: z.boolean(),
  photoHint: z.string().max(200),
  isArrival: z.boolean(),
  notifyDefault: z.boolean(),
});

const input = z.object({
  name: z.string().trim().min(1, "Укажите название").max(120),
  pointKinds: z.array(z.enum(POINT_KINDS)).min(1, "Укажите, где допустима операция"),
  actions: z.array(actionSchema).min(1).max(10),
  extraActions: z.array(z.enum(["photo", "comment", "geo", "late", "failure"])),
  sort: z.number().int().default(0),
});

function toRow(i: z.infer<typeof input>) {
  const actions = i.actions.map(normalizeAction);
  const error = validateActions(actions);
  if (error) throw new ORPCError("BAD_REQUEST", { message: error });
  return {
    name: i.name.trim(),
    pointKindsJson: JSON.stringify(i.pointKinds),
    actionsJson: JSON.stringify(actions),
    extraActionsJson: JSON.stringify(sanitizeExtras(i.extraActions)),
    sort: i.sort,
  };
}

/** Где используется операция: шаблоны и остановки (всего / открытых заявок). */
async function usageMap() {
  const [tpl, stops] = await Promise.all([
    db.select({ op: schema.requestTypeStops.operationTypeId }).from(schema.requestTypeStops),
    db.select({ op: schema.requestStops.operationTypeId }).from(schema.requestStops),
  ]);
  const map = new Map<number, { templates: number; stops: number }>();
  const bump = (id: number, k: "templates" | "stops") => {
    const u = map.get(id) ?? { templates: 0, stops: 0 };
    u[k] += 1;
    map.set(id, u);
  };
  for (const r of tpl) bump(r.op, "templates");
  for (const r of stops) bump(r.op, "stops");
  return map;
}

/**
 * Типы операций (бывший конструктор процесса): у каждой — свой набор действий водителя.
 * Заявки хранят снимок операции, поэтому правка не ломает рейсы в работе.
 */
export const operationTypes = {
  list: dispatcherOnly
    .input(z.object({ includeArchived: z.boolean().default(true) }).optional())
    .handler(async ({ input: i }) => {
      const [ops, usage] = await Promise.all([listOperations(i?.includeArchived ?? true), usageMap()]);
      return {
        items: ops.map((o) => ({ ...o, usage: usage.get(o.id) ?? { templates: 0, stops: 0 } })),
        extraActions: EXTRA_ACTIONS,
      };
    }),

  create: adminOnly.input(input).handler(async ({ input: i }) => {
    const [row] = await db.insert(schema.operationTypes).values(toRow(i)).returning();
    return operationView(row!);
  }),

  update: adminOnly.input(input.extend({ id: z.number() })).handler(async ({ input: i }) => {
    const [row] = await db
      .update(schema.operationTypes)
      .set({ ...toRow(i), updatedAt: new Date() })
      .where(eq(schema.operationTypes.id, i.id))
      .returning();
    if (!row) throw new ORPCError("NOT_FOUND", { message: "Операция не найдена" });
    return operationView(row);
  }),

  archive: adminOnly.input(z.object({ id: z.number(), archived: z.boolean() })).handler(async ({ input: i }) => {
    const [row] = await db
      .update(schema.operationTypes)
      .set({ archived: i.archived, updatedAt: new Date() })
      .where(eq(schema.operationTypes.id, i.id))
      .returning();
    if (!row) throw new ORPCError("NOT_FOUND", { message: "Операция не найдена" });
    return operationView(row);
  }),

  remove: adminOnly.input(z.object({ id: z.number() })).handler(async ({ input: i }) => {
    const u = (await usageMap()).get(i.id);
    if (u && (u.templates || u.stops)) {
      throw new ORPCError("BAD_REQUEST", {
        message: `Операция используется (шаблонов: ${u.templates}, остановок: ${u.stops}) — переведите в архив`,
      });
    }
    await db.delete(schema.operationTypes).where(eq(schema.operationTypes.id, i.id));
    return { ok: true };
  }),
};
