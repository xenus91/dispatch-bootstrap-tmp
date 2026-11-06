import { useEffect, useMemo, useState } from "react";
import { BellOff, Lock, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Card } from "../components/shell";
import { Toggle } from "../components/ui/toggle";
import { errorText } from "../lib/api";
import { useNotifications, useSaveNotifications } from "../queries/notifications";
import type { NotifyEventGroup, NotifyPrefs } from "../../api/lib/route-def";

const GROUP_ORDER: NotifyEventGroup[] = ["alert", "request", "route", "driver", "system"];

export default function NotificationsPage() {
  const q = useNotifications();
  const save = useSaveNotifications();
  const [prefs, setPrefs] = useState<NotifyPrefs | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (q.data && !dirty) setPrefs(q.data.prefs);
  }, [q.data, dirty]);

  const grouped = useMemo(() => {
    const events = q.data?.events ?? [];
    return GROUP_ORDER.map((g) => ({ group: g, items: events.filter((e) => e.group === g) })).filter(
      (g) => g.items.length,
    );
  }, [q.data]);

  if (!q.data || !prefs) {
    return <div className="text-sm text-[var(--muted-foreground)]">Загрузка…</div>;
  }

  const update = (patch: Partial<NotifyPrefs>) => {
    setPrefs({ ...prefs, ...patch });
    setDirty(true);
  };
  const isOn = (key: string, defaultOn: boolean) => (key in prefs.events ? !!prefs.events[key] : defaultOn);
  const enabledCount = q.data.events.filter((e) => e.locked || (!prefs.muted && isOn(e.key, e.defaultOn))).length;

  return (
    <div className="mx-auto max-w-3xl space-y-5 pb-24">
      <div>
        <h1 className="text-xl font-extrabold tracking-tight">Мои уведомления</h1>
        <p className="text-xs text-[var(--muted-foreground)]">
          Что бот присылает лично вам в MAX. Все события в любом случае видны в панели — в карточке заявки и истории.
        </p>
      </div>

      {!q.data.inBot && (
        <div className="rounded-lg border border-[var(--warning)] bg-[color-mix(in_srgb,var(--warning)_12%,transparent)] px-4 py-3 text-sm">
          Вы ещё не активированы в боте MAX — уведомления начнут приходить после активации.
        </div>
      )}

      <Card title="Общие">
        <div className="space-y-4">
          <div className="flex items-start gap-3">
            <Toggle label="Тихий режим" checked={prefs.muted} onChange={(v) => update({ muted: v })} />
            <span>
              <span className="flex items-center gap-1.5 text-sm font-bold">
                <BellOff className="size-4" /> Тихий режим
              </span>
              <span className="block text-xs text-[var(--muted-foreground)]">
                Выключить все сообщения, кроме тревог «Возможно опоздание» и «Срыв заявки».
              </span>
            </span>
          </div>

          <div>
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-foreground)]">
              По каким заявкам
            </div>
            <div className="inline-flex rounded-md border border-border p-0.5">
              {(
                [
                  ["all", "Все заявки"],
                  ["mine", "Только созданные мной"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => update({ scope: value })}
                  className={cn(
                    "rounded px-3 py-1.5 text-sm font-semibold",
                    prefs.scope === value
                      ? "bg-[var(--primary)] text-[var(--primary-foreground)]"
                      : "text-[var(--muted-foreground)]",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </Card>

      {grouped.map(({ group, items }) => (
        <Card key={group} title={q.data.groups[group]}>
          <ul className="divide-y divide-border">
            {items.map((e, idx) => {
              const sub = e.subgroup && e.subgroup !== items[idx - 1]?.subgroup ? e.subgroup : null;
              const on = e.locked ? true : !prefs.muted && isOn(e.key, e.defaultOn);
              return (
                <li key={e.key} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
                  <div className="min-w-0 flex-1">
                    {sub && (
                      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-foreground)]">
                        {sub}
                      </div>
                    )}
                    <div className="text-sm font-semibold">{e.label}</div>
                    {e.locked && (
                      <div className="flex items-center gap-1 text-[11px] text-[var(--muted-foreground)]">
                        <Lock className="size-3" /> Критичное — приходит всегда
                      </div>
                    )}
                    {!e.locked && !(e.key in prefs.events) && (
                      <div className="text-[11px] text-[var(--muted-foreground)]">
                        по умолчанию {e.defaultOn ? "включено" : "выключено"}
                      </div>
                    )}
                  </div>
                  <Toggle
                    label={e.label}
                    checked={on}
                    disabled={e.locked || prefs.muted}
                    onChange={(v) => update({ events: { ...prefs.events, [e.key]: v } })}
                  />
                </li>
              );
            })}
          </ul>
        </Card>
      ))}

      <div className="fixed inset-x-0 bottom-0 z-10 border-t border-border bg-[var(--surface)]/95 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-3">
          <span className="text-xs text-[var(--muted-foreground)]">
            Включено событий: <b className="mono text-foreground">{enabledCount}</b> из {q.data.events.length}
          </span>
          {save.isError && <span className="text-xs text-[var(--danger)]">{errorText(save.error)}</span>}
          {save.isSuccess && !dirty && <span className="text-xs text-[var(--success)]">Сохранено</span>}
          <Button
            className="ml-auto"
            disabled={!dirty || save.isPending}
            onClick={() =>
              save.mutate(prefs, {
                onSuccess: () => setDirty(false),
              })
            }
          >
            <Save className="size-4" />
            {save.isPending ? "Сохраняем…" : "Сохранить"}
          </Button>
        </div>
      </div>
    </div>
  );
}
