import { useState } from "react";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "../../components/shell";
import { SelectField, Sheet, TextAreaField, TextField } from "../../components/form";
import { Toggle } from "../../components/ui/toggle";
import { errorText } from "../../lib/api";
import { useOperationTypes } from "../../queries/operation-types";
import {
  useArchiveRequestType,
  useCreateRequestType,
  useRemoveRequestType,
  useRequestTypes,
  useUpdateRequestType,
} from "../../queries/request-types";
import { POINT_KINDS, POINT_KIND_LABELS, pointKindIcon, type PointKind } from "../../../api/lib/route-def";
import { DictList, EditFooter, nul, useIsAdmin } from "./shared";

type Row = NonNullable<ReturnType<typeof useRequestTypes>["data"]>[number];
type Ops = NonNullable<ReturnType<typeof useOperationTypes>["data"]>["items"];
type StopDraft = { uid: number; label: string; pointKind: PointKind; operationTypeId: string; optional: boolean };

let uidSeq = 1;

function TypeSheet({ row, ops, canEdit, onClose }: { row: Row | null; ops: Ops; canEdit: boolean; onClose: () => void }) {
  const [name, setName] = useState(row?.name ?? "");
  const [description, setDescription] = useState(row?.description ?? "");
  const [stops, setStops] = useState<StopDraft[]>(
    row?.stops.map((s) => ({
      uid: uidSeq++,
      label: s.label,
      pointKind: s.pointKind as PointKind,
      operationTypeId: String(s.operationTypeId),
      optional: s.optional,
    })) ?? [{ uid: uidSeq++, label: "Контейнерный терминал", pointKind: "terminal", operationTypeId: "", optional: false }],
  );
  const [err, setErr] = useState("");
  const create = useCreateRequestType();
  const update = useUpdateRequestType();
  const archive = useArchiveRequestType();
  const remove = useRemoveRequestType();

  const patch = (i: number, p: Partial<StopDraft>) => setStops((s) => s.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const move = (i: number, d: -1 | 1) =>
    setStops((p) => {
      const n = [...p];
      [n[i], n[i + d]] = [n[i + d]!, n[i]!];
      return n;
    });

  const save = async () => {
    setErr("");
    if (!name.trim()) return setErr("Укажите название типа");
    if (stops.some((s) => !s.label.trim() || !s.operationTypeId)) return setErr("У каждой остановки должны быть название и операция");
    const input = {
      name: name.trim(),
      description: nul(description),
      sort: row?.sort ?? 0,
      stops: stops.map((s) => ({ label: s.label.trim(), pointKind: s.pointKind, operationTypeId: Number(s.operationTypeId), optional: s.optional })),
    };
    try {
      if (row) await update.mutateAsync({ ...input, id: row.id });
      else await create.mutateAsync(input);
      onClose();
    } catch (e) {
      setErr(errorText(e));
    }
  };

  return (
    <Sheet
      wide
      title={row ? row.name : "Новый тип заявки"}
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
      <fieldset disabled={!canEdit} className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField label="Название" required value={name} onChange={setName} placeholder="Гружёный → разгрузка → порожний" />
          <TextAreaField label="Описание" value={description} onChange={setDescription} rows={1} />
        </div>
        <div>
          <div className="mb-2 flex items-center gap-2">
            <h3 className="text-sm font-extrabold">Маршрут по умолчанию</h3>
            {canEdit && (
              <Button
                variant="outline"
                size="sm"
                className="ml-auto"
                onClick={() => setStops((p) => [...p, { uid: uidSeq++, label: "", pointKind: "warehouse", operationTypeId: "", optional: false }])}
              >
                <Plus /> Остановка
              </Button>
            )}
          </div>
          <ol className="space-y-2">
            {stops.map((s, i) => {
              const allowed = ops.filter((o) => !o.archived && o.pointKinds.includes(s.pointKind));
              return (
                <li key={s.uid} className="rounded-lg border border-border p-3">
                  <div className="mb-2 flex items-center gap-2">
                    <span className="mono grid size-6 place-items-center rounded-full bg-[var(--muted)] text-xs font-bold">{i + 1}</span>
                    <div className="flex items-center gap-2 text-xs">
                      <Toggle label="Необязательная" checked={s.optional} disabled={!canEdit} onChange={(v) => patch(i, { optional: v })} />
                      Необязательная
                    </div>
                    {canEdit && (
                      <div className="ml-auto flex gap-0.5">
                        <Button variant="ghost" size="icon-sm" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Выше">
                          <ArrowUp />
                        </Button>
                        <Button variant="ghost" size="icon-sm" disabled={i === stops.length - 1} onClick={() => move(i, 1)} aria-label="Ниже">
                          <ArrowDown />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          disabled={stops.length <= 1}
                          className="text-[var(--danger)]"
                          onClick={() => setStops((p) => p.filter((_, j) => j !== i))}
                          aria-label="Удалить"
                        >
                          <Trash2 />
                        </Button>
                      </div>
                    )}
                  </div>
                  <div className="grid gap-3 sm:grid-cols-3">
                    <TextField label="Название остановки" value={s.label} onChange={(v) => patch(i, { label: v })} placeholder="Склад клиента №1" />
                    <SelectField
                      label="Вид пункта"
                      value={s.pointKind}
                      onChange={(v) => {
                        const kind = v as PointKind;
                        const keep = ops.find((o) => String(o.id) === s.operationTypeId)?.pointKinds.includes(kind);
                        patch(i, { pointKind: kind, operationTypeId: keep ? s.operationTypeId : "" });
                      }}
                      options={POINT_KINDS.map((k) => ({ value: k, label: `${pointKindIcon(k)} ${POINT_KIND_LABELS[k]}` }))}
                    />
                    <SelectField
                      label="Операция"
                      value={s.operationTypeId}
                      onChange={(v) => patch(i, { operationTypeId: v })}
                      placeholder="— выберите —"
                      options={allowed.map((o) => ({ value: o.id, label: o.name }))}
                    />
                  </div>
                </li>
              );
            })}
          </ol>
          <p className="mt-2 text-[11px] text-[var(--muted-foreground)]">
            Диспетчер выбирает конкретные пункты при создании заявки и может добавить или убрать остановки. Необязательные остановки
            по умолчанию не включаются в маршрут.
          </p>
        </div>
        {err && <div className="text-xs text-[var(--danger)]">{err}</div>}
      </fieldset>
    </Sheet>
  );
}

export default function RequestTypesDict() {
  const isAdmin = useIsAdmin();
  const q = useRequestTypes({ includeArchived: true });
  const ops = useOperationTypes({ includeArchived: true });
  const [open, setOpen] = useState<Row | "new" | null>(null);
  const opName = (id: number) => ops.data?.items.find((o) => o.id === id)?.name ?? "—";

  return (
    <>
      <DictList
        title="Типы заявок"
        hint={isAdmin ? "Шаблоны маршрутов: из них диспетчер начинает заявку." : "Изменять типы заявок может только администратор."}
        items={q.data}
        loading={q.isLoading}
        canEdit={isAdmin}
        onAdd={() => setOpen("new")}
        onOpen={setOpen}
        emptyText="Типов заявок пока нет"
        renderRow={(t) => (
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold">{t.name}</span>
              {t.archived && <Badge tone="neutral">архив</Badge>}
            </div>
            {t.description && <div className="text-xs text-[var(--muted-foreground)]">{t.description}</div>}
            <ol className="mt-1.5 space-y-0.5">
              {t.stops.map((s, i) => (
                <li key={s.id} className="flex gap-2 text-xs">
                  <span className="mono w-4 shrink-0 text-[var(--muted-foreground)]">{i + 1}.</span>
                  <span className="min-w-0">
                    {pointKindIcon(s.pointKind)} <b className="font-semibold">{s.label}</b>
                    <span className="text-[var(--muted-foreground)]"> — {opName(s.operationTypeId)}</span>
                    {s.optional && <span className="text-[var(--muted-foreground)]"> · необязательная</span>}
                  </span>
                </li>
              ))}
            </ol>
          </div>
        )}
      />
      {open && ops.data && (
        <TypeSheet row={open === "new" ? null : open} ops={ops.data.items} canEdit={isAdmin} onClose={() => setOpen(null)} />
      )}
    </>
  );
}
