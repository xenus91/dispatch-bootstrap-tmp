import { useState } from "react";
import {
  Eraser,
  FileDown,
  Check,
  Copy,
  KeyRound,
  Link2Off,
  Lock,
  MonitorSmartphone,
  Pencil,
  RotateCcw,
  ShieldOff,
  Unlock,
  UserPlus,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Badge, Card, Empty, Field } from "../components/shell";
import { errorText } from "../lib/api";
import { fmtDateTime, fmtRelative } from "../lib/format";
import {
  ACCESS_EVENT_LABELS,
  BLOCK_REASON_LABELS,
  formatPhone,
  ROLE_LABELS,
  STAFF_STATUS_LABELS,
} from "../../api/lib/domain";
import {
  useAccessLog,
  useEraseStaffData,
  useExportStaffData,
  useApproveStaff,
  useCreateStaff,
  useIssueInvite,
  useRejectStaff,
  useResetMaxLink,
  useRevokeInvite,
  useSetBlocked,
  useStaff,
  useTtlPresets,
  useUnlockLogin,
  useUpdateStaff,
} from "../queries/staff";
import { useMe } from "../queries/auth";
import { useRevokeAllForStaff, useRevokeSession, useStaffSessions } from "../queries/sessions";
import { SessionList } from "../components/session-list";

type Ttl = 1 | 24 | 72 | 168;
type Role = "admin" | "dispatcher" | "driver";

const labelCls =
  "mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-foreground)]";

type StaffRow = {
  id: number;
  role: string;
  fullName: string;
  phone: string;
  vehicle: string | null;
  note: string | null;
  maxUserId: string | null;
  accessUntil: Date | string | null;
  /** Согласие на обработку персональных данных (ст. 9 152-ФЗ) */
  consentAt: Date | string | null;
  consentVersion: string | null;
  /** Когда персональные данные были стёрты (ст. 15 152-ФЗ) */
  erasedAt: Date | string | null;
};

/** Date → значение для <input type="date"> (локальная дата). */
function toDateInput(value: Date | string | null | undefined): string {
  if (!value) return "";
  const d = new Date(value);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** «Доступ до 31.12» включает весь день — храним конец дня по местному времени. */
function fromDateInput(value: string): Date | null {
  return value ? new Date(`${value}T23:59:59`) : null;
}

function fmtDate(value: Date | string | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });
}

const accessUntilHint =
  "Дата окончания договора. После неё доступ приостановится автоматически. Пусто — бессрочно.";

/** Сеансы сотрудника: устройства, с которых он вошёл в панель или Mini App. */
function StaffSessions({ staffId }: { staffId: number }) {
  const sessions = useStaffSessions(staffId, true);
  const revoke = useRevokeSession();
  const revokeAll = useRevokeAllForStaff();
  return (
    <div className="mt-4 space-y-2 border-t border-border pt-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn(labelCls, "mb-0")}>Активные сеансы</span>
        {!!sessions.data?.length && (
          <Button
            size="sm"
            variant="outline"
            className="ml-auto"
            disabled={revokeAll.isPending}
            onClick={() => revokeAll.mutate({ staffId })}
          >
            <ShieldOff className="size-4" />
            Завершить все
          </Button>
        )}
      </div>
      <SessionList
        items={sessions.data}
        pending={revoke.isPending}
        onRevoke={(id) => revoke.mutate({ id })}
      />
      {(revoke.isError || revokeAll.isError) && (
        <p className="text-sm font-semibold text-[var(--danger)]">{errorText(revoke.error ?? revokeAll.error)}</p>
      )}
    </div>
  );
}

/**
 * Персональные данные сотрудника (ст. 14–17 152-ФЗ).
 *
 * Две операции, которые субъект вправе потребовать:
 *   - выгрузка (ст. 14) — все известные данные в JSON;
 *   - удаление (ст. 15, 17) — обезличивание и вычистка следов.
 *
 * Бизнес-рекорды компании (заявки, фотографии документов) при удалении
 * сохраняются: обезличивается сам сотрудник, снимаются ссылки на него.
 */
