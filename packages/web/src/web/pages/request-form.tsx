import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { AlertTriangle, ArrowDown, ArrowLeft, ArrowUp, Lock, Plus, Save, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Card } from "../components/shell";
import { Labeled, SelectField, TextAreaField, TextField } from "../components/form";
import { errorText } from "../lib/api";
import { minutesLabel, toLocalInput } from "../lib/format";
import { closingConfirmation } from "../lib/miniapp";
import { useClients } from "../queries/clients";
import { useContainerTypes } from "../queries/container-types";
import { useOperationTypes } from "../queries/operation-types";
import { usePoints } from "../queries/points";
import { useCreateRequest, useRequest, useUpdateRequest } from "../queries/requests";
import { useRequestTypes } from "../queries/request-types";
import { useDrivers } from "../queries/staff";
import { useSettings } from "../queries/settings";
import { POINT_KINDS, POINT_KIND_LABELS, pointKindIcon, type PointKind } from "../../api/lib/route-def";
import { ClientSheet } from "./dict/clients";
import { PointSheet } from "./dict/points";

type StopDraft = {
  uid: number;
  id: number | null;
  label: string;
  kind: PointKind;
  pointId: string;
  operationTypeId: string;
  planned: string;
  /** Водитель уже начал остановку — менять нельзя. */
  locked: boolean;
};

type Head = {
  requestTypeId: string;
  clientId: string;
  containerNo: string;
  containerTypeId: string;
  cargoWeightT: string;
  comment: string;
  driverId: string;
  reminderMinutes: string;
};

const EMPTY: Head = {
  requestTypeId: "",
  clientId: "",
  containerNo: "",
  containerTypeId: "",
  cargoWeightT: "",
  comment: "",
  driverId: "",
  reminderMinutes: "",
};

let uidSeq = 1;
const newUid = () => uidSeq++;

type Points = NonNullable<ReturnType<typeof usePoints>["data"]>;

/** Пункт подставляется сам, если выбор однозначный (у клиента один склад, один терминал в справочнике). */
function autoPoint(points: Points, kind: PointKind, clientId: string): string {
  const active = points.filter((p) => !p.archived && p.kind === kind);
  if (kind === "warehouse" && clientId) {
    const own = active.filter((p) => String(p.clientId) === clientId);
    if (own.length === 1) return String(own[0]!.id);
    if (own.length > 1) return "";
  }
  return active.length === 1 ? String(active[0]!.id) : "";
}

