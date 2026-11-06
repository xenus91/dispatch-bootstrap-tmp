import { useState } from "react";
import { MapPin } from "lucide-react";
import { cn } from "@/lib/utils";
import { SelectField, Sheet, TextAreaField, TextField } from "../../components/form";
import { errorText } from "../../lib/api";
import { useClients } from "../../queries/clients";
import { useArchivePoint, useCreatePoint, usePoints, useRemovePoint, useUpdatePoint } from "../../queries/points";
import {
  POINT_KINDS,
  POINT_KIND_LABELS,
  mapUrl,
  parseCoords,
  pointKindIcon,
  pointKindLabel,
  type PointKind,
} from "../../../api/lib/route-def";
import { DictList, EditFooter, nul } from "./shared";

type Point = NonNullable<ReturnType<typeof usePoints>["data"]>[number];

const fromPoint = (p?: Point | null, kind?: PointKind, clientId?: number | null) => ({
  kind: (p?.kind as PointKind) ?? kind ?? "terminal",
  name: p?.name ?? "",
  address: p?.address ?? "",
  coords: p?.lat != null && p?.lon != null ? `${p.lat}, ${p.lon}` : "",
  contactName: p?.contactName ?? "",
  phone: p?.phone ?? "",
  schedule: p?.schedule ?? "",
  comment: p?.comment ?? "",
  clientId: p?.clientId ? String(p.clientId) : clientId ? String(clientId) : "",
});

/** Окно пункта. В форме заявки открывается с заранее выбранным видом и клиентом. */
export function PointSheet({
  point,
  kind,
  clientId,
  lockKind,
  onClose,
  onSaved,
}: {
  point?: Point | null;
  kind?: PointKind;
  clientId?: number | null;
  lockKind?: boolean;
  onClose: () => void;
  onSaved?: (id: number) => void;
}) {
  const [f, setF] = useState(() => fromPoint(point, kind, clientId));
  const [err, setErr] = useState("");
  const clients = useClients();
  const create = useCreatePoint();
  const update = useUpdatePoint();
  const archive = useArchivePoint();
  const remove = useRemovePoint();
  const set = (k: keyof typeof f) => (v: string) => setF((p) => ({ ...p, [k]: v }));
  const coords = f.coords.trim() ? parseCoords(f.coords) : null;

  const save = async () => {
    setErr("");
    if (!f.name.trim()) return setErr("Укажите название пункта");
    if (f.coords.trim() && !coords) return setErr("Координаты в формате «55.7558, 37.6173»");
    const input = {
      kind: f.kind,
      name: f.name.trim(),
      address: nul(f.address),
      lat: coords?.lat ?? null,
      lon: coords?.lon ?? null,
      contactName: nul(f.contactName),
      phone: nul(f.phone),
      schedule: nul(f.schedule),
      comment: nul(f.comment),
      clientId: f.kind === "warehouse" && f.clientId ? Number(f.clientId) : null,
    };
    try {
      const row = point ? await update.mutateAsync({ ...input, id: point.id }) : await create.mutateAsync(input);
      onSaved?.((row as { id: number }).id);
      onClose();
    } catch (e) {
      setErr(errorText(e));
    }
  };

  return (
    <Sheet
      title={point ? point.name : `Новый пункт${lockKind ? ` · ${pointKindLabel(f.kind)}` : ""}`}
      onClose={onClose}
      footer={
        <EditFooter
          editing={!!point}
          id={point?.id}
          archived={point?.archived}
          canEdit
          saving={create.isPending || update.isPending}
          onSave={save}
          onClose={onClose}
          archive={archive}
          remove={remove}
        />
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {!lockKind && (
          <div className="sm:col-span-2">
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-foreground)]">
              Вид пункта
            </div>
            <div className="grid grid-cols-3 gap-1 rounded-lg border border-border p-1">
              {POINT_KINDS.map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => set("kind")(k)}
                  className={cn(
                    "rounded-md px-2 py-1.5 text-xs font-semibold sm:text-sm",
                    f.kind === k ? "bg-[var(--primary)] text-[var(--primary-foreground)]" : "text-[var(--muted-foreground)]",
                  )}
                >
                  {pointKindIcon(k)} {POINT_KIND_LABELS[k]}
                </button>
              ))}
            </div>
          </div>
        )}
        <TextField
          label="Название"
          required
          value={f.name}
          onChange={set("name")}
          className="sm:col-span-2"
          placeholder={f.kind === "terminal" ? "ПЛП, Ворсино, Селятино…" : f.kind === "warehouse" ? "Склад «Север»" : "Мойка «Чистый контейнер»"}
        />
        {f.kind === "warehouse" && (
          <SelectField
            label="Клиент"
            value={f.clientId}
            onChange={set("clientId")}
            placeholder="— не привязан —"
            options={(clients.data ?? []).map((c) => ({ value: c.id, label: c.name }))}
            className="sm:col-span-2"
            hint="Склад будет предлагаться в заявках этого клиента первым"
          />
        )}
        <TextField label="Адрес" value={f.address} onChange={set("address")} className="sm:col-span-2" />
        <TextField
          label="Координаты"
          value={f.coords}
          onChange={set("coords")}
          mono
          placeholder="55.7558, 37.6173"
          hint={
            coords ? (
              <a href={mapUrl(coords.lat, coords.lon)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[var(--primary)]">
                <MapPin className="size-3" /> Проверить на карте
              </a>
            ) : f.coords.trim() ? (
              <span className="text-[var(--danger)]">Не распознано</span>
            ) : (
              "Водитель получит ссылку на карту"
            )
          }
        />
        <TextField label="Режим работы" value={f.schedule} onChange={set("schedule")} placeholder="Пн–Пт 9:00–18:00" />
        <TextField label="Контактное лицо" value={f.contactName} onChange={set("contactName")} />
        <TextField label="Телефон" value={f.phone} onChange={set("phone")} mono type="tel" />
        <TextAreaField label="Комментарий" value={f.comment} onChange={set("comment")} className="sm:col-span-2" rows={2} />
      </div>
      {err && <div className="mt-3 text-xs text-[var(--danger)]">{err}</div>}
    </Sheet>
  );
}