function StaffPersonalData({ member }: { member: StaffRow }) {
  const [open, setOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const exportData = useExportStaffData();
  const erase = useEraseStaffData();

  function download() {
    exportData.mutate(member.id, {
      onSuccess: (data) => {
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `personal-data-${member.id}-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
      },
    });
  }

  if (!open) {
    return (
      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
        <span className={cn(labelCls, "mb-0")}>Персональные данные</span>
        {member.consentAt ? (
          <span className="text-xs text-[var(--muted-foreground)]">
            согласие {fmtDate(member.consentAt)}
            {member.consentVersion ? ` · версия ${member.consentVersion}` : ""}
          </span>
        ) : (
          <span className="text-xs text-[var(--warning)]">согласие не зафиксировано</span>
        )}
        <Button
          size="sm"
          variant="outline"
          className="ml-auto"
          onClick={() => setOpen(true)}
        >
          <FileDown className="size-4" />
          Открыть
        </Button>
      </div>
    );
  }

  return (
    <div className="mt-3 space-y-3 border-t border-border pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn(labelCls, "mb-0")}>Персональные данные</span>
        <Button size="sm" variant="outline" className="ml-auto" onClick={() => setOpen(false)}>
          Скрыть
        </Button>
      </div>

      <p className="text-xs leading-relaxed text-[var(--muted-foreground)]">
        Выгрузка отдаёт все известные данные о сотруднике: карточку, сеансы, коды,
        приглашения, журнал доступа, историю действий и назначенные заявки.
        Удаление обезличивает сотрудника и вычищает следы, но сохраняет бизнес-рекорды
        компании — заявки и фотографии товарно-транспортных документов.
      </p>

      {member.erasedAt && (
        <p className="rounded-md border border-[color-mix(in_srgb,var(--warning)_35%,transparent)] bg-[color-mix(in_srgb,var(--warning)_12%,transparent)] p-3 text-xs">
          Персональные данные сотрудника стёрты {fmtDate(member.erasedAt)}. Карточка сохранена
          без персональных данных — для целостности истории заявок.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={exportData.isPending}
          onClick={download}
        >
          <FileDown className="size-4" />
          {exportData.isPending ? "Готовим…" : "Выгрузить (ст. 14)"}
        </Button>
        {!member.erasedAt && (
          <Button
            size="sm"
            variant="destructive"
            disabled={erase.isPending || confirmText !== "УДАЛИТЬ"}
            onClick={() => erase.mutate(member.id)}
          >
            <Eraser className="size-4" />
            {erase.isPending ? "Удаляем…" : "Удалить (ст. 15)"}
          </Button>
        )}
      </div>

      {!member.erasedAt && (
        <label className="block text-xs text-[var(--muted-foreground)]" htmlFor="erase-confirm">
          Для удаления введите <span className="mono font-bold text-foreground">УДАЛИТЬ</span>
          <input
            id="erase-confirm"
            aria-label="Подтверждение удаления данных"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder="УДАЛИТЬ"
            className="mono mt-1 w-full max-w-[220px]"
          />
        </label>
      )}

      {(exportData.isError || erase.isError) && (
        <p className="text-xs font-semibold text-[var(--danger)]">
          {errorText(exportData.error ?? erase.error)}
        </p>
      )}
      {erase.isSuccess && (
        <p className="text-xs text-[var(--success)]">
          Данные стёрты. Сессий: {erase.data.sessions}, событий доступа:{" "}
          {erase.data.accessEvents}, обезличено записей истории: {erase.data.historyAnonymized}.
        </p>
      )}
    </div>
  );
}

/** Редактирование карточки сотрудника: ФИО, телефон, роль, автомобиль, примечание. */
function StaffEditor({ member, isSelf, onClose }: { member: StaffRow; isSelf: boolean; onClose: () => void }) {
  const update = useUpdateStaff();
  const [f, setF] = useState({
    fullName: member.fullName,
    phone: formatPhone(member.phone),
    role: member.role as Role,
    vehicle: member.vehicle ?? "",
    note: member.note ?? "",
    accessUntil: toDateInput(member.accessUntil),
  });
  const phoneDigits = f.phone.replace(/\D/g, "");
  const phoneChanged = phoneDigits !== member.phone && phoneDigits.replace(/^8/, "7") !== member.phone;

  return (
    <form
      className="mt-4 space-y-4 border-t border-border pt-4"
      onSubmit={async (e) => {
        e.preventDefault();
        await update.mutateAsync({
          id: member.id,
          fullName: f.fullName,
          phone: phoneChanged ? f.phone : undefined,
          role: f.role !== member.role ? f.role : undefined,
          vehicle: f.vehicle,
          note: f.note,
          accessUntil: f.accessUntil !== toDateInput(member.accessUntil) ? fromDateInput(f.accessUntil) : undefined,
        });
        onClose();
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <label className="block">
          <span className={labelCls}>Роль</span>
          <select
            value={f.role}
            disabled={isSelf}
            onChange={(e) => setF((v) => ({ ...v, role: e.target.value as Role }))}
            className="w-full"
          >
            <option value="driver">Водитель</option>
            <option value="dispatcher">Диспетчер</option>
            <option value="admin">Администратор</option>
          </select>
          {isSelf && (
            <span className="mt-1 block text-[11px] text-[var(--muted-foreground)]">
              Свою роль изменить нельзя
            </span>
          )}
        </label>
        <label className="block" htmlFor="edit-fullname">
          <span className={labelCls}>ФИО</span>
          <input
            id="edit-fullname"
            aria-label="ФИО"
            value={f.fullName}
            onChange={(e) => setF((v) => ({ ...v, fullName: e.target.value }))}
            className="w-full"
          />
        </label>
        <label className="block" htmlFor="edit-phone">
          <span className={labelCls}>Телефон MAX</span>
          <input
            id="edit-phone"
            aria-label="Телефон MAX"
            value={f.phone}
            inputMode="tel"
            onChange={(e) => setF((v) => ({ ...v, phone: e.target.value }))}
            className="mono w-full"
          />
          {phoneChanged && member.maxUserId && (
            <span className="mt-1 block text-[11px] text-[var(--warning)]">
              Привязка MAX будет сброшена — потребуется новый инвайт
            </span>
          )}
        </label>
        <label className="block" htmlFor="edit-vehicle">
          <span className={labelCls}>Автомобиль</span>
          <input
            id="edit-vehicle"
            aria-label="Автомобиль"
            value={f.vehicle}
            onChange={(e) => setF((v) => ({ ...v, vehicle: e.target.value }))}
            placeholder="Volvo FH, А123ВС777"
            className="mono w-full"
          />
        </label>
        {f.role !== "admin" && (
          <label className="block" htmlFor="edit-access-until">
            <span className={labelCls}>Доступ до</span>
            <input
              id="edit-access-until"
              aria-label="Доступ до"
              type="date"
              value={f.accessUntil}
              onChange={(e) => setF((v) => ({ ...v, accessUntil: e.target.value }))}
              className="mono w-full"
            />
            <span className="mt-1 block text-[11px] text-[var(--muted-foreground)]">{accessUntilHint}</span>
          </label>
        )}
        <label className={cn("block", f.role === "admin" ? "sm:col-span-2" : "")} htmlFor="edit-note">
          <span className={labelCls}>Примечание</span>
          <input
            id="edit-note"
            aria-label="Примечание"
            value={f.note}
            onChange={(e) => setF((v) => ({ ...v, note: e.target.value }))}
            className="w-full"
          />
        </label>
      </div>
      {update.isError && (
        <p className="text-sm font-semibold text-[var(--danger)]">{errorText(update.error)}</p>
      )}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={update.isPending || f.fullName.trim().length < 3 || phoneDigits.length < 10}>
          {update.isPending ? "Сохраняем…" : "Сохранить"}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onClose}>
          Отмена
        </Button>
      </div>
    </form>
  );
}

type Tab = "all" | "awaiting" | "driver" | "dispatcher" | "admin";

const ROLE_TABS: { key: Tab; label: string }[] = [
  { key: "all", label: "Все" },
  { key: "awaiting", label: "Ждут допуска" },
  { key: "driver", label: "Водители" },
  { key: "dispatcher", label: "Диспетчеры" },
  { key: "admin", label: "Администраторы" },
];

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      size="sm"
      variant="outline"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          /* буфер недоступен — ссылка всё равно видна */
        }
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
    >
      <Copy className="size-4" />
      {done ? "Скопировано" : "Копировать"}
    </Button>
  );
}

const SUCCESS_EVENTS = new Set(["login_ok", "activated", "invite_ok", "approved", "login_unlocked"]);
const INFO_EVENTS = new Set(["otp_sent", "new_device", "sessions_revoked"]);
const WARNING_EVENTS = new Set(["approval_requested", "otp_throttled", "suspended", "rejected", "name_rejected"]);

function eventTone(kind: string): "success" | "info" | "warning" | "danger" {
  if (SUCCESS_EVENTS.has(kind)) return "success";
  if (INFO_EVENTS.has(kind)) return "info";
  if (WARNING_EVENTS.has(kind)) return "warning";
  return "danger";
}

export default function Staff() {
  const [tab, setTab] = useState<Tab>("all");
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState({
    role: "driver" as "admin" | "dispatcher" | "driver",
    fullName: "",
    phone: "",
    vehicle: "",
    note: "",
    accessUntil: "",
    inviteTtlHours: "24",
  });
  const [ttlByStaff, setTtlByStaff] = useState<Record<number, string>>({});
  const [editingId, setEditingId] = useState<number | null>(null);
  const [sessionsId, setSessionsId] = useState<number | null>(null);
  const me = useMe();

  // Сотрудников немного — грузим всех и фильтруем на клиенте, чтобы счётчик «Ждут допуска» был виден всегда.
  const all = useStaff();
  const awaitingCount = all.data?.filter((m) => m.status === "awaiting_approval").length ?? 0;
  const rows = all.data?.filter((m) =>
    tab === "all" ? true : tab === "awaiting" ? m.status === "awaiting_approval" : m.role === tab,
  );
  const presets = useTtlPresets();
  const log = useAccessLog(50);
  const create = useCreateStaff();
  const issue = useIssueInvite();
  const revoke = useRevokeInvite();
  const block = useSetBlocked();
  const reset = useResetMaxLink();
  const approve = useApproveStaff();
  const reject = useRejectStaff();
  const unlock = useUnlockLogin();

  const error =
    create.error ?? issue.error ?? revoke.error ?? block.error ?? reset.error ?? approve.error ?? reject.error ?? unlock.error;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-xl font-extrabold tracking-tight">Сотрудники и доступы</h1>
          <p className="text-xs text-[var(--muted-foreground)]">
            Учётные записи создаёт только администратор. Водитель попадает в бота по инвайт-ссылке и
            подтверждает номер телефона MAX.
          </p>
        </div>
        <Button size="sm" className="ml-auto" onClick={() => setFormOpen((v) => !v)}>
          <UserPlus className="size-4" />
          Добавить сотрудника
        </Button>
      </div>

      {!!error && (
        <div className="rounded-md border border-[color-mix(in_srgb,var(--danger)_35%,transparent)] bg-[color-mix(in_srgb,var(--danger)_10%,transparent)] px-4 py-3 text-sm font-semibold text-[var(--danger)]">
          {errorText(error)}
        </div>
      )}

      {formOpen && (
        <Card title="Новый сотрудник">
          <form
            className="space-y-4"
            onSubmit={async (e) => {
              e.preventDefault();
              await create.mutateAsync({
                role: form.role,
                fullName: form.fullName,
                phone: form.phone,
                vehicle: form.vehicle || undefined,
                note: form.note || undefined,
                accessUntil: form.role === "admin" ? undefined : fromDateInput(form.accessUntil),
                inviteTtlHours: form.inviteTtlHours ? (Number(form.inviteTtlHours) as Ttl) : undefined,
              });
              setForm({ role: "driver", fullName: "", phone: "", vehicle: "", note: "", accessUntil: "", inviteTtlHours: "24" });
              setFormOpen(false);
            }}
          >
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <label className="block">
                <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-foreground)]">
                  Роль
                </span>
                <select
                  value={form.role}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, role: e.target.value as "admin" | "dispatcher" | "driver" }))
                  }
                  className="w-full"
                >
                  <option value="driver">Водитель</option>
                  <option value="dispatcher">Диспетчер</option>
                  <option value="admin">Администратор</option>
                </select>
              </label>
              <label className="block" htmlFor="new-fullname">
                <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-foreground)]">
                  ФИО <span className="text-[var(--danger)]">*</span>
                </span>
                <input
                  id="new-fullname"
                  aria-label="ФИО"
                  value={form.fullName}
                  onChange={(e) => setForm((f) => ({ ...f, fullName: e.target.value }))}
                  placeholder="Иванов Иван Иванович"
                  className="w-full"
                />
              </label>
              <label className="block" htmlFor="new-phone">
                <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-foreground)]">
                  Телефон MAX <span className="text-[var(--danger)]">*</span>
                </span>
                <input
                  id="new-phone"
                  aria-label="Телефон MAX"
                  value={form.phone}
                  onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
                  placeholder="+7 900 000-00-00"
                  className="mono w-full"
                />
              </label>
              <label className="block" htmlFor="new-vehicle">
                <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-foreground)]">
                  Автомобиль
                </span>
                <input
                  id="new-vehicle"
                  aria-label="Автомобиль"
                  value={form.vehicle}
                  onChange={(e) => setForm((f) => ({ ...f, vehicle: e.target.value }))}
                  placeholder="Volvo FH, А123ВС777"
                  className="mono w-full"
                />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-foreground)]">
                  Срок инвайт-ссылки
                </span>
                <select
                  value={form.inviteTtlHours}
                  onChange={(e) => setForm((f) => ({ ...f, inviteTtlHours: e.target.value }))}
                  className="w-full"
                >
                  <option value="">Не выпускать сейчас</option>
                  {(presets.data ?? []).map((p) => (
                    <option key={p.hours} value={p.hours}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>
              {form.role !== "admin" && (
                <label className="block" htmlFor="new-access-until">
                  <span className={labelCls}>Доступ до</span>
                  <input
                    id="new-access-until"
                    aria-label="Доступ до"
                    type="date"
                    value={form.accessUntil}
                    onChange={(e) => setForm((f) => ({ ...f, accessUntil: e.target.value }))}
                    className="mono w-full"
                  />
                  <span className="mt-1 block text-[11px] text-[var(--muted-foreground)]">{accessUntilHint}</span>
                </label>
              )}
              <label className="block" htmlFor="new-note">
                <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-foreground)]">
                  Примечание
                </span>
                <input
                  id="new-note"
                  aria-label="Примечание"
                  value={form.note}
                  onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
                  className="w-full"
                />
              </label>
            </div>
            <div className="flex gap-2">
              <Button type="submit" disabled={create.isPending || form.fullName.length < 3 || form.phone.length < 6}>
                {create.isPending ? "Создаём…" : "Создать и выпустить инвайт"}
              </Button>
              <Button type="button" variant="outline" onClick={() => setFormOpen(false)}>
                Отмена
              </Button>
            </div>
          </form>
        </Card>
      )}

      {!!create.data?.invite && (
        <Card title="Инвайт-ссылка выпущена">
          <div className="flex flex-wrap items-center gap-3">
            <span className="mono min-w-0 flex-1 truncate rounded-md border border-border bg-[var(--surface-2)] px-3 py-2 text-sm">
              {create.data.invite.link}
            </span>
            <CopyButton text={create.data.invite.link} />
          </div>
          <p className="mt-2 text-xs text-[var(--muted-foreground)]">
            Действует до {fmtDateTime(create.data.invite.expiresAt)}. Отправьте сотруднику лично — по
            ссылке он попадёт в бота, подтвердит номер и получит доступ.
          </p>
        </Card>
      )}

      <div className="flex gap-1 rounded-md border border-border bg-[var(--surface)] p-1">
        {ROLE_TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={cn(
              "rounded px-3 py-1.5 text-xs font-bold transition-colors",
              tab === t.key
                ? "bg-[var(--primary)] text-[var(--primary-foreground)]"
                : "text-[var(--muted-foreground)] hover:text-foreground",
            )}
          >
            {t.label}
            {t.key === "awaiting" && awaitingCount > 0 && (
              <span className="ml-1.5 rounded-full bg-[var(--warning)] px-1.5 py-px text-[10px] text-black">
                {awaitingCount}
              </span>
            )}
          </button>
        ))}
      </div>

      {all.isLoading ? (
        <Empty text="Загружаем…" />
      ) : !rows?.length ? (
        <Empty text={tab === "awaiting" ? "Никто не ждёт допуска" : "Сотрудников нет"} />
      ) : (
        <div className="space-y-3">
          {rows.map((m) => {
            const ttl = ttlByStaff[m.id] ?? "24";
            const awaiting = m.status === "awaiting_approval";
            const loginLocked = !!m.loginLockedUntil && new Date(m.loginLockedUntil).getTime() > Date.now();
            const accessExpired = !!m.accessUntil && new Date(m.accessUntil).getTime() <= Date.now();
            return (
              <div key={m.id} className="rounded-lg border border-border bg-[var(--surface)] p-4">
                <div className="flex flex-wrap items-center gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-extrabold">{m.fullName}</div>
                    <div className="mono text-xs text-[var(--muted-foreground)]">
                      {formatPhone(m.phone)}
                      {m.vehicle ? ` · ${m.vehicle}` : ""}
                    </div>
                  </div>
                  <Badge tone="neutral">{ROLE_LABELS[m.role] ?? m.role}</Badge>
                  <Badge
                    tone={m.status === "active" ? "success" : m.status === "blocked" ? "danger" : "warning"}
                  >
                    {STAFF_STATUS_LABELS[m.status] ?? m.status}
                    {m.status === "blocked" && m.blockReason && BLOCK_REASON_LABELS[m.blockReason]
                      ? ` · ${BLOCK_REASON_LABELS[m.blockReason]}`
                      : ""}
                  </Badge>
                  {loginLocked && (
                    <Badge tone="danger">Вход закрыт до {fmtDateTime(m.loginLockedUntil)}</Badge>
                  )}
                  {m.accessUntil && (
                    <Badge tone={accessExpired ? "danger" : "neutral"}>
                      {accessExpired ? "Срок доступа истёк" : `Доступ до ${fmtDate(m.accessUntil)}`}
                    </Badge>
                  )}
                  {m.maxUserId ? (
                    <Badge tone="info">MAX привязан</Badge>
                  ) : (
                    <Badge tone="warning">MAX не привязан</Badge>
                  )}

                  <div className="ml-auto flex flex-wrap gap-2">
                    {awaiting && (
                      <>
                        <Button size="sm" disabled={approve.isPending} onClick={() => approve.mutate({ id: m.id })}>
                          <Check className="size-4" />
                          Допустить
                        </Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          disabled={reject.isPending}
                          onClick={() => reject.mutate({ id: m.id })}
                          title="Привязка MAX снимется, для повторной попытки понадобится новый инвайт"
                        >
                          <X className="size-4" />
                          Отклонить
                        </Button>
                      </>
                    )}
                    {loginLocked && (
                      <Button size="sm" variant="outline" disabled={unlock.isPending} onClick={() => unlock.mutate({ id: m.id })}>
                        <Unlock className="size-4" />
                        Снять блокировку входа
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant={sessionsId === m.id ? "default" : "outline"}
                      onClick={() => setSessionsId((v) => (v === m.id ? null : m.id))}
                    >
                      <MonitorSmartphone className="size-4" />
                      Сеансы
                    </Button>
                    <Button
                      size="sm"
                      variant={editingId === m.id ? "default" : "outline"}
                      onClick={() => setEditingId((v) => (v === m.id ? null : m.id))}
                    >
                      <Pencil className="size-4" />
                      Изменить
                    </Button>
                    <select
                      value={ttl}
                      onChange={(e) => setTtlByStaff((s) => ({ ...s, [m.id]: e.target.value }))}
                      className="text-xs"
                    >
                      {(presets.data ?? []).map((p) => (
                        <option key={p.hours} value={p.hours}>
                          {p.label}
                        </option>
                      ))}
                    </select>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={issue.isPending || m.status === "blocked"}
                      onClick={() => issue.mutate({ staffId: m.id, ttlHours: Number(ttl) as Ttl })}
                    >
                      <KeyRound className="size-4" />
                      Инвайт
                    </Button>
                    {m.maxUserId && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={reset.isPending}
                        onClick={() => reset.mutate({ id: m.id })}
                        title="Сбросить привязку MAX — сотрудник пройдёт регистрацию заново"
                      >
                        <RotateCcw className="size-4" />
                        Сброс MAX
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant={m.status === "blocked" ? "outline" : "destructive"}
                      disabled={block.isPending || (m.status === "blocked" && accessExpired)}
                      title={
                        m.status === "blocked" && accessExpired
                          ? "Срок доступа истёк — сначала продлите «Доступ до» в карточке"
                          : undefined
                      }
                      onClick={() => block.mutate({ id: m.id, blocked: m.status !== "blocked" })}
                    >
                      {m.status === "blocked" ? <Unlock className="size-4" /> : <Lock className="size-4" />}
                      {m.status === "blocked" ? "Разблокировать" : "Заблокировать"}
                    </Button>
                  </div>
                </div>

                {editingId === m.id && (
                  <StaffEditor member={m} isSelf={me.data?.id === m.id} onClose={() => setEditingId(null)} />
                )}

                {sessionsId === m.id && <StaffSessions staffId={m.id} />}

                <StaffPersonalData member={m} />

                {m.invite && (
                  <div className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-border bg-[var(--surface-2)] px-3 py-2">
                    <span className="mono min-w-0 flex-1 truncate text-xs">{m.invite.link}</span>
                    <span
                      className={cn(
                        "mono text-xs",
                        m.invite.expired ? "text-[var(--danger)]" : "text-[var(--muted-foreground)]",
                      )}
                    >
                      {m.invite.expired ? "истёк" : fmtRelative(m.invite.expiresAt)}
                    </span>
                    <CopyButton text={m.invite.link} />
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={revoke.isPending}
                      onClick={() => revoke.mutate({ inviteId: m.invite!.id })}
                    >
                      <Link2Off className="size-4" />
                      Отозвать
                    </Button>
                  </div>
                )}

                {awaiting && (
                  <p className="mt-3 rounded-md border border-[color-mix(in_srgb,var(--warning)_35%,transparent)] bg-[color-mix(in_srgb,var(--warning)_10%,transparent)] px-3 py-2 text-xs">
                    Сотрудник прошёл по инвайту и подтвердил номер MAX
                    {m.maxUsername ? ` (@${m.maxUsername})` : ""}. Проверьте, что это он, и допустите — до этого
                    бот и панель ему недоступны. Те же кнопки пришли администраторам в MAX.
                  </p>
                )}

                <div className="mt-3 grid gap-3 sm:grid-cols-4">
                  <Field label="Активирован" value={fmtDateTime(m.activatedAt)} mono />
                  <Field label="Последняя активность" value={fmtDateTime(m.lastActivityAt)} mono />
                  <Field label="MAX username" value={m.maxUsername ? `@${m.maxUsername}` : "—"} mono />
                  <Field label="Примечание" value={m.note} />
                </div>
              </div>
            );
          })}
        </div>
      )}

      <Card title="Журнал доступа">
        {!log.data?.length ? (
          <Empty text="События появятся после первых обращений к боту" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-[var(--muted-foreground)]">
                  <th className="px-2 py-2 font-semibold">Время</th>
                  <th className="px-2 py-2 font-semibold">Событие</th>
                  <th className="px-2 py-2 font-semibold">Сотрудник</th>
                  <th className="px-2 py-2 font-semibold">Телефон</th>
                  <th className="px-2 py-2 font-semibold">Детали</th>
                </tr>
              </thead>
              <tbody>
                {log.data.map((row) => (
                  <tr key={row.id} className="border-b border-border/60 last:border-0">
                    <td className="mono whitespace-nowrap px-2 py-2 text-xs text-[var(--muted-foreground)]">
                      {fmtDateTime(row.createdAt)}
                    </td>
                    <td className="px-2 py-2">
                      <Badge tone={eventTone(row.kind)}>
                        {ACCESS_EVENT_LABELS[row.kind] ?? row.kind}
                      </Badge>
                    </td>
                    <td className="px-2 py-2 text-xs">{row.staffName ?? "—"}</td>
                    <td className="mono px-2 py-2 text-xs">{formatPhone(row.phone)}</td>
                    <td className="px-2 py-2 text-xs text-[var(--muted-foreground)]">{row.detail ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
