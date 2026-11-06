/** Общий домен: роли, доступ, настройки. Только константы — файл импортируется и фронтендом. */

/* Статусы заявок, подписи и тревоги — в ./route-def. */
export { ALERT_LABELS } from "./route-def";

export const ROLE_LABELS: Record<string, string> = {
  admin: "Администратор",
  dispatcher: "Диспетчер",
  driver: "Водитель",
};

export const STAFF_STATUS_LABELS: Record<string, string> = {
  pending: "Не подтверждён",
  awaiting_approval: "Ждёт допуска",
  active: "Активен",
  blocked: "Заблокирован",
};

export const BLOCK_REASON_LABELS: Record<string, string> = {
  manual: "вручную",
  inactive: "неактивен",
  expired: "истёк срок доступа",
  erased: "персональные данные удалены",
};

export const ACCESS_EVENT_LABELS: Record<string, string> = {
  invite_ok: "Инвайт принят",
  invite_invalid: "Недействительный инвайт",
  invite_expired: "Инвайт истёк",
  phone_mismatch: "Телефон не совпал",
  stranger: "Обращение постороннего",
  blocked_attempt: "Попытка заблокированного",
  otp_sent: "Код входа отправлен",
  otp_failed: "Неверный код входа",
  login_ok: "Вход в панель",
  name_rejected: "ФИО не подтверждено",
  activated: "Сотрудник активирован",
  revoked: "Доступ отозван",
  approval_requested: "Запрошен допуск",
  approved: "Допущен администратором",
  rejected: "Допуск отклонён",
  login_locked: "Вход заблокирован (перебор кода)",
  login_unlocked: "Блокировка входа снята",
  otp_throttled: "Слишком частый запрос кода",
  new_device: "Вход с нового устройства",
  sessions_revoked: "Сеансы завершены",
  suspended: "Доступ приостановлен автоматически",
  access_denied: "Доступ запрещён",
  miniapp_unknown: "Неизвестный аккаунт MAX",
  miniapp_invalid: "Неверная подпись Mini App",
  contact_invalid: "Неверная подпись контакта",
  consent_given: "Согласие на обработку ПДн дано",
  consent_rejected: "Отказ от обработки ПДн",
};

/** Пресеты срока действия инвайта (решение заказчика — выбор из списка, не хардкод). */
export const INVITE_TTL_PRESETS = [
  { hours: 1, label: "1 час" },
  { hours: 24, label: "24 часа" },
  { hours: 72, label: "72 часа" },
  { hours: 168, label: "7 дней" },
] as const;

/**
 * Версия текста согласия на обработку персональных данных (ст. 9 152-ФЗ).
 *
 * Хранится вместе с согласием субъекта: если текст поменяется, версия
 * изменится, и в карточке будет видно, под какую редакцию человек давал
 * согласие. Меняем версию при любой правке формулировок.
 */
export const CONSENT_VERSION = "2026-11-04";

export const SETTINGS_DEFAULTS = {
  /** За сколько минут до планового прибытия на остановку напомнить водителю */
  reminderMinutes: "60",
  /** Через сколько минут после планового прибытия без отметки — тревога «Опаздывает на остановку» */
  stopLateMinutes: "30",
  /** Через сколько минут неподтверждённая тревога считается просроченной */
  alertEscalateMinutes: "15",
  /** Часовой пояс для отображения времени */
  timezone: "Europe/Moscow",
  /** Показывать OTP-код в панели (только в режиме заглушки) */
  companyName: "Контейнерные перевозки",
  /** Новый сотрудник получает доступ только после кнопки администратора «Допустить» */
  requireApproval: "1",
  /** Срок сессии панели в браузере, часов */
  webSessionHours: "12",
  /** Срок сессии в мини-приложении MAX, дней */
  miniAppSessionDays: "30",
  /** Приостановить доступ, если сотрудник не появлялся N дней (0 — выключено) */
  inactivityDays: "30",
} as const;

export function normalizePhone(raw: string): string {
  const digits = (raw ?? "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  if (digits.length === 10) return `7${digits}`;
  return digits;
}

export function formatPhone(phone: string | null | undefined): string {
  if (!phone) return "—";
  const d = phone.replace(/\D/g, "");
  if (d.length === 11) {
    return `+${d[0]} ${d.slice(1, 4)} ${d.slice(4, 7)}-${d.slice(7, 9)}-${d.slice(9)}`;
  }
  return `+${d}`;
}

/**
 * Может ли сотрудник исполнять заявки в боте. Обычно это водитель; администратор —
 * только для тестового рейса, назначенного на самого себя.
 */
export const canExecute = (role: string) => role === "driver" || role === "admin";
