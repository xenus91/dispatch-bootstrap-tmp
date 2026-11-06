import { useEffect, useState } from "react";
import { Activity, Link2, RefreshCw, Save, ShieldCheck, Unlink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, Field } from "../components/shell";
import { errorText } from "../lib/api";
import { minutesLabel } from "../lib/format";
import { Toggle } from "../components/ui/toggle";
import {
  useCheckWebhook,
  useIntegration,
  useRotateWebhookSecret,
  useSecurity,
  useSettings,
  useSubscribeWebhook,
  useUnsubscribeWebhook,
  useUpdateSecurity,
  useUpdateSettings,
  useWebhookStats,
} from "../queries/settings";

const REMINDER_OPTIONS = [15, 30, 45, 60, 90, 120, 180, 240];
const STOP_LATE_OPTIONS = [10, 15, 20, 30, 45, 60, 90, 120];
const ESCALATE_OPTIONS = [5, 10, 15, 30, 60];
const WEB_SESSION_OPTIONS = [
  { v: 4, l: "4 часа" },
  { v: 8, l: "8 часов (смена)" },
  { v: 12, l: "12 часов" },
  { v: 24, l: "24 часа" },
  { v: 72, l: "3 дня" },
  { v: 168, l: "7 дней" },
];
const MINIAPP_SESSION_OPTIONS = [
  { v: 1, l: "1 день" },
  { v: 7, l: "7 дней" },
  { v: 30, l: "30 дней" },
  { v: 90, l: "90 дней" },
];
const INACTIVITY_OPTIONS = [
  { v: 0, l: "Не приостанавливать" },
  { v: 7, l: "7 дней" },
  { v: 14, l: "14 дней" },
  { v: 30, l: "30 дней" },
  { v: 60, l: "60 дней" },
  { v: 90, l: "90 дней" },
];

const selectLabel = "mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-foreground)]";
const hint = "mt-1 block text-[11px] text-[var(--muted-foreground)]";

/** Политика доступа: ручной допуск, сроки сеансов, автоприостановка неактивных. */
function SecurityCard() {
  const security = useSecurity();
  const save = useUpdateSecurity();
  const [f, setF] = useState<{
    requireApproval: boolean;
    webSessionHours: number;
    miniAppSessionDays: number;
    inactivityDays: number;
  } | null>(null);

  useEffect(() => {
    if (!f && security.data) setF(security.data);
  }, [f, security.data]);

  if (!f) return <Card title="Безопасность доступа">Загружаем…</Card>;
  const withCurrent = (opts: { v: number; l: string }[], v: number, unit: string) =>
    opts.some((o) => o.v === v) ? opts : [...opts, { v, l: `${v} ${unit}` }].sort((a, b) => a.v - b.v);

  return (
    <Card title={<span className="flex items-center gap-2"><ShieldCheck className="size-4" />Безопасность доступа</span>}>
      <form
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate(f);
        }}
      >
        <div className="flex items-start gap-3">
          <Toggle
            label="Ручной допуск новых сотрудников"
            checked={f.requireApproval}
            onChange={(v) => setF({ ...f, requireApproval: v })}
          />
          <div>
            <div className="text-sm font-bold">Ручной допуск новых сотрудников</div>
            <p className="text-[11px] text-[var(--muted-foreground)]">
              После инвайт-ссылки и подтверждения номера сотрудник получает статус «Ждёт допуска». Админам
              приходит сообщение в MAX с кнопками «Допустить / Отклонить». Пересланная ссылка без допуска
              ничего не даст.
            </p>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className={selectLabel}>Сеанс в браузере</span>
            <select
              value={f.webSessionHours}
              onChange={(e) => setF({ ...f, webSessionHours: Number(e.target.value) })}
              className="w-full"
            >
              {withCurrent(WEB_SESSION_OPTIONS, f.webSessionHours, "ч").map((o) => (
                <option key={o.v} value={o.v}>
                  {o.l}
                </option>
              ))}
            </select>
            <span className={hint}>После срока — вход заново по коду из MAX</span>
          </label>
          <label className="block">
            <span className={selectLabel}>Сеанс в Mini App MAX</span>
            <select
              value={f.miniAppSessionDays}
              onChange={(e) => setF({ ...f, miniAppSessionDays: Number(e.target.value) })}
              className="w-full"
            >
              {withCurrent(MINIAPP_SESSION_OPTIONS, f.miniAppSessionDays, "дн.").map((o) => (
                <option key={o.v} value={o.v}>
                  {o.l}
                </option>
              ))}
            </select>
            <span className={hint}>Внутри MAX личность подтверждает подпись мессенджера</span>
          </label>
          <label className="block">
            <span className={selectLabel}>Приостановить при неактивности</span>
            <select
              value={f.inactivityDays}
              onChange={(e) => setF({ ...f, inactivityDays: Number(e.target.value) })}
              className="w-full"
            >
              {withCurrent(INACTIVITY_OPTIONS, f.inactivityDays, "дн.").map((o) => (
                <option key={o.v} value={o.v}>
                  {o.l}
                </option>
              ))}
            </select>
            <span className={hint}>
              Нет действий в боте и панели N дней → доступ блокируется. Админов и водителей с открытой
              заявкой не трогаем
            </span>
          </label>
        </div>

        <p className="text-[11px] text-[var(--muted-foreground)]">
          Всегда включено: 5 неверных кодов подряд — вход закрыт на 15 минут, админам и владельцу номера
          приходит сообщение; код можно запросить не чаще раза в минуту и не больше 5 раз в час. Срок
          доступа по договору задаётся в карточке сотрудника («Доступ до»).
        </p>

        {save.isError && <p className="text-xs font-semibold text-[var(--danger)]">{errorText(save.error)}</p>}
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={save.isPending}>
            <Save className="size-4" />
            {save.isPending ? "Сохраняем…" : "Сохранить"}
          </Button>
          {save.isSuccess && <span className="text-xs text-[var(--success)]">Сохранено. Новые сроки — для следующих входов</span>}
        </div>
      </form>
    </Card>
  );
}

