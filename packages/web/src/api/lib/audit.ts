import { db } from "../database";
import * as schema from "../database/schema";
import type { StaffRow } from "./auth";

/**
 * Журнал административных действий.
 *
 * Отличается от `access_events` (журнал входов и отказов): здесь фиксируются
 * действия сотрудников с правами администратора — правка карточек, блокировки,
 * смена настроек, подписка на вебхук, выгрузка и стирание персональных данных.
 *
 * Нужен для разбора инцидентов и как подтверждение применения мер защиты
 * (ст. 19 152-ФЗ, требования к журналированию действий пользователей).
 */

export interface AuditEntry {
  /** Кто совершил действие. null — системное действие. */
  actor?: Pick<StaffRow, "id" | "fullName" | "role"> | null;
  /** Код действия: staff.create, staff.update, staff.erase, settings.update… */
  action: string;
  /** На что подействовали: staff / settings / webhook / request */
  targetType?: string | null;
  /** Идентификатор объекта */
  targetId?: string | number | null;
  /** Что именно изменилось */
  detail?: string | null;
  /** IP-адрес, с которого выполнено действие */
  ip?: string | null;
}

/**
 * Записать действие в журнал.
 *
 * Ошибки журналирования никогда не должны ломать основную операцию: если
 * запись не удалась — пишем в лог и идём дальше. Потеря одной записи в
 * журнале лучше, чем отказ в операции, которую уже совершили.
 */
export async function logAudit(entry: AuditEntry): Promise<void> {
  try {
    await db.insert(schema.auditLog).values({
      actorId: entry.actor?.id ?? null,
      actorName: entry.actor?.fullName ?? null,
      actorRole: entry.actor?.role ?? null,
      action: entry.action,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId != null ? String(entry.targetId) : null,
      detail: entry.detail ?? null,
      ip: entry.ip ?? null,
    });
  } catch (err) {
    console.error(
      "[audit] не удалось записать действие:",
      err instanceof Error ? err.message : err,
      entry.action,
    );
  }
}

/** IP клиента из заголовков запроса (за обратным прокси). */
export function clientIp(headers: Headers): string | null {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || headers.get("x-real-ip") || headers.get("cf-connecting-ip") || null;
}

/** Человекочитаемое описание того, что изменилось в карточке сотрудника. */
export function describeChanges(
  before: Partial<StaffRow>,
  after: Partial<StaffRow>,
): string | null {
  const fields: [keyof StaffRow, string][] = [
    ["fullName", "ФИО"],
    ["phone", "телефон"],
    ["role", "роль"],
    ["vehicle", "госномер"],
    ["note", "примечание"],
    ["accessUntil", "срок доступа"],
    ["status", "статус"],
  ];
  const changed: string[] = [];
  for (const [key, label] of fields) {
    const a = before[key] ?? null;
    const b = after[key] ?? null;
    if (a instanceof Date || b instanceof Date) {
      const av = a instanceof Date ? a.getTime() : null;
      const bv = b instanceof Date ? b.getTime() : null;
      if (av !== bv) changed.push(`${label}: ${fmt(a)} → ${fmt(b)}`);
      continue;
    }
    if (a !== b) changed.push(`${label}: ${String(a ?? "—")} → ${String(b ?? "—")}`);
  }
  return changed.length ? changed.join("; ") : null;
}

function fmt(v: unknown): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (v === null || v === undefined || v === "") return "—";
  return String(v);
}
