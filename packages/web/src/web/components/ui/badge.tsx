import { cn } from "@/lib/utils";

const TONES = {
  neutral: "bg-[var(--surface-2)] text-[var(--muted-foreground)] border-border",
  primary: "bg-[color-mix(in_srgb,var(--primary)_16%,transparent)] text-[var(--primary)] border-[color-mix(in_srgb,var(--primary)_35%,transparent)]",
  info: "bg-[color-mix(in_srgb,var(--info)_14%,transparent)] text-[var(--info)] border-[color-mix(in_srgb,var(--info)_32%,transparent)]",
  success:
    "bg-[color-mix(in_srgb,var(--success)_14%,transparent)] text-[var(--success)] border-[color-mix(in_srgb,var(--success)_32%,transparent)]",
  warning:
    "bg-[color-mix(in_srgb,var(--warning)_14%,transparent)] text-[var(--warning)] border-[color-mix(in_srgb,var(--warning)_32%,transparent)]",
  danger:
    "bg-[color-mix(in_srgb,var(--danger)_14%,transparent)] text-[var(--danger)] border-[color-mix(in_srgb,var(--danger)_34%,transparent)]",
} as const;

export type BadgeTone = keyof typeof TONES;

export function Badge({
  children,
  tone = "neutral",
  className,
}: {
  children: React.ReactNode;
  tone?: BadgeTone;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold leading-5 tracking-wide",
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
