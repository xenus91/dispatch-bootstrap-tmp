/**
 * Модель маршрутной заявки — общая для сервера, бота и панели (без импортов БД).
 *
 * Заявка = тип (шаблон маршрута) + клиент + контейнер + маршрут из остановок.
 * Остановка = пункт + операция + плановое время прибытия.
 * Операция = упорядоченный набор действий водителя («Прибыл» → «Получил контейнер»).
 *
 * Общий статус заявки фиксирован: new → assigned → accepted → in_progress → done (+ cancelled).
 */

/* ─────────────── пункты ─────────────── */

export const POINT_KINDS = ["terminal", "warehouse", "processing"] as const;
export type PointKind = (typeof POINT_KINDS)[number];

export const POINT_KIND_LABELS: Record<PointKind, string> = {
  terminal: "Терминал",
  warehouse: "Склад",
  processing: "Место обработки",
};

export const POINT_KIND_ICONS: Record<PointKind, string> = {
  terminal: "🏗",
  warehouse: "🏭",
  processing: "🧰",
};

export const pointKindLabel = (kind: string) => POINT_KIND_LABELS[kind as PointKind] ?? kind;
export const pointKindIcon = (kind: string) => POINT_KIND_ICONS[kind as PointKind] ?? "📍";

/* ─────────────── операции и действия ─────────────── */

/** Дополнительные кнопки водителя на остановке. */
export type ExtraAction = "photo" | "comment" | "geo" | "late" | "failure";

export const EXTRA_ACTIONS: { key: ExtraAction; label: string; hint: string }[] = [
  { key: "photo", label: "📷 Фото", hint: "Доп. фото или скан к остановке" },
  { key: "comment", label: "💬 Комментарий", hint: "Короткий текст диспетчеру" },
  { key: "geo", label: "📍 Геолокация", hint: "Кнопка «Отправить геолокацию»" },
  { key: "late", label: "⏳ Опоздание", hint: "Тревожная кнопка" },
  { key: "failure", label: "🚨 Срыв", hint: "Тревожная кнопка" },
];

export const EXTRA_ACTION_KEYS: ExtraAction[] = EXTRA_ACTIONS.map((a) => a.key);

/** Действие водителя внутри операции. */
export interface OperationAction {
  /** Стабильный ключ (латиница) — по нему настраиваются уведомления. */
  key: string;
  /** Как действие называется в истории и у диспетчера: «Получил контейнер». */
  label: string;
  /** Текст кнопки в боте: «📦 Получил контейнер». */
  buttonText: string;
  /** Действие засчитывается только после фото/скана. */
  photoRequired: boolean;
  /** Что именно сфотографировать. */
  photoHint: string;
  /** Это действие фиксирует фактическое прибытие на пункт. */
  isArrival: boolean;
  /** Уведомлять диспетчеров по умолчанию. */
  notifyDefault: boolean;
}

/** Копия операции, сохранённая в остановке заявки на момент создания. */
export interface OperationSnapshot {
  id: number;
  name: string;
  actions: OperationAction[];
  extraActions: ExtraAction[];
}

/** Отмеченное водителем действие на остановке. */
export interface DoneAction {
  key: string;
  /** ISO-время */
  at: string;
  photos?: number;
  byId?: number;
}

/* ─────────────── статусы ─────────────── */

export const REQUEST_STATUSES = ["new", "assigned", "accepted", "in_progress", "done", "cancelled"] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export const REQUEST_STATUS_LABELS: Record<RequestStatus, string> = {
  new: "Новая",
  assigned: "Назначена",
  accepted: "Принята",
  in_progress: "В рейсе",
  done: "Завершена",
  cancelled: "Отменена",
};

export const CLOSED_STATUSES = ["done", "cancelled"] as const;
export const OPEN_STATUSES = ["new", "assigned", "accepted", "in_progress"] as const;

export const isClosedStatus = (status: string) => (CLOSED_STATUSES as readonly string[]).includes(status);
/** Водитель может отмечать действия маршрута. */
export const isRunning = (status: string) => status === "accepted" || status === "in_progress";

