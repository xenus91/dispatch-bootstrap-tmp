export const TZ = "Europe/Moscow";

export function fmtDateTime(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: TZ,
  }).format(d);
}

export function fmtTime(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: TZ,
  }).format(d);
}

/** «через 2 ч 15 мин» / «просрочено на 40 мин» */
export function fmtRelative(value: Date | string | null | undefined): string {
  if (!value) return "";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const diff = d.getTime() - Date.now();
  const mins = Math.round(Math.abs(diff) / 60_000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const body = h > 0 ? `${h} ч${m ? ` ${m} мин` : ""}` : `${m} мин`;
  return diff >= 0 ? `через ${body}` : `просрочено на ${body}`;
}

/** Значение для <input type="datetime-local"> из Date/ISO. */
export function toLocalInput(value: Date | string | null | undefined): string {
  if (!value) return "";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function minutesLabel(minutes: number | null | undefined): string {
  if (!minutes) return "по умолчанию";
  if (minutes % 60 === 0) return `${minutes / 60} ч`;
  return `${minutes} мин`;
}
