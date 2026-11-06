import { useState } from "react";
import { Link } from "wouter";
import { Archive, ArchiveRestore, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Card, Empty } from "../../components/shell";
import { ErrorLine } from "../../components/form";
import { errorText } from "../../lib/api";
import { useMe } from "../../queries/auth";

export const DICT_TABS = [
  { key: "clients", label: "Клиенты" },
  { key: "points", label: "Пункты" },
  { key: "request-types", label: "Типы заявок" },
  { key: "operations", label: "Операции" },
  { key: "containers", label: "Контейнеры" },
] as const;
export type DictTab = (typeof DICT_TABS)[number]["key"];

export function useIsAdmin() {
  return useMe().data?.role === "admin";
}

export function DictTabs({ active }: { active: DictTab }) {
  return (
    <div className="-mx-4 overflow-x-auto px-4 md:mx-0 md:px-0">
      <div className="flex w-max gap-1 rounded-lg border border-border bg-[var(--surface)] p-1">
        {DICT_TABS.map((t) => (
          <Link
            key={t.key}
            href={`/dict/${t.key}`}
            className={cn(
              "whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-semibold transition-colors",
              t.key === active
                ? "bg-[var(--primary)] text-[var(--primary-foreground)]"
                : "text-[var(--muted-foreground)] hover:text-foreground",
            )}
          >
            {t.label}
          </Link>
        ))}
      </div>
    </div>
  );
}

/** Каркас списка справочника: заголовок, кнопка «Добавить», переключатель архива. */
export function DictList<T extends { id: number; archived: boolean }>({
  title,
  hint,
  items,
  loading,
  canEdit,
  onAdd,
  onOpen,
  renderRow,
  emptyText,
}: {
  title: string;
  hint?: React.ReactNode;
  items: T[] | undefined;
  loading: boolean;
  canEdit: boolean;
  onAdd: () => void;
  onOpen: (item: T) => void;
  renderRow: (item: T) => React.ReactNode;
  emptyText: string;
}) {
  const [showArchived, setShowArchived] = useState(false);
  const list = (items ?? []).filter((i) => showArchived || !i.archived);
  const archivedCount = (items ?? []).filter((i) => i.archived).length;

  return (
    <Card
      title={title}
      action={
        canEdit && (
          <Button size="sm" onClick={onAdd}>
            <Plus /> Добавить
          </Button>
        )
      }
    >
      {hint && <p className="mb-3 text-xs text-[var(--muted-foreground)]">{hint}</p>}
      {loading ? (
        <div className="py-6 text-center text-sm text-[var(--muted-foreground)]">Загрузка…</div>
      ) : list.length === 0 ? (
        <Empty text={emptyText} />
      ) : (
        <ul className="-mx-4 divide-y divide-border border-y border-border">
          {list.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => onOpen(item)}
                className={cn(
                  "flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-[var(--muted)]/60",
                  item.archived && "opacity-55",
                )}
              >
                {renderRow(item)}
              </button>
            </li>
          ))}
        </ul>
      )}
      {archivedCount > 0 && (
        <button
          type="button"
          onClick={() => setShowArchived((v) => !v)}
          className="mt-3 text-xs font-semibold text-[var(--muted-foreground)] hover:text-foreground"
        >
          {showArchived ? "Скрыть архив" : `Показать архив (${archivedCount})`}
        </button>
      )}
    </Card>
  );
}

type Mut<I> = { mutateAsync: (i: I) => Promise<unknown>; isPending: boolean; error: unknown };

/** Подвал окна редактирования: удалить / в архив / сохранить. */
export function EditFooter({
  editing,
  archived,
  canEdit,
  saving,
  onSave,
  onClose,
  archive,
  remove,
  id,
}: {
  editing: boolean;
  archived?: boolean;
  canEdit: boolean;
  saving: boolean;
  onSave: () => void;
  onClose: () => void;
  archive: Mut<{ id: number; archived: boolean }>;
  remove: Mut<{ id: number }>;
  id?: number;
}) {
  const [err, setErr] = useState("");
  const run = async (fn: () => Promise<unknown>) => {
    setErr("");
    try {
      await fn();
      onClose();
    } catch (e) {
      setErr(errorText(e));
    }
  };
  if (!canEdit) {
    return (
      <Button variant="outline" onClick={onClose}>
        Закрыть
      </Button>
    );
  }
  return (
    <>
      {err && <ErrorLine error={err} />}
      {editing && id && (
        <div className="mr-auto flex gap-1">
          <Button
            variant="ghost"
            size="sm"
            disabled={archive.isPending}
            onClick={() => run(() => archive.mutateAsync({ id, archived: !archived }))}
          >
            {archived ? <ArchiveRestore /> : <Archive />}
            {archived ? "Вернуть" : "В архив"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-[var(--danger)]"
            disabled={remove.isPending}
            onClick={() => {
              if (confirm("Удалить запись? Если она уже используется, удаление не пройдёт — отправьте её в архив.")) {
                void run(() => remove.mutateAsync({ id }));
              }
            }}
          >
            <Trash2 /> Удалить
          </Button>
        </div>
      )}
      <Button variant="outline" onClick={onClose}>
        Отмена
      </Button>
      <Button onClick={onSave} disabled={saving}>
        {saving ? "Сохранение…" : "Сохранить"}
      </Button>
    </>
  );
}

export const nul = (v: string) => (v.trim() ? v.trim() : null);