export default function SettingsPage() {
  const settings = useSettings();
  const integration = useIntegration(true);
  const save = useUpdateSettings();
  const subscribe = useSubscribeWebhook();
  const unsubscribe = useUnsubscribeWebhook();
  const check = useCheckWebhook();
  const rotate = useRotateWebhookSecret();
  const stats = useWebhookStats(true);
  const [hookUrl, setHookUrl] = useState("");

  const [reminderMinutes, setReminderMinutes] = useState("60");
  const [stopLateMinutes, setStopLateMinutes] = useState("30");
  const [alertEscalateMinutes, setAlertEscalateMinutes] = useState("15");
  const [companyName, setCompanyName] = useState("");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (loaded || !settings.data) return;
    setReminderMinutes(String(settings.data.reminderMinutes));
    setStopLateMinutes(String(settings.data.stopLateMinutes));
    setAlertEscalateMinutes(String(settings.data.alertEscalateMinutes));
    setCompanyName(settings.data.companyName);
    setLoaded(true);
  }, [loaded, settings.data]);

  const webhookUrl = `${window.location.origin}/api/webhooks/max`;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-extrabold tracking-tight">Настройки</h1>
        <p className="text-xs text-[var(--muted-foreground)]">
          Параметры напоминаний и состояние интеграции с MAX
        </p>
      </div>

      <Card title="Напоминания и тревоги">
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate({
              reminderMinutes: Number(reminderMinutes),
              stopLateMinutes: Number(stopLateMinutes),
              alertEscalateMinutes: Number(alertEscalateMinutes),
              companyName: companyName || undefined,
            });
          }}
        >
          <div className="grid gap-4 sm:grid-cols-3">
            <label className="block">
              <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-foreground)]">
                Напомнить водителю за
              </span>
              <select value={reminderMinutes} onChange={(e) => setReminderMinutes(e.target.value)} className="w-full">
                {REMINDER_OPTIONS.map((m) => (
                  <option key={m} value={m}>
                    {minutesLabel(m)} до прибытия
                  </option>
                ))}
              </select>
              <span className="mt-1 block text-[11px] text-[var(--muted-foreground)]">
                Перед каждой остановкой с плановым временем; в заявке можно переопределить
              </span>
            </label>

            <label className="block">
              <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-foreground)]">
                Тревога «опаздывает» через
              </span>
              <select value={stopLateMinutes} onChange={(e) => setStopLateMinutes(e.target.value)} className="w-full">
                {STOP_LATE_OPTIONS.map((m) => (
                  <option key={m} value={m}>
                    {minutesLabel(m)} после плана
                  </option>
                ))}
              </select>
              <span className="mt-1 block text-[11px] text-[var(--muted-foreground)]">
                Если водитель не отметил прибытие на текущую остановку
              </span>
            </label>

            <label className="block">
              <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-foreground)]">
                Повтор тревоги диспетчеру через
              </span>
              <select
                value={alertEscalateMinutes}
                onChange={(e) => setAlertEscalateMinutes(e.target.value)}
                className="w-full"
              >
                {ESCALATE_OPTIONS.map((m) => (
                  <option key={m} value={m}>
                    {m} мин
                  </option>
                ))}
              </select>
              <span className="mt-1 block text-[11px] text-[var(--muted-foreground)]">
                Если тревога не принята в работу, бот напомнит повторно
              </span>
            </label>

            <label className="block">
              <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-foreground)]">
                Название компании
              </span>
              <input
                aria-label="Название компании"
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
                className="w-full"
              />
            </label>
          </div>

          {save.isError && (
            <p className="text-xs font-semibold text-[var(--danger)]">{errorText(save.error)}</p>
          )}
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={save.isPending}>
              <Save className="size-4" />
              {save.isPending ? "Сохраняем…" : "Сохранить"}
            </Button>
            {save.isSuccess && <span className="text-xs text-[var(--success)]">Сохранено</span>}
          </div>
        </form>
      </Card>

      <SecurityCard />

      <Card title="Интеграция с MAX">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field
            label="Режим"
            value={
              integration.data?.stub ? (
                <Badge tone="warning">заглушка (без отправки)</Badge>
              ) : (
                <Badge tone="success">рабочий</Badge>
              )
            }
          />
          <Field label="API-хост" value={integration.data?.baseUrl} mono />
          <Field
            label="Токен бота"
            value={integration.data?.hasToken ? <Badge tone="success">задан</Badge> : <Badge tone="danger">нет</Badge>}
          />
          <Field label="Бот" value={integration.data?.bot?.name ?? "—"} />
          <Field
            label="Username бота"
            value={integration.data?.botUsername ? `@${integration.data.botUsername}` : "—"}
            mono
          />
          <Field
            label="Секрет вебхука"
            value={
              integration.data?.webhookSecretSet ? (
                <Badge tone="success">задан</Badge>
              ) : (
                <Badge tone="warning">не задан</Badge>
              )
            }
          />
          <Field
            label="Приём событий"
            value={
              integration.data?.longPolling ? (
                <Badge tone="info">long polling (разработка)</Badge>
              ) : (
                <Badge tone="neutral">вебхук</Badge>
              )
            }
          />
          <Field label="Планировщик (напоминания, опоздания)" value={<SchedulerBadge at={integration.data?.scheduler?.at ?? null} />} />
        </div>

        <div className="mt-4 space-y-2 border-t border-border pt-4">
          <Field label="URL вебхука для регистрации в MAX" value={webhookUrl} mono />
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-foreground)]">
              Активные подписки
            </div>
            {integration.data?.subscriptions?.length ? (
              <ul className="mt-1 space-y-1.5 text-sm">
                {integration.data.subscriptions.map((s) => (
                  <li key={s.url} className="flex items-center justify-between gap-3 rounded-md border border-border px-2.5 py-1.5">
                    <span className="mono truncate">{s.url}</span>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={unsubscribe.isPending}
                      onClick={() => unsubscribe.mutate(s.url)}
                    >
                      <Unlink className="size-3.5" />
                      Отключить
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-sm text-[var(--muted-foreground)]">
                Подписок нет. Вебхук регистрируется после публикации панели на домене с сертификатом
                Минцифры — сертификат предоставляет заказчик.
              </p>
            )}
            {integration.data?.longPolling && !!integration.data?.subscriptions?.length && (
              <p className="mt-2 text-xs font-semibold text-[var(--warning)]">
                Пока активна подписка на вебхук, MAX не отдаёт события через long polling. Для
                локальной отладки подписку нужно отключить.
              </p>
            )}
          </div>

          <div className="space-y-2 border-t border-border pt-3">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-foreground)]">
              Подписать бота на вебхук
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <input
                aria-label="URL вебхука"
                value={hookUrl}
                onChange={(e) => setHookUrl(e.target.value)}
                placeholder="https://домен/api/webhooks/max"
                className="min-w-[280px] flex-1"
              />
              <Button
                variant="outline"
                disabled={!hookUrl.startsWith("https://") || subscribe.isPending}
                onClick={() => subscribe.mutate(hookUrl.trim())}
              >
                <Link2 className="size-4" />
                {subscribe.isPending ? "Подписываем…" : "Подписать"}
              </Button>
            </div>
            {subscribe.data?.error && (
              <p className="text-xs font-semibold text-[var(--danger)]">{subscribe.data.error}</p>
            )}
            {subscribe.data?.ok && <p className="text-xs text-[var(--success)]">Подписка создана</p>}
            {unsubscribe.data?.error && (
              <p className="text-xs font-semibold text-[var(--danger)]">{unsubscribe.data.error}</p>
            )}
            {unsubscribe.data?.ok && <p className="text-xs text-[var(--success)]">Подписка снята</p>}
          </div>

          <div className="space-y-2 border-t border-border pt-3">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-foreground)]">
              Проверка и ротация
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                disabled={check.isPending || !hookUrl.startsWith("https://")}
                onClick={() => check.mutate(hookUrl.trim())}
              >
                <Activity className="size-4" />
                {check.isPending ? "Проверяем…" : "Проверить вебхук"}
              </Button>
              <Button
                variant="outline"
                disabled={rotate.isPending}
                onClick={() => rotate.mutate()}
                title="Заменить секрет вебхука и переподписаться с новым"
              >
                <RefreshCw className="size-4" />
                {rotate.isPending ? "Меняем…" : "Сменить секрет"}
              </Button>
            </div>

            {check.data && (
              <div className="rounded-md border border-border bg-[var(--surface-2)] p-3 text-xs">
                <div className={check.data.ok ? "font-bold text-[var(--success)]" : "font-bold text-[var(--danger)]"}>
                  {check.data.ok ? "✓ Вебхук доступен" : `✗ ${check.data.error}`}
                </div>
                {check.data.status !== null && (
                  <div className="mt-1 text-[var(--muted-foreground)]">
                    HTTP {check.data.status}
                    {check.data.responseMs !== null ? ` · ${check.data.responseMs} мс` : ""}
                    {check.data.checkedFrom === "local" ? " · проверка изнутри сервера (hairpin NAT)" : ""}
                  </div>
                )}
                {check.data.cert && (
                  <div className="mt-1 text-[var(--muted-foreground)]">
                    Сертификат: {check.data.cert.issuer || "—"} · до{" "}
                    {check.data.cert.validTo || "—"}
                  </div>
                )}
                {check.data.hint && (
                  <div className="mt-1 text-[var(--muted-foreground)]">{check.data.hint}</div>
                )}
              </div>
            )}
            {check.isError && (
              <p className="text-xs font-semibold text-[var(--danger)]">{errorText(check.error)}</p>
            )}
            {rotate.data && (
              <p
                className={
                  rotate.data.ok
                    ? "text-xs text-[var(--success)]"
                    : "text-xs font-semibold text-[var(--danger)]"
                }
              >
                {rotate.data.ok
                  ? "Секрет вебхука заменён, подписка пересоздана"
                  : rotate.data.error}
              </p>
            )}
          </div>

          <div className="space-y-2 border-t border-border pt-3">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-foreground)]">
              Доставка событий за сутки
            </div>
            {stats.data ? (
              <div className="flex flex-wrap gap-4 text-xs">
                <span>
                  <span className="font-bold">{stats.data.last24h.total}</span> всего
                </span>
                <span className="text-[var(--success)]">
                  обработано <span className="font-bold">{stats.data.last24h.processed}</span>
                </span>
                <span className="text-[var(--muted-foreground)]">
                  дублей <span className="font-bold">{stats.data.last24h.duplicate}</span>
                </span>
                {stats.data.last24h.badSecret > 0 && (
                  <span className="text-[var(--danger)]">
                    неверный секрет <span className="font-bold">{stats.data.last24h.badSecret}</span>
                  </span>
                )}
                {stats.data.last24h.failed > 0 && (
                  <span className="text-[var(--danger)]">
                    ошибок <span className="font-bold">{stats.data.last24h.failed}</span>
                  </span>
                )}
                <span className="text-[var(--muted-foreground)]">
                  за 7 дней: {stats.data.last7d.total}
                </span>
              </div>
            ) : (
              <p className="text-xs text-[var(--muted-foreground)]">Собираем статистику…</p>
            )}
            {stats.data?.lastEvent && (
              <p className="text-[11px] text-[var(--muted-foreground)]">
                Последнее событие: {stats.data.lastEvent.updateType ?? "—"} ·{" "}
                {stats.data.lastEvent.outcome} · {new Date(stats.data.lastEvent.at).toLocaleString("ru-RU")}
              </p>
            )}
          </div>
          {integration.data?.error && (
            <p className="text-xs font-semibold text-[var(--danger)]">
              Ошибка обращения к MAX: {integration.data.error}
            </p>
          )}
        </div>
      </Card>
    </div>
  );
}

/** Последний проход планировщика: зелёный — работает, красный — сервер «спит». */
function SchedulerBadge({ at }: { at: string | null }) {
  if (!at) return <Badge tone="warning">ещё не запускался</Badge>;
  const min = Math.max(0, Math.round((Date.now() - new Date(at).getTime()) / 60_000));
  const time = new Date(at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  if (min <= 2) return <Badge tone="success">работает · {time}</Badge>;
  return <Badge tone="danger">пауза {min} мин · последний проход {time}</Badge>;
}