export default function RequestForm({ id }: { id?: string }) {
  const editing = !!id;
  const requestId = id ? Number(id) : null;
  const [, navigate] = useLocation();
  const [head, setHead] = useState<Head>(EMPTY);
  const [stops, setStops] = useState<StopDraft[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [touched, setTouched] = useState(false);
  const [localError, setLocalError] = useState("");
  const [sheet, setSheet] = useState<{ type: "client" } | { type: "point"; uid: number; kind: PointKind } | null>(null);

  const existing = useRequest(editing ? requestId : null);
  const types = useRequestTypes();
  const clients = useClients();
  const containers = useContainerTypes();
  const ops = useOperationTypes();
  const points = usePoints();
  const drivers = useDrivers();
  const settings = useSettings();
  const create = useCreateRequest();
  const update = useUpdateRequest();
  const busy = create.isPending || update.isPending;
  const error = localError || (create.error ?? update.error ? errorText(create.error ?? update.error) : "");

  const opList = ops.data?.items ?? [];
  const pointList = points.data ?? [];
  const type = types.data?.find((t) => String(t.id) === head.requestTypeId);
  const started = stops.some((s) => s.locked);

  // Загрузка существующей заявки
  useEffect(() => {
    if (!editing || loaded || !existing.data) return;
    const { request: r, route } = existing.data;
    setHead({
      requestTypeId: String(r.requestTypeId),
      clientId: String(r.clientId),
      containerNo: r.containerNo,
      containerTypeId: String(r.containerTypeId),
      cargoWeightT: String(r.cargoWeightT),
      comment: r.comment ?? "",
      driverId: r.driverId ? String(r.driverId) : "",
      reminderMinutes: r.reminderMinutes ? String(r.reminderMinutes) : "",
    });
    setStops(
      route.stops.map((s) => ({
        uid: newUid(),
        id: s.id,
        label: "",
        kind: (s.point?.kind as PointKind) ?? "terminal",
        pointId: String(s.pointId),
        operationTypeId: String(s.operationTypeId),
        planned: toLocalInput(s.plannedArrivalAt),
        locked: !!s.arrivedAt || s.done.length > 0,
      })),
    );
    setLoaded(true);
  }, [editing, loaded, existing.data]);

  // Новая заявка: первый тип по умолчанию
  useEffect(() => {
    if (editing || head.requestTypeId || !types.data?.length || !points.data) return;
    applyType(String(types.data[0]!.id), head.clientId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, types.data, points.data]);

  useEffect(() => {
    closingConfirmation(touched);
    return () => closingConfirmation(false);
  }, [touched]);

  function applyType(typeId: string, clientId: string) {
    const t = types.data?.find((x) => String(x.id) === typeId);
    setHead((h) => ({ ...h, requestTypeId: typeId }));
    if (!t) return;
    setStops((prev) => {
      const keep = prev.filter((s) => s.locked);
      const fresh = t.stops
        .filter((s) => !s.optional)
        .slice(keep.length)
        .map((s) => ({
          uid: newUid(),
          id: null,
          label: s.label,
          kind: s.pointKind as PointKind,
          pointId: autoPoint(pointList, s.pointKind as PointKind, clientId),
          operationTypeId: String(s.operationTypeId),
          planned: "",
          locked: false,
        }));
      return [...keep, ...fresh];
    });
  }

  const setH = (k: keyof Head) => (v: string) => {
    setTouched(true);
    setHead((h) => ({ ...h, [k]: v }));
  };

  function setClient(clientId: string) {
    setH("clientId")(clientId);
    // Склады — из справочника выбранного клиента
    setStops((prev) =>
      prev.map((s) => {
        if (s.locked || s.kind !== "warehouse") return s;
        const cur = pointList.find((p) => String(p.id) === s.pointId);
        if (cur && (!cur.clientId || String(cur.clientId) === clientId)) return s;
        return { ...s, pointId: autoPoint(pointList, "warehouse", clientId) };
      }),
    );
  }

  const patchStop = (uid: number, p: Partial<StopDraft>) => {
    setTouched(true);
    setStops((prev) => prev.map((s) => (s.uid === uid ? { ...s, ...p } : s)));
  };
  const firstFree = stops.findIndex((s) => !s.locked);
  const move = (i: number, d: -1 | 1) =>
    setStops((p) => {
      const n = [...p];
      [n[i], n[i + d]] = [n[i + d]!, n[i]!];
      return n;
    });

  function addStop(tpl?: { label: string; pointKind: string; operationTypeId: number }) {
    setTouched(true);
    const kind = (tpl?.pointKind as PointKind) ?? "warehouse";
    const op = tpl?.operationTypeId ?? opList.find((o) => !o.archived && o.pointKinds.includes(kind))?.id;
    const draft: StopDraft = {
      uid: newUid(),
      id: null,
      label: tpl?.label ?? "",
      kind,
      pointId: autoPoint(pointList, kind, head.clientId),
      operationTypeId: op ? String(op) : "",
      planned: "",
      locked: false,
    };
    // Необязательную остановку шаблона ставим на её место в маршруте (перед последней)
    setStops((prev) => (tpl && prev.length > 1 ? [...prev.slice(0, -1), draft, prev[prev.length - 1]!] : [...prev, draft]));
  }

  const missingOptional = useMemo(
    () => (type?.stops ?? []).filter((s) => s.optional && !stops.some((d) => d.label === s.label)),
    [type, stops],
  );

  const timeWarnings = useMemo(() => {
    const out: number[] = [];
    let prev = 0;
    stops.forEach((s, i) => {
      const t = s.planned ? new Date(s.planned).getTime() : 0;
      if (t && prev && t < prev) out.push(i);
      if (t) prev = t;
    });
    return out;
  }, [stops]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLocalError("");
    const weight = Number(head.cargoWeightT.replace(",", "."));
    const problems = [
      !head.requestTypeId && "тип заявки",
      !head.clientId && "клиент",
      head.containerNo.trim().length < 4 && "номер контейнера",
      !head.containerTypeId && "тип контейнера",
      !(weight > 0) && "вес, т",
    ].filter(Boolean);
    if (problems.length) return setLocalError(`Заполните: ${problems.join(", ")}`);
    if (!stops.length) return setLocalError("Добавьте хотя бы одну остановку");
    const bad = stops.findIndex((s) => !s.pointId || !s.operationTypeId);
    if (bad >= 0) return setLocalError(`Остановка ${bad + 1}: выберите пункт и операцию`);

    const payload = {
      requestTypeId: Number(head.requestTypeId),
      clientId: Number(head.clientId),
      containerNo: head.containerNo,
      containerTypeId: Number(head.containerTypeId),
      cargoWeightT: weight,
      comment: head.comment.trim() || null,
      reminderMinutes: head.reminderMinutes ? Number(head.reminderMinutes) : null,
      stops: stops.map((s) => ({
        id: s.id,
        pointId: Number(s.pointId),
        operationTypeId: Number(s.operationTypeId),
        plannedArrivalAt: s.planned ? new Date(s.planned).toISOString() : null,
      })),
    };
    try {
      if (editing && requestId) {
        await update.mutateAsync({ ...payload, id: requestId });
        setTouched(false);
        navigate(`/requests/${requestId}`);
      } else {
        const created = await create.mutateAsync({ ...payload, driverId: head.driverId ? Number(head.driverId) : null });
        setTouched(false);
        navigate(`/requests/${created.id}`);
      }
    } catch {
      /* ошибка показывается из mutation.error */
    }
  }

  const client = clients.data?.find((c) => String(c.id) === head.clientId);

  return (
    <form onSubmit={submit} className="mx-auto max-w-4xl space-y-4 pb-20 md:pb-0">
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="outline" size="sm" onClick={() => navigate(editing ? `/requests/${requestId}` : "/")}>
          <ArrowLeft className="size-4" />
          Назад
        </Button>
        <h1 className="text-xl font-extrabold tracking-tight">
          {editing ? `Редактирование ${existing.data?.request.number ?? ""}` : "Новая заявка"}
        </h1>
        <Button type="submit" size="sm" className="ml-auto hidden md:inline-flex" disabled={busy}>
          <Save className="size-4" />
          {busy ? "Сохраняем…" : editing ? "Сохранить" : "Создать заявку"}
        </Button>
      </div>

      {!!error && (
        <div className="rounded-md border border-[color-mix(in_srgb,var(--danger)_35%,transparent)] bg-[color-mix(in_srgb,var(--danger)_10%,transparent)] px-4 py-3 text-sm font-semibold text-[var(--danger)]">
          {error}
        </div>
      )}

      <Card title="Тип заявки">
        <div className="grid gap-2 sm:grid-cols-3">
          {(types.data ?? []).map((t) => {
            const on = String(t.id) === head.requestTypeId;
            return (
              <button
                key={t.id}
                type="button"
                disabled={started && !on}
                onClick={() => {
                  setTouched(true);
                  applyType(String(t.id), head.clientId);
                }}
                className={cn(
                  "rounded-lg border px-3 py-2.5 text-left transition-colors disabled:opacity-40",
                  on ? "border-[var(--primary)] bg-[var(--primary)]/10" : "border-border hover:border-[var(--primary)]/50",
                )}
              >
                <div className="text-sm font-bold leading-snug">{t.name}</div>
                <div className="mt-1 text-[11px] text-[var(--muted-foreground)]">
                  {t.stops.filter((s) => !s.optional).map((s) => pointKindIcon(s.pointKind)).join(" → ")}
                  {t.description ? ` · ${t.description}` : ""}
                </div>
              </button>
            );
          })}
        </div>
        {started && <p className="mt-2 text-[11px] text-[var(--muted-foreground)]">Рейс начат — тип заявки сменить нельзя.</p>}
      </Card>

      <Card title="Клиент и контейнер">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Labeled label="Клиент" required className="sm:col-span-2">
            <div className="flex gap-2">
              <select value={head.clientId} onChange={(e) => setClient(e.target.value)} className="w-full min-w-0">
                <option value="">— выберите —</option>
                {clients.data?.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <Button type="button" variant="outline" size="icon" onClick={() => setSheet({ type: "client" })} aria-label="Новый клиент" title="Новый клиент">
                <Plus />
              </Button>
            </div>
          </Labeled>
          <TextField
            label="№ контейнера"
            required
            mono
            value={head.containerNo}
            onChange={(v) => setH("containerNo")(v.toUpperCase())}
            placeholder="MSKU1234567"
          />
          <div className="grid grid-cols-2 gap-3">
            <SelectField
              label="Тип"
              required
              value={head.containerTypeId}
              onChange={setH("containerTypeId")}
              placeholder="—"
              options={(containers.data ?? []).map((c) => ({ value: c.id, label: c.code }))}
            />
            <TextField label="Вес, т" required mono value={head.cargoWeightT} onChange={setH("cargoWeightT")} inputMode="decimal" placeholder="24.5" />
          </div>
        </div>
        {client && (client.contactName || client.phone) && (
          <p className="mt-2 text-[11px] text-[var(--muted-foreground)]">
            Контакт клиента: {[client.contactName, client.phone].filter(Boolean).join(", ")}
          </p>
        )}
      </Card>

      <Card
        title="Маршрут"
        action={
          <Button type="button" variant="outline" size="sm" onClick={() => addStop()}>
            <Plus /> Остановка
          </Button>
        }
      >
        <ol className="relative space-y-3">
          {stops.map((s, i) => {
            const allowedOps = opList.filter((o) => (!o.archived || String(o.id) === s.operationTypeId) && o.pointKinds.includes(s.kind));
            const kindPoints = pointList.filter((p) => p.kind === s.kind && (!p.archived || String(p.id) === s.pointId));
            const own = s.kind === "warehouse" && head.clientId ? kindPoints.filter((p) => String(p.clientId) === head.clientId) : [];
            const rest = kindPoints.filter((p) => !own.includes(p));
            const point = pointList.find((p) => String(p.id) === s.pointId);
            const canMove = !s.locked;
            return (
              <li key={s.uid} className={cn("rounded-lg border border-border p-3", s.locked && "bg-[var(--muted)]/50")}>
                <div className="mb-3 flex items-center gap-2">
                  <span className="mono grid size-6 shrink-0 place-items-center rounded-full bg-[var(--primary)] text-xs font-bold text-[var(--primary-foreground)]">
                    {i + 1}
                  </span>
                  <span className="min-w-0 truncate text-sm font-bold">
                    {s.label || `${pointKindIcon(s.kind)} ${POINT_KIND_LABELS[s.kind]}`}
                  </span>
                  {s.locked && (
                    <span className="inline-flex items-center gap-1 text-[11px] text-[var(--muted-foreground)]">
                      <Lock className="size-3" /> начата водителем
                    </span>
                  )}
                  {canMove && (
                    <div className="ml-auto flex shrink-0 gap-0.5">
                      <Button type="button" variant="ghost" size="icon-sm" disabled={i <= firstFree} onClick={() => move(i, -1)} aria-label="Выше">
                        <ArrowUp />
                      </Button>
                      <Button type="button" variant="ghost" size="icon-sm" disabled={i === stops.length - 1} onClick={() => move(i, 1)} aria-label="Ниже">
                        <ArrowDown />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className="text-[var(--danger)]"
                        onClick={() => {
                          setTouched(true);
                          setStops((p) => p.filter((x) => x.uid !== s.uid));
                        }}
                        aria-label="Убрать остановку"
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  )}
                </div>
                <fieldset disabled={s.locked} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[8.5rem_minmax(0,1.4fr)_minmax(0,1.2fr)_11.5rem]">
                  <SelectField
                    label="Вид"
                    value={s.kind}
                    onChange={(v) => {
                      const kind = v as PointKind;
                      const keepOp = opList.find((o) => String(o.id) === s.operationTypeId)?.pointKinds.includes(kind);
                      const op = keepOp ? s.operationTypeId : String(opList.find((o) => !o.archived && o.pointKinds.includes(kind))?.id ?? "");
                      patchStop(s.uid, { kind, pointId: autoPoint(pointList, kind, head.clientId), operationTypeId: op });
                    }}
                    options={POINT_KINDS.map((k) => ({ value: k, label: `${pointKindIcon(k)} ${POINT_KIND_LABELS[k]}` }))}
                  />
                  <Labeled
                    label="Пункт"
                    required
                    hint={point?.address ?? (s.kind === "warehouse" && head.clientId && !own.length ? "У клиента пока нет складов — добавьте" : undefined)}
                  >
                    <div className="flex gap-2">
                      <select value={s.pointId} onChange={(e) => patchStop(s.uid, { pointId: e.target.value })} className="w-full min-w-0">
                        <option value="">— выберите —</option>
                        {own.length > 0 && (
                          <optgroup label={`Склады клиента`}>
                            {own.map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.name}
                              </option>
                            ))}
                          </optgroup>
                        )}
                        {own.length > 0 && rest.length > 0 ? (
                          <optgroup label="Другие">
                            {rest.map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.name}
                              </option>
                            ))}
                          </optgroup>
                        ) : (
                          rest.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name}
                            </option>
                          ))
                        )}
                      </select>
                      {!s.locked && (
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          onClick={() => setSheet({ type: "point", uid: s.uid, kind: s.kind })}
                          aria-label="Новый пункт"
                          title="Новый пункт"
                        >
                          <Plus />
                        </Button>
                      )}
                    </div>
                  </Labeled>
                  <SelectField
                    label="Операция"
                    required
                    value={s.operationTypeId}
                    onChange={(v) => patchStop(s.uid, { operationTypeId: v })}
                    placeholder="— выберите —"
                    options={allowedOps.map((o) => ({ value: o.id, label: o.name }))}
                  />
                  <TextField
                    label="Плановое прибытие"
                    type="datetime-local"
                    value={s.planned}
                    onChange={(v) => patchStop(s.uid, { planned: v })}
                    hint={
                      timeWarnings.includes(i) ? (
                        <span className="inline-flex items-center gap-1 text-[var(--warning)]">
                          <AlertTriangle className="size-3" /> раньше предыдущей
                        </span>
                      ) : undefined
                    }
                  />
                </fieldset>
              </li>
            );
          })}
        </ol>
        {!stops.length && <div className="py-4 text-center text-sm text-[var(--muted-foreground)]">Выберите тип заявки или добавьте остановку</div>}
        {missingOptional.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {missingOptional.map((s) => (
              <Button key={s.id} type="button" variant="outline" size="sm" onClick={() => addStop(s)}>
                <Plus /> {s.label}
              </Button>
            ))}
          </div>
        )}
      </Card>

      <Card title={editing ? "Напоминание" : "Водитель и напоминание"}>
        <div className="grid gap-4 sm:grid-cols-2">
          {!editing && (
            <Labeled
              label="Водитель"
              hint={
                drivers.data?.find((d) => String(d.id) === head.driverId && d.selfTest)
                  ? "Тестовый рейс на вас: карточка придёт вам в чат бота MAX"
                  : drivers.data?.find((d) => String(d.id) === head.driverId && !d.inBot)
                    ? "Водитель ещё не активирован в MAX — карточка придёт сразу после регистрации"
                    : head.driverId
                      ? "Карточка заявки уйдёт водителю в MAX сразу после сохранения"
                      : "Можно назначить позже из карточки заявки"
              }
            >
              <select value={head.driverId} onChange={(e) => setH("driverId")(e.target.value)} className="w-full">
                <option value="">— не назначать —</option>
                {drivers.data?.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.selfTest ? `Я — ${d.fullName} · тестовый рейс` : d.fullName}
                    {d.vehicle && !d.selfTest ? ` · ${d.vehicle}` : ""}
                    {d.inBot ? "" : " · не в боте"}
                  </option>
                ))}
              </select>
            </Labeled>
          )}
          <SelectField
            label="Напомнить водителю за"
            value={head.reminderMinutes}
            onChange={setH("reminderMinutes")}
            placeholder={`По умолчанию (${minutesLabel(settings.data?.reminderMinutes ?? 60)})`}
            options={[15, 30, 45, 60, 90, 120, 180, 240].map((m) => ({ value: m, label: `${minutesLabel(m)} до прибытия` }))}
            hint="Напоминание приходит перед каждой остановкой с плановым временем"
          />
        </div>
      </Card>

      <Card title="Комментарий диспетчера">
        <TextAreaField
          label="Видит водитель"
          value={head.comment}
          onChange={setH("comment")}
          rows={3}
          placeholder="Особые условия, пропуск, требования склада…"
        />
      </Card>

      {/* Кнопка сохранения всегда под рукой на телефоне */}
      <div className="fixed inset-x-0 bottom-0 z-10 border-t border-border bg-[var(--surface)]/95 p-3 backdrop-blur md:hidden">
        <Button type="submit" className="w-full" disabled={busy}>
          <Save className="size-4" />
          {busy ? "Сохраняем…" : editing ? "Сохранить" : "Создать заявку"}
        </Button>
      </div>

      {sheet?.type === "client" && (
        <ClientSheet
          onClose={() => setSheet(null)}
          onSaved={(cid) => {
            setClient(String(cid));
          }}
        />
      )}
      {sheet?.type === "point" && (
        <PointSheet
          kind={sheet.kind}
          lockKind
          clientId={head.clientId ? Number(head.clientId) : null}
          onClose={() => setSheet(null)}
          onSaved={(pid) => patchStop(sheet.uid, { pointId: String(pid) })}
        />
      )}
    </form>
  );
}
