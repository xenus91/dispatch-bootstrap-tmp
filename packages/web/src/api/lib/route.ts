import { asc, eq, inArray } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import {
  currentStopOf,
  DEFAULT_NOTIFY_PREFS,
  type DoneAction,
  EXTRA_ACTION_KEYS,
  type ExtraAction,
  notifyEvents,
  type NotifyEvent,
  type NotifyPrefs,
  type OperationAction,
  type OperationSnapshot,
  parseJson,
  stopDone,
  stopSnapshot,
} from "./route-def";
import { getSetting, setSetting } from "./settings";

export type RequestRow = typeof schema.requests.$inferSelect;
export type StopRow = typeof schema.requestStops.$inferSelect;
export type PointRow = typeof schema.points.$inferSelect;
export type ClientRow = typeof schema.clients.$inferSelect;
export type OperationTypeRow = typeof schema.operationTypes.$inferSelect;

/* ─────────────── операции ─────────────── */

export function normalizeAction(raw: Partial<OperationAction>): OperationAction {
  return {
    key: String(raw.key ?? "").trim(),
    label: String(raw.label ?? "").trim(),
    buttonText: String(raw.buttonText ?? "").trim(),
    photoRequired: !!raw.photoRequired,
    photoHint: String(raw.photoHint ?? "").trim(),
    isArrival: !!raw.isArrival,
    notifyDefault: !!raw.notifyDefault,
  };
}

export const sanitizeExtras = (raw: unknown): ExtraAction[] =>
  Array.isArray(raw) ? EXTRA_ACTION_KEYS.filter((k) => raw.includes(k)) : [];

export function operationView(row: OperationTypeRow) {
  return {
    id: row.id,
    name: row.name,
    pointKinds: parseJson<string[]>(row.pointKindsJson, []),
    actions: parseJson<Partial<OperationAction>[]>(row.actionsJson, []).map(normalizeAction),
    extraActions: sanitizeExtras(parseJson<unknown>(row.extraActionsJson, [])),
    sort: row.sort,
    archived: row.archived,
  };
}
export type OperationView = ReturnType<typeof operationView>;

export function snapshotOf(op: OperationView): OperationSnapshot {
  return { id: op.id, name: op.name, actions: op.actions, extraActions: op.extraActions };
}

export async function listOperations(includeArchived = true): Promise<OperationView[]> {
  const rows = await db.select().from(schema.operationTypes).orderBy(asc(schema.operationTypes.sort), asc(schema.operationTypes.id));
  return rows.map(operationView).filter((o) => includeArchived || !o.archived);
}

/** Каталог событий уведомлений (зависит от справочника операций). */
export async function currentNotifyEvents(): Promise<NotifyEvent[]> {
  return notifyEvents(await listOperations(true));
}

/* ─────────────── контекст заявки для бота и уведомлений ─────────────── */

export interface StopView {
  stop: StopRow;
  point: PointRow | null;
  snapshot: OperationSnapshot;
  done: DoneAction[];
  /** 1-based */
  index: number;
  total: number;
}

export interface RequestContext {
  request: RequestRow;
  client: ClientRow | null;
  containerCode: string | null;
  typeName: string | null;
  stops: StopView[];
  current: StopView | null;
}

export async function getStops(requestId: number): Promise<StopRow[]> {
  return db
    .select()
    .from(schema.requestStops)
    .where(eq(schema.requestStops.requestId, requestId))
    .orderBy(asc(schema.requestStops.seq));
}

export async function loadContext(request: RequestRow): Promise<RequestContext> {
  const stops = await getStops(request.id);
  const pointIds = [...new Set(stops.map((s) => s.pointId))];
  const [pointRows, clientRows, ctRows, rtRows] = await Promise.all([
    pointIds.length ? db.select().from(schema.points).where(inArray(schema.points.id, pointIds)) : [],
    db.select().from(schema.clients).where(eq(schema.clients.id, request.clientId)),
    db.select().from(schema.containerTypes).where(eq(schema.containerTypes.id, request.containerTypeId)),
    db.select().from(schema.requestTypes).where(eq(schema.requestTypes.id, request.requestTypeId)),
  ]);
  const views: StopView[] = stops.map((stop, i) => ({
    stop,
    point: pointRows.find((p) => p.id === stop.pointId) ?? null,
    snapshot: stopSnapshot(stop),
    done: stopDone(stop),
    index: i + 1,
    total: stops.length,
  }));
  const cur = currentStopOf(stops);
  return {
    request,
    client: clientRows[0] ?? null,
    containerCode: ctRows[0]?.code ?? null,
    typeName: rtRows[0]?.name ?? null,
    stops: views,
    current: cur ? (views.find((v) => v.stop.id === cur.id) ?? null) : null,
  };
}

export async function loadContextById(requestId: number): Promise<RequestContext | null> {
  const [row] = await db.select().from(schema.requests).where(eq(schema.requests.id, requestId));
  return row ? loadContext(row) : null;
}

/* ─────────────── персональные настройки уведомлений ─────────────── */

const prefsKey = (staffId: number) => `notify:${staffId}`;

export function normalizePrefs(raw: unknown): NotifyPrefs {
  const obj = (raw ?? {}) as Partial<NotifyPrefs>;
  const events: Record<string, boolean> = {};
  if (obj.events && typeof obj.events === "object") {
    for (const [k, v] of Object.entries(obj.events)) {
      if (typeof v === "boolean" && k.length <= 64) events[k] = v;
    }
  }
  return { muted: !!obj.muted, scope: obj.scope === "mine" ? "mine" : "all", events };
}

export async function getNotifyPrefs(staffId: number): Promise<NotifyPrefs> {
  const raw = await getSetting(prefsKey(staffId));
  if (!raw) return { ...DEFAULT_NOTIFY_PREFS, events: {} };
  try {
    return normalizePrefs(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_NOTIFY_PREFS, events: {} };
  }
}

export async function getNotifyPrefsMap(staffIds: number[]): Promise<Map<number, NotifyPrefs>> {
  const map = new Map<number, NotifyPrefs>();
  if (!staffIds.length) return map;
  const rows = await db.select().from(schema.settings).where(inArray(schema.settings.key, staffIds.map(prefsKey)));
  for (const id of staffIds) {
    const row = rows.find((r) => r.key === prefsKey(id));
    let prefs: NotifyPrefs = { ...DEFAULT_NOTIFY_PREFS, events: {} };
    if (row) {
      try {
        prefs = normalizePrefs(JSON.parse(row.value));
      } catch {
        /* битая запись — значения по умолчанию */
      }
    }
    map.set(id, prefs);
  }
  return map;
}

export async function saveNotifyPrefs(staffId: number, prefs: unknown): Promise<NotifyPrefs> {
  const normalized = normalizePrefs(prefs);
  await setSetting(prefsKey(staffId), JSON.stringify(normalized));
  return normalized;
}

export async function staffExists(staffId: number) {
  const [row] = await db.select({ id: schema.staff.id }).from(schema.staff).where(eq(schema.staff.id, staffId));
  return !!row;
}