export default function PointsDict() {
  const q = usePoints({ includeArchived: true });
  const clients = useClients({ includeArchived: true });
  const [kind, setKind] = useState<PointKind | "all">("all");
  const [open, setOpen] = useState<Point | "new" | null>(null);
  const clientName = (id: number | null) => clients.data?.find((c) => c.id === id)?.name;
  const items = q.data?.filter((p) => kind === "all" || p.kind === kind);

  return (
    <>
      <div className="flex flex-wrap gap-1">
        {(["all", ...POINT_KINDS] as const).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setKind(k)}
            className={cn(
              "rounded-full border px-3 py-1 text-xs font-semibold",
              kind === k ? "border-[var(--primary)] text-[var(--primary)]" : "border-border text-[var(--muted-foreground)]",
            )}
          >
            {k === "all" ? "Все" : `${pointKindIcon(k)} ${POINT_KIND_LABELS[k]}`}
            <span className="mono ml-1 opacity-70">{(q.data ?? []).filter((p) => !p.archived && (k === "all" || p.kind === k)).length}</span>
          </button>
        ))}
      </div>
      <DictList
        title="Пункты"
        hint="Терминалы, склады клиентов и места обработки. Из них собирается маршрут заявки."
        items={items}
        loading={q.isLoading}
        canEdit
        onAdd={() => setOpen("new")}
        onOpen={setOpen}
        emptyText="Пунктов пока нет"
        renderRow={(p) => (
          <>
            <span className="mt-0.5 text-base leading-none">{pointKindIcon(p.kind)}</span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold">{p.name}</div>
              <div className="truncate text-xs text-[var(--muted-foreground)]">
                {[pointKindLabel(p.kind), clientName(p.clientId), p.address].filter(Boolean).join(" · ")}
              </div>
            </div>
            {p.lat != null && <MapPin className="mt-0.5 size-3.5 shrink-0 text-[var(--muted-foreground)]" />}
          </>
        )}
      />
      {open && <PointSheet point={open === "new" ? null : open} kind={kind === "all" ? undefined : kind} onClose={() => setOpen(null)} />}
    </>
  );
}
