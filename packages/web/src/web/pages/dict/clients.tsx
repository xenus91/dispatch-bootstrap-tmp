import { useState } from "react";
import { Sheet, TextAreaField, TextField } from "../../components/form";
import { errorText } from "../../lib/api";
import { useArchiveClient, useClients, useCreateClient, useRemoveClient, useUpdateClient } from "../../queries/clients";
import { DictList, EditFooter, nul } from "./shared";

type Client = NonNullable<ReturnType<typeof useClients>["data"]>[number];

const fromClient = (c?: Client | null) => ({
  name: c?.name ?? "",
  inn: c?.inn ?? "",
  address: c?.address ?? "",
  contactName: c?.contactName ?? "",
  phone: c?.phone ?? "",
  email: c?.email ?? "",
  comment: c?.comment ?? "",
});

/** Окно создания/редактирования клиента. Используется и в форме заявки. */
export function ClientSheet({
  client,
  onClose,
  onSaved,
}: {
  client?: Client | null;
  onClose: () => void;
  onSaved?: (id: number) => void;
}) {
  const [f, setF] = useState(() => fromClient(client));
  const [err, setErr] = useState("");
  const create = useCreateClient();
  const update = useUpdateClient();
  const archive = useArchiveClient();
  const remove = useRemoveClient();
  const set = (k: keyof typeof f) => (v: string) => setF((p) => ({ ...p, [k]: v }));

  const save = async () => {
    setErr("");
    if (!f.name.trim()) return setErr("Укажите название клиента");
    const input = {
      name: f.name.trim(),
      inn: nul(f.inn),
      address: nul(f.address),
      contactName: nul(f.contactName),
      phone: nul(f.phone),
      email: nul(f.email),
      comment: nul(f.comment),
    };
    try {
      const row = client ? await update.mutateAsync({ ...input, id: client.id }) : await create.mutateAsync(input);
      onSaved?.((row as { id: number }).id);
      onClose();
    } catch (e) {
      setErr(errorText(e));
    }
  };

  return (
    <Sheet
      title={client ? client.name : "Новый клиент"}
      onClose={onClose}
      footer={
        <EditFooter
          editing={!!client}
          id={client?.id}
          archived={client?.archived}
          canEdit
          saving={create.isPending || update.isPending}
          onSave={save}
          onClose={onClose}
          archive={archive}
          remove={remove}
        />
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField label="Название" required value={f.name} onChange={set("name")} className="sm:col-span-2" placeholder="ООО «Ромашка»" />
        <TextField label="ИНН" value={f.inn} onChange={set("inn")} mono inputMode="numeric" />
        <TextField label="Телефон" value={f.phone} onChange={set("phone")} mono type="tel" />
        <TextField label="Контактное лицо" value={f.contactName} onChange={set("contactName")} />
        <TextField label="E-mail" value={f.email} onChange={set("email")} type="email" />
        <TextField label="Адрес" value={f.address} onChange={set("address")} className="sm:col-span-2" />
        <TextAreaField label="Комментарий" value={f.comment} onChange={set("comment")} className="sm:col-span-2" rows={2} />
      </div>
      {err && <div className="mt-3 text-xs text-[var(--danger)]">{err}</div>}
    </Sheet>
  );
}

export default function ClientsDict() {
  const q = useClients({ includeArchived: true });
  const [open, setOpen] = useState<Client | "new" | null>(null);

  return (
    <>
      <DictList
        title="Клиенты"
        hint="Заказчики перевозок. Склады клиента заводятся в «Пунктах» с привязкой к клиенту."
        items={q.data}
        loading={q.isLoading}
        canEdit
        onAdd={() => setOpen("new")}
        onOpen={setOpen}
        emptyText="Клиентов пока нет"
        renderRow={(c) => (
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold">{c.name}</div>
            <div className="truncate text-xs text-[var(--muted-foreground)]">
              {[c.inn && `ИНН ${c.inn}`, c.contactName, c.phone].filter(Boolean).join(" · ") || "—"}
            </div>
          </div>
        )}
      />
      {open && <ClientSheet client={open === "new" ? null : open} onClose={() => setOpen(null)} />}
    </>
  );
}
