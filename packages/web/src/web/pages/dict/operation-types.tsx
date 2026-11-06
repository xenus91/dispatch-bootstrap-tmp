import { useState } from "react";
import { ArrowDown, ArrowUp, Camera, Flag, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Badge } from "../../components/shell";
import { Sheet, TextField } from "../../components/form";
import { Toggle } from "../../components/ui/toggle";
import { errorText } from "../../lib/api";
import {
  useArchiveOperationType,
  useCreateOperationType,
  useOperationTypes,
  useRemoveOperationType,
  useUpdateOperationType,
} from "../../queries/operation-types";
import {
  POINT_KINDS,
  POINT_KIND_LABELS,
  newActionKey,
  pointKindIcon,
  validateActions,
  type ExtraAction,
  type OperationAction,
  type PointKind,
} from "../../../api/lib/route-def";
import { DictList, EditFooter, useIsAdmin } from "./shared";

type Data = NonNullable<ReturnType<typeof useOperationTypes>["data"]>;
type Row = Data["items"][number];

const blankAction = (keys: string[]): OperationAction => ({
  key: newActionKey(keys),
  label: "",
  buttonText: "",
  photoRequired: false,
  photoHint: "",
  isArrival: false,
  notifyDefault: true,
});

function ActionEditor({
  action,
  index,
  total,
  readOnly,
  onChange,
  onMove,
  onRemove,
}: {
  action: OperationAction;
  index: number;
  total: number;
  readOnly: boolean;
  onChange: (a: OperationAction) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
}) {
  const set = <K extends keyof OperationAction>(k: K, v: OperationAction[K]) => onChange({ ...action, [k]: v });
  return (
    <div className="rounded-lg border border-border p-3">
      <div className="mb-3 flex items-center gap-2">
        <span className="mono grid size-6 place-items-center rounded-full bg-[var(--muted)] text-xs font-bold">{index + 1}</span>
        <span className="text-xs text-[var(--muted-foreground)]">
          {index === total - 1 ? "Последнее — закрывает остановку" : "Шаг"}
        </span>
        {!readOnly && (
          <div className="ml-auto flex gap-0.5">
            <Button variant="ghost" size="icon-sm" disabled={index === 0} onClick={() => onMove(-1)} aria-label="Выше">
              <ArrowUp />
            </Button>
            <Button variant="ghost" size="icon-sm" disabled={index === total - 1} onClick={() => onMove(1)} aria-label="Ниже">
              <ArrowDown />
            </Button>
            <Button variant="ghost" size="icon-sm" disabled={total <= 1} onClick={onRemove} aria-label="Удалить" className="text-[var(--danger)]">
              <Trash2 />
            </Button>
          </div>
        )}
      </div>
      <fieldset disabled={readOnly} className="grid gap-3 sm:grid-cols-2">
        <TextField
          label="Кнопка в боте"
          required
          value={action.buttonText}
          onChange={(v) => onChange({ ...action, buttonText: v, label: action.label || "" })}
          placeholder="📦 Получил контейнер"
        />
        <TextField label="Как называется в истории" value={action.label} onChange={(v) => set("label", v)} placeholder="Получил контейнер" />
        <div className="flex flex-wrap gap-x-5 gap-y-2 sm:col-span-2">
          <div className="flex items-center gap-2 text-sm">
            <Toggle label="Фото обязательно" checked={action.photoRequired} disabled={readOnly} onChange={(v) => set("photoRequired", v)} />
            <Camera className="size-3.5 text-[var(--muted-foreground)]" /> Фото обязательно
          </div>
          <div className="flex items-center gap-2 text-sm">
            <Toggle label="Фиксирует прибытие" checked={action.isArrival} disabled={readOnly} onChange={(v) => set("isArrival", v)} />
            <Flag className="size-3.5 text-[var(--muted-foreground)]" /> Фиксирует прибытие
          </div>
          <div className="flex items-center gap-2 text-sm">
            <Toggle label="Уведомлять" checked={action.notifyDefault} disabled={readOnly} onChange={(v) => set("notifyDefault", v)} />
            Уведомлять диспетчеров
          </div>
        </div>
        {action.photoRequired && (
          <TextField
            label="Что сфотографировать"
            value={action.photoHint}
            onChange={(v) => set("photoHint", v)}
            placeholder="Контейнер, пломба, EIR"
            className="sm:col-span-2"
          />
        )}
      </fieldset>
    </div>
  );
}

