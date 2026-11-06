import { useState } from "react";
import { Link, useLocation } from "wouter";
import { ArrowLeft, Ban, Bell, MessageSquare, Paperclip, Pencil, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, Empty, Field } from "../components/shell";
import { AlertBadge, StatusBadge } from "../components/status-badge";
import { errorText } from "../lib/api";
import { fmtDateTime, minutesLabel } from "../lib/format";
import { formatPhone } from "../../api/lib/domain";
import { RouteTimeline, openLink } from "../components/route-timeline";
import { mapUrl, statusLabel } from "../../api/lib/route-def";
import { downloadFile, inMax } from "../lib/miniapp";
import {
  useAcknowledgeAlert,
  useAddComment,
  useAssignDriver,
  useCancelRequest,
  useRaiseAlert,
  useRequest,
  useResendCard,
} from "../queries/requests";
import { useDrivers } from "../queries/staff";

export default function RequestDetail({ id }: { id: string }) {
  const requestId = Number(id);
  const [, navigate] = useLocation();
  const detail = useRequest(requestId);
  const drivers = useDrivers();

  const assign = useAssignDriver();
  const cancel = useCancelRequest();
  const resend = useResendCard();
  const comment = useAddComment();
  const ack = useAcknowledgeAlert();
  const raise = useRaiseAlert();

  const [driverId, setDriverId] = useState("");
  const [assignNote, setAssignNote] = useState<string | null>(null);
  const [commentText, setCommentText] = useState("");
  const [notifyDriver, setNotifyDriver] = useState(true);
  const [cancelReason, setCancelReason] = useState("");
  const [cancelOpen, setCancelOpen] = useState(false);

  if (detail.isLoading) return <Empty text="Загружаем заявку…" />;
  if (detail.isError || !detail.data) return <Empty text={errorText(detail.error) || "Заявка не найдена"} />;

  const { request: r, route, driver, history, attachments, alerts } = detail.data;
  const stopNo = (stopId: number | null) => (stopId ? route.stops.find((x) => x.id === stopId)?.index : undefined);
  const openAlerts = alerts.filter((a) => !a.acknowledgedAt);
  const closed = r.status === "cancelled" || r.status === "done";
  const actionError = assign.error ?? cancel.error ?? resend.error ?? raise.error;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" size="sm" onClick={() => navigate("/")}>
          <ArrowLeft className="size-4" />
          К списку
        </Button>
        <div>
          <h1 className="mono text-xl font-extrabold tracking-tight">{r.number}</h1>
          <p className="text-xs text-[var(--muted-foreground)]">
            создана {fmtDateTime(r.createdAt)} · обновлена {fmtDateTime(r.updatedAt)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge status={r.status} />
          {openAlerts.map((a) => (
            <AlertBadge key={a.id} type={a.type} />
          ))}
        </div>
        <div className="ml-auto flex flex-wrap gap-2">
          {!closed && (
            <Button size="sm" variant="outline" asChild>
              <Link href={`/requests/${r.id}/edit`}>
                <Pencil className="size-4" />
                Изменить
              </Link>
            </Button>
          )}
          {!closed && r.driverId && (
            <Button size="sm" variant="outline" disabled={resend.isPending} onClick={() => resend.mutate({ id: r.id })}>
              <Send className="size-4" />
              Отправить карточку заново
            </Button>
          )}
          {!closed && (
            <Button size="sm" variant="destructive" onClick={() => setCancelOpen((v) => !v)}>
              <Ban className="size-4" />
              Отменить
            </Button>
          )}
        </div>
      </div>

      {!!actionError && (
        <div className="rounded-md border border-[color-mix(in_srgb,var(--danger)_35%,transparent)] bg-[color-mix(in_srgb,var(--danger)_10%,transparent)] px-4 py-3 text-sm font-semibold text-[var(--danger)]">
          {errorText(actionError)}
        </div>
      )}

      {cancelOpen && !closed && (
        <Card title="Отмена заявки">
          <div className="flex flex-wrap items-end gap-3">
            <label className="min-w-[240px] flex-1">
              <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-foreground)]">
                Причина (уйдёт водителю)
              </span>
              <input
                aria-label="Причина отмены заявки"
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
                className="w-full"
              />
            </label>
            <Button
              variant="destructive"
              disabled={cancel.isPending}
              onClick={async () => {
                await cancel.mutateAsync({ id: r.id, reason: cancelReason || undefined });
                setCancelOpen(false);
                setCancelReason("");
              }}
            >
              Подтвердить отмену
            </Button>
            <Button variant="outline" onClick={() => setCancelOpen(false)}>
              Не отменять
            </Button>
          </div>
        </Card>
      )}

      {!!openAlerts.length && (
        <Card title="Тревоги по заявке">
          <ul className="space-y-2">
            {openAlerts.map((a) => (
              <li
                key={a.id}
                className="flex flex-wrap items-center gap-3 rounded-md border border-[color-mix(in_srgb,var(--danger)_30%,transparent)] bg-[color-mix(in_srgb,var(--danger)_8%,transparent)] px-3 py-2"
              >
                <AlertBadge type={a.type} />
                <span className="min-w-0 flex-1 text-sm">{a.message || "Без комментария"}</span>
                <span className="mono text-xs text-[var(--muted-foreground)]">{fmtDateTime(a.createdAt)}</span>
                <Button size="sm" variant="outline" disabled={ack.isPending} onClick={() => ack.mutate({ alertId: a.id })}>
                  Принял в работу
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Card title="Заявка">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="Тип заявки" value={route.typeName} />
              <Field label="Клиент" value={route.client?.name} />
              <Field label="Контакт клиента" value={[route.client?.contactName, formatPhone(route.client?.phone)].filter(Boolean).join(", ")} />
              <Field label="Контейнер" value={r.containerNo} mono />
              <Field label="Тип · вес" value={`${route.containerCode ?? "—"} · ${r.cargoWeightT} т`} mono />
              <Field
                label="Напоминание"
                value={r.reminderMinutes ? `${minutesLabel(r.reminderMinutes)} до прибытия` : "по умолчанию"}
              />
            </div>
            {r.comment && (
              <div className="mt-4 rounded-md border border-border bg-[var(--surface-2)] p-3 text-sm">
                <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-foreground)]">
                  Комментарий к заявке
                </div>
                {r.comment}
              </div>
            )}
          </Card>

          <RouteTimeline
            stops={route.stops}
            currentStopId={route.currentStopId}
            isLate={detail.data.isLate}
            closed={closed}
            attachments={attachments}
            history={history}
          />

          <Card title={`История · ${history.length}`}>
            {!history.length ? (
              <Empty text="Событий пока нет" />
            ) : (
              <ol className="space-y-3">
                {history.map((h) => (
                  <li key={h.id} className="flex gap-3">
                    <div className="mono w-[104px] shrink-0 text-xs text-[var(--muted-foreground)]">
                      {fmtDateTime(h.createdAt)}
                    </div>
                    <div className="min-w-0 flex-1 border-l border-border pl-3">
                      <div className="text-sm font-bold">
                        {h.status === "action" && h.comment ? h.comment : statusLabel(h.status)}
                        {stopNo(h.stopId) && (
                          <span className="mono ml-2 rounded bg-[var(--muted)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--muted-foreground)]">
                            остановка {stopNo(h.stopId)}
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-[var(--muted-foreground)]">
                        {h.actorName ?? (h.actorKind === "system" ? "Система" : "—")}
                        {h.actorKind === "driver" && " · водитель"}
                        {h.actorKind === "dispatcher" && " · диспетчер"}
                      </div>
                      {h.comment && h.status !== "action" && <div className="mt-1 text-sm">{h.comment}</div>}
                      {h.latitude != null && h.longitude != null && (
                        <a
                          className="mono mt-1 inline-block text-xs text-[var(--info)] hover:underline"
                          href={mapUrl(h.latitude, h.longitude)}
                          target="_blank"
                          rel="noreferrer"
                          onClick={(e) => openLink(e, mapUrl(h.latitude!, h.longitude!))}
                        >
                          📍 {Number(h.latitude).toFixed(5)}, {Number(h.longitude).toFixed(5)}
                        </a>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </Card>
        </div>

        <div className="space-y-5">
          <Card title="Водитель">
            {driver ? (
              <div className="space-y-2">
                <div className="text-sm font-bold">{driver.fullName}</div>
                <div className="mono text-sm text-[var(--muted-foreground)]">{formatPhone(driver.phone)}</div>
                {driver.vehicle && <div className="mono text-sm">{driver.vehicle}</div>}
                <Badge tone={driver.status === "active" ? "success" : "warning"}>
                  {driver.status === "active"
                    ? "активен в боте"
                    : driver.status === "blocked"
                      ? "заблокирован"
                      : "не зарегистрирован в боте — карточка придёт после активации"}
                </Badge>
              </div>
            ) : (
              <p className="text-sm text-[var(--warning)]">Водитель не назначен</p>
            )}

            {!closed && (
              <div className="mt-4 space-y-2 border-t border-border pt-4">
                <span className="block text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-foreground)]">
                  {driver ? "Переназначить" : "Назначить"}
                </span>
                <select value={driverId} onChange={(e) => setDriverId(e.target.value)} className="w-full">
                  <option value="">— выберите водителя —</option>
                  {drivers.data
                    ?.filter((d) => d.id !== driver?.id)
                    .map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.selfTest ? `Я — ${d.fullName} · тестовый рейс` : d.fullName}
                        {d.vehicle && !d.selfTest ? ` · ${d.vehicle}` : ""}
                        {d.inBot ? "" : " · не в боте"}
                      </option>
                    ))}
                </select>
                {drivers.data?.find((d) => String(d.id) === driverId && d.selfTest) && (
                  <p className="text-[11px] text-[var(--muted-foreground)]">
                    Тестовый рейс на вас: карточка с кнопками статусов придёт вам в чат бота MAX.
                  </p>
                )}
                {drivers.data?.find((d) => String(d.id) === driverId && !d.inBot) && (
                  <p className="text-[11px] text-[var(--warning)]">
                    Водитель ещё не зарегистрирован в боте MAX. Заявка будет закреплена за ним, а карточка
                    придёт автоматически после активации по инвайт-ссылке.
                  </p>
                )}
                <Button
                  size="sm"
                  className="w-full"
                  disabled={!driverId || assign.isPending}
                  onClick={async () => {
                    const res = await assign.mutateAsync({ id: r.id, driverId: Number(driverId) });
                    setAssignNote(
                      res.delivery.ok
                        ? "Водитель назначен, карточка отправлена в MAX"
                        : `Водитель назначен. Карточка будет отправлена после регистрации в боте (${res.delivery.error ?? "нет связи с MAX"})`,
                    );
                    setDriverId("");
                  }}
                >
                  <Send className="size-4" />
                  {driver ? "Переназначить и отправить" : "Назначить и отправить карточку"}
                </Button>
              </div>
            )}
            {assignNote && (
              <p className="mt-3 text-xs font-semibold text-[var(--muted-foreground)]">{assignNote}</p>
            )}
          </Card>

          <Card title={`Вложения · ${attachments.length}`}>
            {!attachments.length ? (
              <Empty text="Фото и документы появятся здесь, когда водитель их приложит" />
            ) : (
              <ul className="space-y-2">
                {attachments.map((a) => {
                  const href = a.storedUrl ?? a.maxUrl;
                  return (
                    <li key={a.id} className="flex items-center gap-2 text-sm">
                      <Paperclip className="size-4 shrink-0 text-[var(--muted-foreground)]" />
                      {href ? (
                        <a
                          href={href}
                          target="_blank"
                          rel="noreferrer"
                          className="min-w-0 flex-1 truncate text-[var(--info)] hover:underline"
                          onClick={(e) => {
                            if (!inMax()) return;
                            e.preventDefault();
                            downloadFile(href, a.fileName ?? `attachment-${a.id}`);
                          }}
                        >
                          {stopNo(a.stopId) ? `№${stopNo(a.stopId)} · ` : ""}
                          {a.fileName ?? a.kind}
                        </a>
                      ) : (
                        <span className="min-w-0 flex-1 truncate">{a.fileName ?? a.kind}</span>
                      )}
                      <span className="mono shrink-0 text-xs text-[var(--muted-foreground)]">
                        {fmtDateTime(a.createdAt)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          <Card title="Действия диспетчера">
            <div className="space-y-3">
              <textarea
                aria-label="Комментарий в историю заявки"
                rows={3}
                value={commentText}
                onChange={(e) => setCommentText(e.target.value)}
                placeholder="Комментарий в историю заявки"
                className="w-full"
              />
              <label className="flex items-center gap-2 text-xs text-[var(--muted-foreground)]">
                <input
                  type="checkbox"
                  aria-label="Отправить комментарий водителю в MAX"
                  checked={notifyDriver}
                  onChange={(e) => setNotifyDriver(e.target.checked)}
                  className="size-4"
                />
                Отправить водителю в MAX
              </label>
              <Button
                size="sm"
                variant="outline"
                className="w-full"
                disabled={!commentText.trim() || comment.isPending}
                onClick={async () => {
                  await comment.mutateAsync({ id: r.id, comment: commentText.trim(), notifyDriver });
                  setCommentText("");
                }}
              >
                <MessageSquare className="size-4" />
                Добавить комментарий
              </Button>

              {!closed && (
                <div className="grid gap-2 border-t border-border pt-3">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-foreground)]">
                    Поднять тревогу вручную
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={raise.isPending}
                    onClick={() => raise.mutate({ id: r.id, type: "late", message: "Отмечено диспетчером" })}
                  >
                    <Bell className="size-4" />
                    Возможно опоздание
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={raise.isPending}
                    onClick={() => raise.mutate({ id: r.id, type: "no_contact", message: "Водитель не отвечает" })}
                  >
                    <Bell className="size-4" />
                    Нет связи с водителем
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={raise.isPending}
                    onClick={() => raise.mutate({ id: r.id, type: "failure", message: "Отмечено диспетчером" })}
                  >
                    <Bell className="size-4" />
                    Срыв заявки
                  </Button>
                </div>
              )}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