/** Подписи событий истории. */
export const HISTORY_LABELS: Record<string, string> = {
  ...REQUEST_STATUS_LABELS,
  created: "Заявка создана",
  reassigned: "Переназначена",
  updated: "Данные изменены",
  route_changed: "Маршрут изменён",
  action: "Действие водителя",
  comment: "Комментарий",
  attachment: "Фото / файлы",
  geo: "Геолокация",
  reminder: "Напоминание отправлено",
  alert_late: "Возможно опоздание",
  alert_failure: "Срыв заявки",
  alert_stop_late: "Опаздывает на остановку",
  alert_no_contact: "Нет связи с водителем",
};

export const statusLabel = (status: string) =>
  REQUEST_STATUS_LABELS[status as RequestStatus] ?? HISTORY_LABELS[status] ?? status;

export const ALERT_LABELS: Record<string, string> = {
  late: "Возможно опоздание",
  failure: "Срыв заявки",
  stop_late: "Опаздывает на остановку",
  security: "Подозрительная попытка доступа",
  no_contact: "Нет связи с водителем",
};

/* ─────────────── прогресс остановки ─────────────── */

export function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export interface StopProgressInput {
  operationSnapshotJson: string;
  doneActionsJson: string;
  doneAt: Date | string | null;
}

export const stopSnapshot = (stop: Pick<StopProgressInput, "operationSnapshotJson">): OperationSnapshot =>
  parseJson<OperationSnapshot>(stop.operationSnapshotJson, { id: 0, name: "—", actions: [], extraActions: [] });

export const stopDone = (stop: Pick<StopProgressInput, "doneActionsJson">): DoneAction[] =>
  parseJson<DoneAction[]>(stop.doneActionsJson, []);

/** Следующее действие водителя на остановке (null — остановка пройдена). */
export function nextAction(stop: StopProgressInput): OperationAction | null {
  if (stop.doneAt) return null;
  const done = new Set(stopDone(stop).map((d) => d.key));
  return stopSnapshot(stop).actions.find((a) => !done.has(a.key)) ?? null;
}

/** Текущая остановка — первая непройденная по порядку. */
export function currentStopOf<T extends StopProgressInput & { seq: number }>(stops: T[]): T | null {
  return [...stops].sort((a, b) => a.seq - b.seq).find((s) => !s.doneAt) ?? null;
}

/** Действие фиксирует прибытие: явно отмеченное, а если такого нет — первое. */
export function isArrivalAction(snapshot: OperationSnapshot, key: string): boolean {
  const flagged = snapshot.actions.find((a) => a.isArrival);
  return flagged ? flagged.key === key : snapshot.actions[0]?.key === key;
}

/* ─────────────── валидация операции ─────────────── */

const KEY_RE = /^[a-z][a-z0-9_]{1,31}$/;

export function validateActions(actions: OperationAction[]): string | null {
  if (actions.length < 1) return "У операции должно быть хотя бы одно действие";
  if (actions.length > 10) return "Не больше 10 действий в операции";
  const seen = new Set<string>();
  for (const [i, a] of actions.entries()) {
    const n = i + 1;
    if (!KEY_RE.test(a.key)) return `Действие ${n}: некорректный ключ`;
    if (seen.has(a.key)) return `Действие ${n}: ключ «${a.key}» повторяется`;
    seen.add(a.key);
    if (!a.label.trim()) return `Действие ${n}: укажите название`;
    if (!a.buttonText.trim()) return `Действие ${n}: укажите текст кнопки`;
    if (a.buttonText.length > 64) return `Действие ${n}: текст кнопки длиннее 64 символов`;
    if (a.photoRequired && !a.photoHint.trim()) return `Действие ${n}: опишите, что нужно сфотографировать`;
  }
  if (actions.filter((a) => a.isArrival).length > 1) return "Прибытие фиксирует только одно действие";
  return null;
}

/* ─────────────── события уведомлений ─────────────── */