function OperationSheet({
  row,
  extras,
  canEdit,
  onClose,
}: {
  row: Row | null;
  extras: Data["extraActions"];
  canEdit: boolean;
  onClose: () => void;
}) {
  const [name, setName] = useState(row?.name ?? "");
  const [kinds, setKinds] = useState<PointKind[]>((row?.pointKinds as PointKind[]) ?? ["terminal"]);
  const [actions, setActions] = useState<OperationAction[]>(
    row?.actions ?? [
      { ...blankAction([]), buttonText: "🏁 Прибыл", label: "Прибыл", isArrival: true },
      { ...blankAction(["a1"]), buttonText: "✅ Готово", label: "Выполнено" },
    ],
  );
  const [extra, setExtra] = useState<ExtraAction[]>(row?.extraActions ?? ["photo", "comment", "geo", "late", "failure"]);
  const [err, setErr] = useState("");
  const create = useCreateOperationType();
  const update = useUpdateOperationType();
  const archive = useArchiveOperationType();
  const remove = useRemoveOperationType();

  const patch = (i: number, a: OperationAction) => setActions((p) => p.map((x, j) => (j === i ? a : x)));
  const move = (i: number, d: -1 | 1) =>
    setActions((p) => {
      const n = [...p];
      [n[i], n[i + d]] = [n[i + d]!, n[i]!];
      return n;
    });

  const save = async () => {
    setErr("");
    const prepared = actions.map((a) => ({
      ...a,
      buttonText: a.buttonText.trim(),
      label: a.label.trim() || a.buttonText.replace(/^[^\p{L}\p{N}]+/u, "").trim(),
      photoHint: a.photoHint.trim(),
    }));
    const problem = validateActions(prepared);
    if (!name.trim()) return setErr("Укажите название операции");
    if (!kinds.length) return setErr("Укажите, на каких пунктах допустима операция");
    if (problem) return setErr(problem);
    const input = { name: name.trim(), pointKinds: kinds, actions: prepared, extraActions: extra, sort: row?.sort ?? 0 };
    try {
      if (row) await update.mutateAsync({ ...input, id: row.id });
      else await create.mutateAsync(input);
      onClose();
    } catch (e) {
      setErr(errorText(e));
    }
  };

  const used = row ? row.usage.templates + row.usage.stops : 0;

  return (
    <Sheet
      wide
      title={row ? row.name : "Новая операция"}
      onClose={onClose}
      footer={
        <EditFooter
          editing={!!row}
          id={row?.id}
          archived={row?.archived}
          canEdit={canEdit}
          saving={create.isPending || update.isPending}
          onSave={save}
          onClose={onClose}
          archive={archive}
          remove={remove}
        />
      }
    >
      <div className="space-y-5">
        {row && used > 0 && (
          <div className="rounded-md bg-[var(--muted)] px-3 py-2 text-xs text-[var(--muted-foreground)]">
            Используется: типов заявок — {row.usage.templates}, остановок в заявках — {row.usage.stops}. Изменения применятся к новым
            заявкам; в уже созданных остаётся прежний набор кнопок.
          </div>
        )}
        <fieldset disabled={!canEdit} className="space-y-4">
          <TextField label="Название" required value={name} onChange={setName} placeholder="Получение гружёного контейнера" />
          <div>
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-foreground)]">
              Где допустима <span className="text-[var(--danger)]">*</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {POINT_KINDS.map((k) => {
                const on = kinds.includes(k);
                return (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setKinds((p) => (on ? p.filter((x) => x !== k) : [...p, k]))}
                    className={cn(
                      "rounded-full border px-3 py-1 text-xs font-semibold",
                      on ? "border-[var(--primary)] bg-[var(--primary)]/10 text-[var(--primary)]" : "border-border text-[var(--muted-foreground)]",
                    )}
                  >
                    {pointKindIcon(k)} {POINT_KIND_LABELS[k]}
                  </button>
                );
              })}
            </div>
          </div>
        </fieldset>

        <div>
          <div className="mb-2 flex items-center gap-2">
            <h3 className="text-sm font-extrabold">Кнопки водителя по порядку</h3>
            {canEdit && actions.length < 10 && (
              <Button variant="outline" size="sm" className="ml-auto" onClick={() => setActions((p) => [...p, blankAction(p.map((a) => a.key))])}>
                <Plus /> Шаг
              </Button>
            )}
          </div>
          <div className="space-y-2">
            {actions.map((a, i) => (
              <ActionEditor
                key={a.key}
                action={a}
                index={i}
                total={actions.length}
                readOnly={!canEdit}
                onChange={(x) => patch(i, x)}
                onMove={(d) => move(i, d)}
                onRemove={() => setActions((p) => p.filter((_, j) => j !== i))}
              />
            ))}
          </div>
        </div>

        <div>
          <h3 className="mb-2 text-sm font-extrabold">Дополнительные кнопки на остановке</h3>
          <div className="grid gap-2 sm:grid-cols-2">
            {extras.map((x) => (
              <div key={x.key} className="flex items-start gap-2 rounded-md border border-border px-3 py-2 text-sm">
                <Toggle
                  label={x.label}
                  checked={extra.includes(x.key)}
                  disabled={!canEdit}
                  onChange={(v) => setExtra((p) => (v ? [...p, x.key] : p.filter((k) => k !== x.key)))}
                />
                <span>
                  <span className="block font-semibold">{x.label}</span>
                  <span className="block text-[11px] text-[var(--muted-foreground)]">{x.hint}</span>
                </span>
              </div>
            ))}
          </div>
        </div>
        {err && <div className="text-xs text-[var(--danger)]">{err}</div>}
      </div>
    </Sheet>
  );
}

