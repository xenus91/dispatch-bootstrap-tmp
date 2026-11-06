import { useState } from "react";
import { ScrollText } from "lucide-react";
import { Badge, Card, Empty } from "../components/shell";
import { errorText } from "../lib/api";
import { fmtDateTime } from "../lib/format";
import { useAuditActions, useAuditLog } from "../queries/staff";

/** Человекочитаемые названия действий. */
const ACTION_LABELS: Record<string, string> = {
  "staff.create": "Создание сотрудника",
  "staff.update": "Изменение карточки",
  "staff.blocked": "Блокировка",
  "staff.unblocked": "Разблокировка",
  "staff.approved": "Допуск",
  "staff.rejected": "Отказ в допуске",
  "staff.invite_issued": "Выдано приглашение",
  "staff.invite_revoked": "Приглашение отозвано",
  "staff.reset_max_link": "Сброс привязки MAX",
  "staff.login_unlocked": "Снята блокировка входа",
  "staff.export": "Выгрузка персональных данных",
  "staff.erase": "Удаление персональных данных",
  "settings.update": "Изменение настроек",
  "settings.update_security": "Изменение политики доступа",
  "webhook.subscribe": "Подписка на вебхук",
  "webhook.unsubscribe": "Отписка от вебхука",
  "webhook.rotate_secret": "Ротация секрета вебхука",
};

function tone(action: string): "success" | "info" | "warning" | "danger" | "neutral" {
  if (action.includes("erase") || action.includes("blocked")) return "danger";
  if (action.includes("export") || action.includes("rotate")) return "warning";
  if (action.includes("approve") || action.includes("create")) return "success";
  if (action.includes("update") || action.includes("subscribe")) return "info";
  return "neutral";
}

/**
 * Журнал административных действий.
 *
 * `access_events` показывает входы и отказы; здесь — что именно делали
 * сотрудники с правами администратора: правили карточки, блокировали,
 * меняли настройки, подписывали вебхук, выгружали и стирали персональные
 * данные. Нужен для разбора инцидентов и как подтверждение применения мер
 * защиты (ст. 19 152-ФЗ).
 */
export default function AuditPage() {
  const [filter, setFilter] = useState("");
  const log = useAuditLog(200);
  const actions = useAuditActions();

  const rows = (log.data?.rows ?? []).filter((r) =>
    filter ? r.action.includes(filter) : true,
  );

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-xl font-extrabold tracking-tight">Журнал действий</h1>
          <p className="text-xs text-[var(--muted-foreground)]">
            Кто и что менял в системе. Хранится {log.data?.total ?? 0} записей.
          </p>
        </div>
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="ml-auto max-w-[280px]"
        >
          <option value="">Все действия</option>
          {(actions.data ?? []).map((a) => (
            <option key={a} value={a}>
              {ACTION_LABELS[a] ?? a}
            </option>
          ))}
        </select>
      </div>

      <Card
        title={
          <span className="flex items-center gap-2">
            <ScrollText className="size-4" />
            Административные действия
          </span>
        }
      >
        {!rows.length ? (
          <Empty text="Записей пока нет" />
        ) : (
          <ul className="space-y-2">
            {rows.map((r) => (
              <li
                key={r.id}
                className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-md border border-border px-3 py-2"
              >
                <span className="mono shrink-0 text-xs text-[var(--muted-foreground)]">
                  {fmtDateTime(r.createdAt)}
                </span>
                <Badge tone={tone(r.action)}>{ACTION_LABELS[r.action] ?? r.action}</Badge>
                <span className="text-sm font-semibold">{r.actorName ?? "система"}</span>
                {r.detail && (
                  <span className="min-w-0 flex-1 text-xs text-[var(--muted-foreground)]">
                    {r.detail}
                  </span>
                )}
                {r.ip && (
                  <span className="mono shrink-0 text-[11px] text-[var(--muted-foreground)]">
                    {r.ip}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        {log.isError && (
          <p className="text-xs font-semibold text-[var(--danger)]">{errorText(log.error)}</p>
        )}
      </Card>
    </div>
  );
}
