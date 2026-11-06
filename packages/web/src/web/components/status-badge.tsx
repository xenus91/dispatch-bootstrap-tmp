import { ALERT_LABELS, statusLabel } from "../../api/lib/route-def";
import { Badge, type BadgeTone } from "./ui/badge";

const STATUS_TONES: Record<string, BadgeTone> = {
  new: "warning",
  assigned: "primary",
  accepted: "info",
  in_progress: "info",
  done: "success",
  cancelled: "neutral",
};

export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={STATUS_TONES[status] ?? "info"}>{statusLabel(status)}</Badge>;
}

export function AlertBadge({ type }: { type: string }) {
  const tone: BadgeTone = type === "late" || type === "stop_late" ? "warning" : "danger";
  return (
    <Badge tone={tone}>
      {tone === "warning" ? "⚠" : "⛔"} {ALERT_LABELS[type] ?? type}
    </Badge>
  );
}