export default function OperationTypesDict() {
  const isAdmin = useIsAdmin();
  const q = useOperationTypes({ includeArchived: true });
  const [open, setOpen] = useState<Row | "new" | null>(null);

  return (
    <>
      <DictList
        title="Операции"
        hint={
          isAdmin
            ? "Операция — что водитель делает на пункте и какие кнопки видит в боте. Нажмите, чтобы настроить шаги и фото."
            : "Изменять операции может только администратор."
        }
        items={q.data?.items}
        loading={q.isLoading}
        canEdit={isAdmin}
        onAdd={() => setOpen("new")}
        onOpen={setOpen}
        emptyText="Операций пока нет"
        renderRow={(o) => (
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-sm font-semibold">{o.name}</span>
              {o.pointKinds.map((k) => (
                <span key={k} className="text-xs" title={POINT_KIND_LABELS[k as PointKind]}>
                  {pointKindIcon(k)}
                </span>
              ))}
              {o.archived && <Badge tone="neutral">архив</Badge>}
            </div>
            <div className="mt-1 flex flex-wrap gap-1">
              {o.actions.map((a) => (
                <span key={a.key} className="rounded border border-border px-1.5 py-0.5 text-[11px]">
                  {a.buttonText}
                  {a.photoRequired && " 📷"}
                </span>
              ))}
            </div>
          </div>
        )}
      />
      {open && q.data && (
        <OperationSheet row={open === "new" ? null : open} extras={q.data.extraActions} canEdit={isAdmin} onClose={() => setOpen(null)} />
      )}
    </>
  );
}
