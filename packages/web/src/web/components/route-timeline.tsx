import { Check, Circle, MapPin, Phone } from "lucide-react";
import { cn } from "@/lib/utils";
import { Card } from "./shell";
import { fmtDateTime, fmtRelative, fmtTime } from "../lib/format";
import { inMax, openExternal } from "../lib/miniapp";
import { useRequest } from "../queries/requests";
import { formatPhone } from "../../api/lib/domain";
import { mapUrl, pointKindIcon, pointKindLabel } from "../../api/lib/route-def";

type Detail = NonNullable<ReturnType<typeof useRequest>["data"]>;
type Stop = Detail["route"]["stops"][number];

/** В мини-приложении MAX target="_blank" не работает — ссылки открываем через мост. */
export function openLink(e: React.MouseEvent, url: string) {
  if (!inMax()) return;
  e.preventDefault();
  openExternal(url);
}

function StopCard({
  stop,
  state,
  late,
  photos,
  geo,
}: {
  stop: Stop;
  state: "done" | "current" | "pending";
  late: boolean;
  photos: Detail["attachments"];
  geo: Detail["history"];
}) {
  const p = stop.point;
  const doneKeys = new Map(stop.done.map((d) => [d.key, d]));
  const nextKey = state === "current" ? stop.actions.find((a) => !doneKeys.has(a.key))?.key : undefined;
  const map = p?.lat != null && p?.lon != null ? mapUrl(p.lat, p.lon) : null;

  return (
    <li className="relative pl-9">
      {/* маркер */}
      <span
        className={cn(
          "absolute left-0 top-0 grid size-7 place-items-center rounded-full border-2 text-xs font-bold",
          state === "done" && "border-[var(--success)] bg-[var(--success)] text-white",
          state === "current" && !late && "border-[var(--primary)] bg-[var(--surface)] text-[var(--primary)]",
          state === "current" && late && "border-[var(--danger)] bg-[var(--surface)] text-[var(--danger)]",
          state === "pending" && "border-border bg-[var(--surface)] text-[var(--muted-foreground)]",
        )}
      >
        {state === "done" ? <Check className="size-4" /> : stop.index}
      </span>

      <div
        className={cn(
          "rounded-lg border p-3",
          state === "current" ? (late ? "border-[var(--danger)]/50" : "border-[var(--primary)]/50") : "border-border",
          state === "pending" && "opacity-80",
        )}
      >
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-sm font-bold">
            {p ? pointKindIcon(p.kind) : "📍"} {p?.name ?? "Пункт удалён"}
          </span>
          <span className="text-xs text-[var(--muted-foreground)]">{p ? pointKindLabel(p.kind) : ""}</span>
          {state === "current" && (
            <span className={cn("text-[11px] font-semibold", late ? "text-[var(--danger)]" : "text-[var(--primary)]")}>
              {late ? "● опаздывает" : "● текущая"}
            </span>
          )}
        </div>
        <div className="text-xs font-semibold text-[var(--muted-foreground)]">{stop.operationName}</div>

        {(p?.address || map || p?.phone || p?.schedule) && (
          <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-xs">
            {p?.address && <span className="text-[var(--muted-foreground)]">{p.address}</span>}
            {map && (
              <a href={map} target="_blank" rel="noreferrer" onClick={(e) => openLink(e, map)} className="inline-flex items-center gap-1 text-[var(--info)] hover:underline">
                <MapPin className="size-3" /> карта
              </a>
            )}
            {p?.phone && (
              <a href={`tel:${p.phone}`} className="mono inline-flex items-center gap-1 text-[var(--info)]">
                <Phone className="size-3" /> {formatPhone(p.phone)}
              </a>
            )}
            {p?.schedule && <span className="text-[var(--muted-foreground)]">🕘 {p.schedule}</span>}
          </div>
        )}

        <dl className="mono mt-2 grid grid-cols-3 gap-2 text-[11px]">
          <div>
            <dt className="text-[var(--muted-foreground)]">план</dt>
            <dd className={cn(late && "font-bold text-[var(--danger)]")}>
              {stop.plannedArrivalAt ? fmtDateTime(stop.plannedArrivalAt) : "—"}
            </dd>
            {state === "current" && stop.plannedArrivalAt && !stop.arrivedAt && (
              <dd className="text-[var(--muted-foreground)]">{fmtRelative(stop.plannedArrivalAt)}</dd>
            )}
          </div>
          <div>
            <dt className="text-[var(--muted-foreground)]">прибыл</dt>
            <dd>{stop.arrivedAt ? fmtDateTime(stop.arrivedAt) : "—"}</dd>
          </div>
          <div>
            <dt className="text-[var(--muted-foreground)]">завершено</dt>
            <dd>{stop.doneAt ? fmtDateTime(stop.doneAt) : "—"}</dd>
          </div>
        </dl>

        <ul className="mt-2 space-y-1">
          {stop.actions.map((a) => {
            const d = doneKeys.get(a.key);
            return (
              <li key={a.key} className="flex items-center gap-2 text-xs">
                {d ? (
                  <Check className="size-3.5 shrink-0 text-[var(--success)]" />
                ) : (
                  <Circle className={cn("size-3.5 shrink-0", a.key === nextKey ? "text-[var(--primary)]" : "text-[var(--muted-foreground)]")} />
                )}
                <span className={cn(!d && a.key !== nextKey && "text-[var(--muted-foreground)]", a.key === nextKey && "font-semibold")}>
                  {a.label || a.buttonText}
                </span>
                {a.photoRequired && <span title={a.photoHint}>📷</span>}
                {d && <span className="mono ml-auto text-[var(--muted-foreground)]">{fmtTime(d.at)}{d.photos ? ` · ${d.photos} фото` : ""}</span>}
                {!d && a.key === nextKey && <span className="ml-auto text-[11px] text-[var(--primary)]">ожидается</span>}
              </li>
            );
          })}
        </ul>

        {(photos.length > 0 || geo.length > 0) && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-border pt-2">
            {photos.slice(0, 8).map((f) => {
              const href = f.storedUrl ?? f.maxUrl;
              return href && f.kind === "image" ? (
                <a
                  key={f.id}
                  href={href}
                  target="_blank"
                  rel="noreferrer"
                  onClick={(e) => openLink(e, href)}
                  title={fmtDateTime(f.createdAt)}
                  aria-label={`Вложение от ${fmtDateTime(f.createdAt)}`}
                >
                  <img src={href} alt="" className="size-12 rounded border border-border object-cover" loading="lazy" />
                </a>
              ) : (
                <span key={f.id} className="rounded border border-border px-1.5 py-1 text-[10px]">📎 {f.fileName ?? f.kind}</span>
              );
            })}
            {photos.length > 8 && <span className="text-[11px] text-[var(--muted-foreground)]">+{photos.length - 8}</span>}
            {geo.map((g) => {
              const url = mapUrl(g.latitude!, g.longitude!);
              return (
                <a key={g.id} href={url} target="_blank" rel="noreferrer" onClick={(e) => openLink(e, url)} className="rounded-full border border-border px-2 py-0.5 text-[11px] text-[var(--info)]">
                  📍 {fmtTime(g.createdAt)}
                </a>
              );
            })}
          </div>
        )}
      </div>
    </li>
  );
}

export function RouteTimeline({
  stops,
  currentStopId,
  isLate,
  closed,
  attachments,
  history,
}: {
  stops: Stop[];
  currentStopId: number | null;
  isLate: boolean;
  closed: boolean;
  attachments: Detail["attachments"];
  history: Detail["history"];
}) {
  const doneCount = stops.filter((s) => s.doneAt).length;
  return (
    <Card title={`Маршрут · ${doneCount}/${stops.length}`}>
      {!stops.length ? (
        <div className="text-sm text-[var(--muted-foreground)]">Остановки не заданы</div>
      ) : (
        <ol className="relative space-y-3 before:absolute before:bottom-4 before:left-[13px] before:top-4 before:w-0.5 before:bg-border">
          {stops.map((s) => {
            const state = s.doneAt ? "done" : !closed && s.id === currentStopId ? "current" : "pending";
            return (
              <StopCard
                key={s.id}
                stop={s}
                state={state}
                late={state === "current" && isLate}
                photos={attachments.filter((a) => a.stopId === s.id)}
                geo={history.filter((h) => h.stopId === s.id && h.latitude != null && h.longitude != null)}
              />
            );
          })}
        </ol>
      )}
    </Card>
  );
}
