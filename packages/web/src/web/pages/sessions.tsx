import { useState } from "react";
import { LogOut, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "../components/shell";
import { SessionList } from "../components/session-list";
import { errorText } from "../lib/api";
import { useLogout } from "../queries/auth";
import { useMySessions, useRevokeOtherSessions, useRevokeSession } from "../queries/sessions";

/** Личный список входов: где открыта панель и кнопка «выйти на остальных устройствах». */
export default function SessionsPage() {
  const list = useMySessions();
  const revoke = useRevokeSession();
  const revokeOthers = useRevokeOtherSessions();
  const logout = useLogout();
  const others = (list.data ?? []).filter((s) => !s.current).length;
  const error = revoke.error ?? revokeOthers.error;
  // Явный ответ на каждое действие: в Mini App одинаковые строки списка не дают понять, что что-то произошло.
  const [notice, setNotice] = useState<string | null>(null);

  function revokeOne(id: number) {
    const item = list.data?.find((s) => s.id === id);
    setNotice(null);
    revoke.mutate(
      { id },
      { onSuccess: () => setNotice(`Сеанс «${item?.device ?? id}» завершён — на том устройстве потребуется новый вход.`) },
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div>
        <h1 className="text-xl font-extrabold tracking-tight">Мои сеансы</h1>
        <p className="text-xs text-[var(--muted-foreground)]">
          Устройства, на которых открыта панель. Если видите незнакомое — завершите его. При входе с
          нового браузера бот пришлёт сообщение с кнопкой «Это не я».
        </p>
      </div>

      <Card title={`Активные сеансы${list.data ? ` · ${list.data.length}` : ""}`}>
        <SessionList items={list.data} pending={revoke.isPending} onRevoke={revokeOne} />
        {!!error && <p className="mt-3 text-xs font-semibold text-[var(--danger)]">{errorText(error)}</p>}
        {notice && <p className="mt-3 text-xs font-semibold text-[var(--success)]">{notice}</p>}

        <div className="mt-4 grid gap-2 border-t border-border pt-4 sm:grid-cols-2">
          <Button
            variant="destructive"
            disabled={!others || revokeOthers.isPending}
            onClick={() => {
              setNotice(null);
              revokeOthers.mutate(undefined, {
                onSuccess: (res) => setNotice(`Готово: завершено сеансов — ${res.removed}. Остался только этот.`),
              });
            }}
          >
            <LogOut className="size-4" />
            {revokeOthers.isPending
              ? "Завершаем…"
              : others
                ? `Выйти на других устройствах (${others})`
                : "Других сеансов нет"}
          </Button>
          <Button variant="outline" disabled={logout.isPending} onClick={() => logout.mutate()}>
            <LogOut className="size-4" />
            Выйти на этом устройстве
          </Button>
        </div>
      </Card>

      <div className="flex items-start gap-2 rounded-md border border-border bg-[var(--surface-2)] px-4 py-3 text-xs text-[var(--muted-foreground)]">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-[var(--success)]" />
        <span>
          Сеанс в браузере действует ограниченное время, в мини-приложении MAX — дольше; сроки задаёт
          администратор. Коды входа приходят только в ваш личный чат с ботом — никому их не сообщайте.
        </span>
      </div>
    </div>
  );
}
