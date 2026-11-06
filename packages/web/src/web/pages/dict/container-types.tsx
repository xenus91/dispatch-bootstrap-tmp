import { useState } from "react";
import { Sheet, TextField } from "../../components/form";
import { errorText } from "../../lib/api";
import {
  useArchiveContainerType,
  useContainerTypes,
  useCreateContainerType,
  useRemoveContainerType,
  useUpdateContainerType,
} from "../../queries/container-types";
import { DictList, EditFooter, nul, useIsAdmin } from "./shared";

type Row = NonNullable<ReturnType<typeof useContainerTypes>["data"]>[number];

function ContainerSheet({ row, onClose, canEdit, nextSort }: { row: Row | null; onClose: () => void; canEdit: boolean; nextSort: number }) {
  const [code, setCode] = useState(row?.code ?? "");
  const [name, setName] = useState(row?.name ?? "");
  const [sort, setSort] = useState(String(row?.sort ?? nextSort));
  const [err, setErr] = useState("");
  const create = useCreateContainerType();
  const update = useUpdateContainerType();
  const archive = useArchiveContainerType();
  const remove = useRemoveContainerType();

  const save = async () => {
    setErr("");
    const input = { code: code.trim(), name: nul(name), sort: Number(sort) || 0 };
    try {
      if (row) await update.mutateAsync({ ...input, id: row.id });
      else await create.mutateAsync(input);
      onClose();
    } catch (e) {
      setErr(errorText(e));
    }
  };

  return (
    <Sheet
      title={row ? row.code : "Новый тип контейнера"}
      onClose={onClose}
      footer={
        <EditFooter
          editing={!!row}
          id={row?.id}
          archived={row?.archived}
          canEdit={canEdit}
          saving={create.isPending || update.isPending}
          onSave={save}
          onClose={onClose}
          archive={archive}
          remove={remove}
        />
      }
    >
      <div className="grid grid-cols-2 gap-4">
        <TextField label="Код" required mono value={code} onChange={(v) => setCode(v.toUpperCase())} placeholder="40HC" />
        <TextField label="Порядок" mono value={sort} onChange={setSort} inputMode="numeric" />
        <TextField label="Описание" value={name} onChange={setName} className="col-span-2" placeholder="40' High Cube" />
      </div>
      {err && <div className="mt-3 text-xs text-[var(--danger)]">{err}</div>}
    </Sheet>
  );
}

export default function ContainerTypesDict() {
  const isAdmin = useIsAdmin();
  const q = useContainerTypes({ includeArchived: true });
  const [open, setOpen] = useState<Row | "new" | null>(null);
  const nextSort = Math.max(0, ...(q.data ?? []).map((r) => r.sort + 1));

  return (
    <>
      <DictList
        title="Типы контейнеров"
        hint={isAdmin ? undefined : "Изменять справочник может только администратор."}
        items={q.data}
        loading={q.isLoading}
        canEdit={isAdmin}
        onAdd={() => setOpen("new")}
        onOpen={setOpen}
        emptyText="Типов пока нет"
        renderRow={(r) => (
          <>
            <span className="mono w-16 shrink-0 text-sm font-bold">{r.code}</span>
            <span className="min-w-0 flex-1 truncate text-sm text-[var(--muted-foreground)]">{r.name || "—"}</span>
          </>
        )}
      />
      {open && <ContainerSheet row={open === "new" ? null : open} onClose={() => setOpen(null)} canEdit={isAdmin} nextSort={nextSort} />}
    </>
  );
}
