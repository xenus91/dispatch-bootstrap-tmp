import { cn } from "@/lib/utils";

export function Toggle({
  checked,
  onChange,
  disabled,
  label,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative h-6 w-11 shrink-0 rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-60",
        checked
          ? "border-[var(--primary)] bg-[var(--primary)]"
          : "border-border bg-[var(--surface-2)]",
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 size-[18px] rounded-full bg-white shadow transition-all",
          checked ? "left-[22px]" : "left-0.5",
        )}
      />
    </button>
  );
}