export type NotifyEventGroup = "request" | "route" | "driver" | "alert" | "system";

export interface NotifyEvent {
  key: string;
  label: string;
  group: NotifyEventGroup;
  /** Подгруппа для действий — название операции. */
  subgroup?: string;
  defaultOn: boolean;
  /** Критичное — нельзя выключить. */
  locked?: boolean;
}

export const NOTIFY_GROUP_LABELS: Record<NotifyEventGroup, string> = {
  request: "Заявка целиком",
  route: "Действия на остановках",
  driver: "Фото, комментарии, геолокация",
  alert: "Тревоги",
  system: "Доступ и система",
};

export const opEventKey = (operationTypeId: number, actionKey: string) => `op:${operationTypeId}:${actionKey}`;

/** Каталог событий. Действия — из справочника операций. */
export function notifyEvents(operations: { id: number; name: string; actions: OperationAction[] }[]): NotifyEvent[] {
  return [
    { key: "accepted", label: "Водитель принял заявку", group: "request", defaultOn: true },
    { key: "done", label: "Рейс завершён", group: "request", defaultOn: true },
    ...operations.flatMap((op) =>
      op.actions.map((a) => ({
        key: opEventKey(op.id, a.key),
        label: a.label,
        group: "route" as const,
        subgroup: op.name,
        defaultOn: a.notifyDefault,
      })),
    ),
    { key: "attachment", label: "Водитель прислал фото/файлы", group: "driver", defaultOn: false },
    { key: "comment", label: "Комментарий водителя", group: "driver", defaultOn: true },
    { key: "geo", label: "Геолокация водителя", group: "driver", defaultOn: false },
    { key: "alert_late", label: "Возможно опоздание", group: "alert", defaultOn: true, locked: true },
    { key: "alert_failure", label: "Срыв заявки", group: "alert", defaultOn: true, locked: true },
    { key: "alert_stop_late", label: "Опаздывает на остановку", group: "alert", defaultOn: true },
    { key: "alert_escalation", label: "Тревога не подтверждена вовремя", group: "alert", defaultOn: true },
    { key: "security", label: "Подозрительные попытки доступа", group: "system", defaultOn: true },
    { key: "staff_activated", label: "Сотрудник активирован в боте", group: "system", defaultOn: true },
  ];
}

export interface NotifyPrefs {
  muted: boolean;
  scope: "all" | "mine";
  events: Record<string, boolean>;
}

export const DEFAULT_NOTIFY_PREFS: NotifyPrefs = { muted: false, scope: "all", events: {} };

export function isLockedEvent(events: NotifyEvent[], eventKey: string): boolean {
  return !!events.find((e) => e.key === eventKey)?.locked;
}

export function isEventEnabled(events: NotifyEvent[], prefs: NotifyPrefs, eventKey: string): boolean {
  const ev = events.find((e) => e.key === eventKey);
  if (ev?.locked) return true;
  if (prefs.muted) return false;
  if (eventKey in prefs.events) return !!prefs.events[eventKey];
  return ev?.defaultOn ?? true;
}

/* ─────────────── прочее ─────────────── */

/** «55.75, 37.61» → координаты. */
export function parseCoords(raw: string): { lat: number; lon: number } | null {
  const m = raw.trim().match(/^(-?\d{1,3}(?:[.,]\d+)?)\s*[,;\s]\s*(-?\d{1,3}(?:[.,]\d+)?)$/);
  if (!m) return null;
  const lat = Number(m[1]!.replace(",", "."));
  const lon = Number(m[2]!.replace(",", "."));
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

export const mapUrl = (lat: number | string, lon: number | string) =>
  `https://yandex.ru/maps/?pt=${lon},${lat}&z=16&l=map`;

/** Ключ нового действия — генерируется автоматически, админ его не видит. */
export function newActionKey(existing: string[]): string {
  for (let i = 1; i < 100; i++) {
    const key = `a${i}`;
    if (!existing.includes(key)) return key;
  }
  return `a${Date.now() % 100000}`;
}
