import { Monitor, Smartphone, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { fmtDateTime } from "../lib/format";
import { Badge, Empty } from "./shell";

export type SessionItem = {
  id: number;
  kind: "web" | "miniapp";
  device: string;
  ip: string | null;
  createdAt: Date | string;
  lastSeenAt: Date | string;
  expiresAt: Date | string;
  current: boolean;
};

/** «5 мин назад» / «2 ч назад» / дата — когда сеанс последний раз обращался к панели. */
function seenAgo(value: Date | string) {
  const diff = Date.now() - new Date(value).getTime();
  const mins = Math.max(0, Math.round(diff / 60_000));
  if (mins < 2) return "сейчас";
  if (mins < 60) return `${mins} мин назад`;
  if (mins < 24 * 60) return `${Math.floor(mins / 60)} ч назад`;
  return fmtDateTime(value);
}

export function SessionList({
  items,
  onRevoke,
  pending,
}: {
  items: SessionItem[] | undefined;
  onRevoke: (id: number) => void;
  pending?: boolean;
}) {
  if (!items) return <Empty text="Загружаем…" />;
  if (!items.length) return <Empty text="Активных сеансов нет" />;
  return (
    <ul className="divide-y divide-border rounded-md border border-border">
      {items.map((s) => {
        const Icon = s.kind === "miniapp" ? Smartphone : Monitor;
        return (
          <li key={s.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
            <Icon className="size-4 shrink-0 text-[var(--muted-foreground)]" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2 text-sm font-bold">
                {s.device === "Неизвестное устройство" ? "Устройство не записано (старый сеанс)" : s.device}
                <Badge tone="neutral">{s.kind === "miniapp" ? "Mini App MAX" : "Браузер"}</Badge>
                {s.current && <Badge tone="success">этот сеанс</Badge>}
              </div>
              <div className="mono text-[11px] text-[var(--muted-foreground)]">
                {s.ip ? `IP ${s.ip} · ` : ""}вход {fmtDateTime(s.createdAt)} · активность {seenAgo(s.lastSeenAt)} · до{" "}
                {fmtDateTime(s.expiresAt)}
              </div>
            </div>
            {!s.current && (
              <Button size="sm" variant="outline" disabled={pending} onClick={() => onRevoke(s.id)}>
                <X className="size-4" />
                Завершить
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
