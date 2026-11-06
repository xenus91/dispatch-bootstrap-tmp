import { useEffect } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

export function Labeled({
  label,
  required,
  hint,
  className,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <label className={cn("block min-w-0", className)}>
      <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-foreground)]">
        {label}
        {required && <span className="text-[var(--danger)]"> *</span>}
      </span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-[var(--muted-foreground)]">{hint}</span>}
    </label>
  );
}

export function TextField({
  label,
  value,
  onChange,
  placeholder,
  mono,
  required,
  type = "text",
  hint,
  className,
  inputMode,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
  required?: boolean;
  type?: string;
  hint?: React.ReactNode;
  className?: string;
  inputMode?: React.HTMLAttributes<HTMLInputElement>["inputMode"];
}) {
  return (
    <Labeled label={label} required={required} hint={hint} className={className}>
      <input
        aria-label={label}
        type={type}
        value={value}
        placeholder={placeholder}
        inputMode={inputMode}
        onChange={(e) => onChange(e.target.value)}
        className={cn("w-full", mono && "mono")}
      />
    </Labeled>
  );
}

export function SelectField({
  label,
  value,
  onChange,
  options,
  placeholder,
  required,
  hint,
  className,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string | number; label: string }[];
  placeholder?: string;
  required?: boolean;
  hint?: React.ReactNode;
  className?: string;
}) {
  return (
    <Labeled label={label} required={required} hint={hint} className={className}>
      <select value={value} onChange={(e) => onChange(e.target.value)} className="w-full">
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Labeled>
  );
}

export function TextAreaField({
  label,
  value,
  onChange,
  placeholder,
  rows = 3,
  className,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
  className?: string;
}) {
  return (
    <Labeled label={label} className={className}>
      <textarea
        aria-label={label}
        value={value}
        rows={rows}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="w-full"
      />
    </Labeled>
  );
}

/** Модальное окно: снизу на телефоне, по центру на десктопе. */
export function Sheet({
  title,
  onClose,
  footer,
  children,
  wide,
}: {
  title: React.ReactNode;
  onClose: () => void;
  footer?: React.ReactNode;
  children: React.ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center md:items-center md:p-6">
      {/* Затемнение — кнопка: клик по нему закрывает окно. */}
      <button
        type="button"
        aria-label="Закрыть окно"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-black/40"
      />
      <dialog
        open
        aria-modal="true"
        className={cn(
          "relative z-10 m-0 flex max-h-[92dvh] w-full max-w-none flex-col rounded-t-xl border border-border bg-[var(--surface)] p-0 shadow-xl md:rounded-xl",
          wide ? "md:max-w-3xl" : "md:max-w-lg",
        )}
      >
        <header className="flex items-center gap-2 border-b border-border px-4 py-3">
          <h2 className="min-w-0 flex-1 truncate text-sm font-extrabold tracking-tight">{title}</h2>
          <button type="button" onClick={onClose} className="rounded p-1 text-[var(--muted-foreground)] hover:bg-[var(--muted)]" aria-label="Закрыть">
            <X className="size-4" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
        {footer && <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-4 py-3">{footer}</footer>}
      </dialog>
    </div>
  );
}

export function ErrorLine({ error }: { error: React.ReactNode }) {
  if (!error) return null;
  return <div className="text-xs text-[var(--danger)]">{error}</div>;
}
