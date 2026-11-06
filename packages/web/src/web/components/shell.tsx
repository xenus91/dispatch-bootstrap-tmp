import { Link, useLocation } from "wouter";
import { ScrollText, AlertTriangle, Bell, LogOut, Package, Settings, ShieldCheck, Users, BookOpen } from "lucide-react";
import { cn } from "@/lib/utils";
import { useLogout, useMe } from "../queries/auth";
import { useOpenAlerts, useStats } from "../queries/requests";
import { useSettings } from "../queries/settings";
import { ROLE_LABELS } from "../../api/lib/domain";
import { Badge } from "./ui/badge";

type Me = NonNullable<ReturnType<typeof useMe>["data"]>;

function NavLink({
  href,
  icon,
  label,
  active,
  badge,
}: {
  href: string;
  icon: React.ReactNode;
  label: string;
  active: boolean;
  badge?: number;
}) {
  return (
    <Link
      href={href}
      className={cn(
        "flex items-center gap-2 rounded-md px-3 py-2 text-sm font-semibold transition-colors",
        active
          ? "bg-[color-mix(in_srgb,var(--primary)_16%,transparent)] text-[var(--primary)]"
          : "text-[var(--muted-foreground)] hover:bg-[var(--surface-2)] hover:text-foreground",
      )}
    >
      {icon}
      <span>{label}</span>
      {!!badge && (
        <span className="mono ml-auto rounded-full bg-[var(--danger)] px-1.5 text-[11px] font-bold text-white">
          {badge}
        </span>
      )}
    </Link>
  );
}

function NavLinks({ path, isAdmin, mobile }: { path: string; isAdmin: boolean; mobile?: boolean }) {
  return (
    <>
      <NavLink
        href="/"
        active={path === "/" || path.startsWith("/requests")}
        icon={<Package className="size-4" />}
        label="Заявки"
      />
      {isAdmin && (
        <NavLink
          href="/staff"
          active={path.startsWith("/staff")}
          icon={<Users className="size-4" />}
          label="Сотрудники"
        />
      )}
      {isAdmin && (
        <NavLink
          href="/audit"
          active={path.startsWith("/audit")}
          icon={<ScrollText className="size-4" />}
          label="Журнал действий"
        />
      )}
      <NavLink
        href="/dict/clients"
        active={path.startsWith("/dict")}
        icon={<BookOpen className="size-4" />}
        label="Справочники"
      />
      <NavLink
        href="/notifications"
        active={path.startsWith("/notifications")}
        icon={<Bell className="size-4" />}
        label="Уведомления"
      />
      {isAdmin && (
        <NavLink
          href="/settings"
          active={path.startsWith("/settings")}
          icon={<Settings className="size-4" />}
          label="Настройки"
        />
      )}
      {/* На телефоне и в Mini App имя в шапке скрыто — даём явный пункт «Сеансы». */}
      {mobile && (
        <NavLink
          href="/sessions"
          active={path.startsWith("/sessions")}
          icon={<ShieldCheck className="size-4" />}
          label="Сеансы"
        />
      )}
    </>
  );
}

export function Shell({ me, children }: { me: Me; children: React.ReactNode }) {
  const [path] = useLocation();
  const logout = useLogout();
  const alerts = useOpenAlerts();
  const stats = useStats();
  const settings = useSettings();
  const isAdmin = me.role === "admin";
  const alertCount = alerts.data?.length ?? 0;

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-20 border-b border-border bg-[var(--surface)]/95 backdrop-blur">
        <div className="mx-auto flex max-w-[1400px] items-center gap-3 px-4 py-3">
          <Link href="/" className="flex items-center gap-2">
            <span className="grid size-8 place-items-center rounded-md bg-[var(--primary)] text-sm font-extrabold text-[var(--primary-foreground)]">
              MD
            </span>
            <span className="hidden flex-col leading-tight sm:flex">
              <span className="text-sm font-extrabold tracking-tight">Диспетчерская</span>
              <span className="text-[11px] text-[var(--muted-foreground)]">
                {settings.data?.companyName ?? "Контейнерные перевозки"}
              </span>
            </span>
          </Link>

          <nav className="ml-2 hidden items-center gap-1 md:flex">
            <NavLinks path={path} isAdmin={isAdmin} />
          </nav>

          <div className="ml-auto flex items-center gap-3">
            {alertCount > 0 && (
              <Link href="/" className="flex items-center gap-1.5 text-[var(--danger)]">
                <AlertTriangle className="size-4" />
                <span className="mono text-sm font-bold">{alertCount}</span>
              </Link>
            )}
            {stats.data && (
              <span className="mono hidden whitespace-nowrap text-xs text-[var(--muted-foreground)] xl:inline">
                в работе {stats.data.active} · без водителя {stats.data.unassigned}
              </span>
            )}
            <Link
              href="/sessions"
              title="Мои сеансы и устройства"
              className={cn(
                "flex items-center gap-2 rounded-md px-2 py-1 text-right hover:bg-[var(--surface-2)]",
                path === "/sessions" && "bg-[var(--surface-2)]",
              )}
            >
              <div className="hidden sm:block">
                <div className="text-xs font-bold leading-tight">{me.fullName}</div>
                <div className="text-[11px] text-[var(--muted-foreground)]">
                  {ROLE_LABELS[me.role] ?? me.role}
                </div>
              </div>
              <ShieldCheck className="size-4 text-[var(--muted-foreground)]" />
            </Link>
            <button
              type="button"
              onClick={() => logout.mutate()}
              disabled={logout.isPending}
              title="Выйти"
              aria-label="Выйти"
              className="grid size-8 place-items-center rounded-md border border-border text-[var(--muted-foreground)] hover:text-[var(--danger)]"
            >
              <LogOut className="size-4" />
            </button>
          </div>
        </div>

        <nav className="flex gap-1 overflow-x-auto border-t border-border px-4 py-2 md:hidden">
          <NavLinks path={path} isAdmin={isAdmin} mobile />
        </nav>
      </header>

      <main className="mx-auto max-w-[1400px] px-4 py-5">{children}</main>
    </div>
  );
}

export function Card({
  title,
  action,
  children,
  className,
}: {
  title?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("rounded-lg border border-border bg-[var(--surface)]", className)}>
      {(title || action) && (
        <header className="flex items-center gap-2 border-b border-border px-4 py-3">
          <h2 className="text-sm font-extrabold tracking-tight">{title}</h2>
          <div className="ml-auto">{action}</div>
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Field({
  label,
  value,
  mono,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-foreground)]">
        {label}
      </div>
      <div className={cn("break-words text-sm", mono && "mono")}>{value || "—"}</div>
    </div>
  );
}

export function Empty({ text }: { text: string }) {
  return (
    <div className="rounded-lg border border-dashed border-border px-4 py-10 text-center text-sm text-[var(--muted-foreground)]">
      {text}
    </div>
  );
}

export { Badge };
