import { formatPhone } from "../lib/domain";
import type { RequestContext, StopView } from "../lib/route";
import {
  ALERT_LABELS,
  type ExtraAction,
  isClosedStatus,
  isRunning,
  mapUrl,
  nextAction,
  type OperationAction,
  pointKindIcon,
  statusLabel,
} from "../lib/route-def";
import { maxConfig } from "./client";
import type { MaxButton, MaxNewMessageBody } from "./types";

/** Формат payload кнопок: короткий, лимит MAX — 1024 символа. */
export const CB = {
  accept: (requestId: number) => `acc:${requestId}`,
  /** Действие операции на остановке. Повтор по отмеченному действию — «Уже отмечено». */
  action: (stopId: number, actionKey: string) => `a:${stopId}:${actionKey}`,
  /** Фото к действию приложены — отметить действие */
  actionDone: (stopId: number, actionKey: string) => `ad:${stopId}:${actionKey}`,
  comment: (requestId: number) => `cm:${requestId}`,
  photo: (requestId: number) => `ph:${requestId}`,
  alert: (requestId: number, type: string) => `al:${requestId}:${type}`,
  card: (requestId: number) => `cd:${requestId}`,
  /** Свободный текст → отправить комментарием */
  textAsComment: (requestId: number) => `tc:${requestId}`,
  nameConfirm: (yes: boolean) => `nm:${yes ? "1" : "0"}`,
  /** Согласие на обработку персональных данных */
  consent: (yes: boolean) => `cs:${yes ? "1" : "0"}`,
  cancelInput: () => "esc",
  approve: (staffId: number) => `ap:${staffId}`,
  reject: (staffId: number) => `rj:${staffId}`,
  signOutAll: () => "so",
};

export function parseCallback(payload: string | undefined) {
  const parts = (payload ?? "").split(":");
  return { kind: parts[0] ?? "", a: parts[1] ?? "", b: parts.slice(2).join(":") };
}

const tz = "Europe/Moscow";

export function formatDateTime(value: Date | null | undefined): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: tz,
  }).format(value);
}

export function formatTime(value: Date | null | undefined): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit", timeZone: tz }).format(value);
}

export const weightText = (t: number) => `${String(Math.round(t * 100) / 100).replace(".", ",")} т`;

export function keyboard(buttons: MaxButton[][]): MaxNewMessageBody["attachments"] {
  if (!buttons.length) return undefined;
  return [{ type: "inline_keyboard", payload: { buttons } }];
}

export const plainText = (text: string): MaxNewMessageBody => ({ text, format: "markdown", attachments: [] });

/* ─────────────── контекст ─────────────── */

export function pointTitle(view: StopView | null | undefined): string {
  if (!view?.point) return "пункт не указан";
  return `${pointKindIcon(view.point.kind)} ${view.point.name}`;
}

/** Шапка любого сообщения по заявке: «З-2026-0007 · 2/4 · 🏭 Склад «Ромашка» · Разгрузка». */
export function contextHeader(ctx: RequestContext, view?: StopView | null): string {
  const v = view === undefined ? ctx.current : view;
  if (!v) return `${ctx.request.number}${ctx.typeName ? ` · ${ctx.typeName}` : ""}`;
  return `${ctx.request.number} · ${v.index}/${v.total} · ${pointTitle(v)} · ${v.snapshot.name}`;
}

export function containerLine(ctx: RequestContext) {
  const r = ctx.request;
  return `${r.containerNo} · ${ctx.containerCode ?? "—"} · ${weightText(r.cargoWeightT)}`;
}

function stopMark(ctx: RequestContext, v: StopView) {
  if (v.stop.doneAt) return "✅";
  if (ctx.current?.stop.id === v.stop.id && isRunning(ctx.request.status)) return "▶️";
  return "○";
}

/** Маршрут списком с отметками и временем. */
export function routeLines(ctx: RequestContext, photos?: Map<number, number>): string {
  return ctx.stops
    .map((v) => {
      let line = `${stopMark(ctx, v)} ${v.index}. ${pointTitle(v)} — ${v.snapshot.name}`;
      line += `\n      план ${formatDateTime(v.stop.plannedArrivalAt)}`;
      if (v.stop.arrivedAt) line += ` · прибыл ${formatTime(v.stop.arrivedAt)}`;
      if (v.stop.doneAt) line += ` · готово ${formatTime(v.stop.doneAt)}`;
      const n = photos?.get(v.stop.id);
      if (n) line += ` · 📎 ${n}`;
      return line;
    })
    .join("\n");
}

function currentStopBlock(ctx: RequestContext): string {
  const v = ctx.current;
  if (!v) return "";
  const p = v.point;
  let text = `\n\n*Сейчас: ${v.index}/${v.total} · ${pointTitle(v)}*\nОперация: ${v.snapshot.name}\n`;
  if (p?.address) text += `Адрес: ${p.address}\n`;
  if (p?.contactName || p?.phone) {
    text += `Контакт: ${[p.contactName, p.phone ? formatPhone(p.phone) : null].filter(Boolean).join(", ")}\n`;
  }
  if (p?.schedule) text += `Режим работы: ${p.schedule}\n`;
  text += `Прибытие по плану: ${formatDateTime(v.stop.plannedArrivalAt)}\n`;
  if (p?.lat != null && p?.lon != null) text += `Карта: ${mapUrl(p.lat, p.lon)}\n`;
  if (p?.comment) text += `Примечание: ${p.comment}\n`;
  const next = nextAction(v.stop);
  if (next && isRunning(ctx.request.status)) {
    text += `\nСледующее действие: *${next.label}*`;
    if (next.photoRequired) text += `\n📷 Понадобится фото: ${next.photoHint}`;
  }
  return text.trimEnd();
}

/** Текст карточки заявки для водителя. */
export function requestCardText(ctx: RequestContext, header?: string): string {
  const r = ctx.request;
  let text = header ? `${header}\n\n` : "";
  text += `*Заявка ${r.number}*${ctx.typeName ? ` · ${ctx.typeName}` : ""}\n`;
  if (ctx.client) text += `Клиент: ${ctx.client.name}\n`;
  text += `Контейнер: ${containerLine(ctx)}\n`;
  text += `\n*Маршрут*\n${routeLines(ctx)}`;
  if (!isClosedStatus(r.status)) text += currentStopBlock(ctx);
  if (r.comment) text += `\n\n💬 Диспетчер: ${r.comment}`;
  text += `\n\n*Статус:* ${statusLabel(r.status)}`;
  if (r.status === "assigned" || r.status === "new") text += "\nНажмите «Принял заявку», чтобы начать рейс.";
  return text;
}

const EXTRA_BUTTONS: Record<ExtraAction, (requestId: number) => MaxButton> = {
  photo: (id) => ({ type: "callback", text: "📷 Фото", payload: CB.photo(id) }),
  comment: (id) => ({ type: "callback", text: "💬 Комментарий", payload: CB.comment(id) }),
  geo: () => ({ type: "request_geo_location", text: "📍 Геолокация", quick: true }),
  late: (id) => ({ type: "callback", text: "⏳ Опоздание", payload: CB.alert(id, "late"), intent: "negative" }),
  failure: (id) => ({ type: "callback", text: "🚨 Срыв", payload: CB.alert(id, "failure"), intent: "negative" }),
};

/** Клавиатура водителя: следующее действие текущей остановки + доп. кнопки операции. */
export function driverKeyboard(ctx: RequestContext): MaxButton[][] {
  const r = ctx.request;
  if (isClosedStatus(r.status)) return [];
  if (r.status === "new" || r.status === "assigned") {
    return [
      [{ type: "callback", text: "✅ Принял заявку", payload: CB.accept(r.id), intent: "positive" }],
      [EXTRA_BUTTONS.comment(r.id), EXTRA_BUTTONS.failure(r.id)],
    ];
  }
  const rows: MaxButton[][] = [];
  const v = ctx.current;
  if (!v) return rows;
  const next = nextAction(v.stop);
  if (next) {
    rows.push([
      {
        type: "callback",
        text: next.photoRequired ? `${next.buttonText} 📷` : next.buttonText,
        payload: CB.action(v.stop.id, next.key),
        intent: "positive",
      },
    ]);
  }
  const extras = v.snapshot.extraActions;
  const pick = (keys: ExtraAction[]) => keys.filter((k) => extras.includes(k)).map((k) => EXTRA_BUTTONS[k](r.id));
  for (const row of [pick(["photo", "comment"]), pick(["geo"]), pick(["late", "failure"])]) {
    if (row.length) rows.push(row);
  }
  return rows;
}

export function driverCardMessage(ctx: RequestContext, header?: string): MaxNewMessageBody {
  const buttons = driverKeyboard(ctx);
  return {
    text: requestCardText(ctx, header),
    // Пустой массив при правке снимает старую клавиатуру с закрытой заявки.
    attachments: buttons.length ? keyboard(buttons) : [],
    format: "markdown",
    notify: true,
  };
}

/** Запрос фото к действию. Редактируется на месте при каждом новом альбоме. */
export function actionPhotoPrompt(
  ctx: RequestContext,
  view: StopView,
  action: OperationAction,
  received: number,
  note?: string,
): MaxNewMessageBody {
  let text = `${contextHeader(ctx, view)}\n\n📷 *${action.label}*\nПришлите: ${action.photoHint}.\n`;
  text += received
    ? `\nПолучено файлов: *${received}*. Пришлите ещё или нажмите «Готово».`
    : "\nПолучено файлов: 0. Можно несколькими сообщениями или альбомом.";
  if (note) text = `${note}\n\n${text}`;
  return {
    text,
    format: "markdown",
    attachments: keyboard([
      [
        {
          type: "callback",
          text: received ? `✅ Готово (${received})` : "✅ Готово",
          payload: CB.actionDone(view.stop.id, action.key),
          intent: "positive",
        },
        { type: "callback", text: "✖ Отмена", payload: CB.cancelInput() },
      ],
    ]),
  };
}

/** Ответ на свободный текст вне контекста. */
export function freeTextPrompt(ctx: RequestContext, count: number): MaxNewMessageBody {
  return {
    text:
      `${contextHeader(ctx)}\n\n` +
      (count > 1 ? `Сообщений: ${count}. ` : "") +
      "Это комментарий к заявке? Диспетчер увидит его только после отправки.",
    format: "markdown",
    attachments: keyboard([
      [{ type: "callback", text: "💬 Отправить как комментарий", payload: CB.textAsComment(ctx.request.id), intent: "positive" }],
      [{ type: "callback", text: "📋 Показать карточку", payload: CB.card(ctx.request.id) }],
    ]),
  };
}

/* ─────────────── уведомления диспетчерам ─────────────── */

function withPanel(text: string, requestId: number): MaxNewMessageBody {
  const open = panelButton(`request-${requestId}`, `/requests/${requestId}`);
  return { text, format: "markdown", notify: true, ...(open ? { attachments: keyboard([[open]]) } : {}) };
}

export function actionNotification(p: {
  ctx: RequestContext;
  view: StopView;
  action: OperationAction;
  driverName: string;
  photos?: number;
}): MaxNewMessageBody {
  let text = `🔔 ${contextHeader(p.ctx, p.view)}\n*${p.action.label}*\n`;
  text += `Водитель: ${p.driverName}\nКонтейнер: ${containerLine(p.ctx)}\n`;
  text += `План: ${formatDateTime(p.view.stop.plannedArrivalAt)} · факт: ${formatDateTime(new Date())}`;
  if (p.photos) text += `\n📎 Приложено файлов: ${p.photos}`;
  return withPanel(text, p.ctx.request.id);
}

export function acceptedNotification(ctx: RequestContext, driverName: string): MaxNewMessageBody {
  const first = ctx.stops[0];
  return withPanel(
    `✅ *Заявка принята* · ${ctx.request.number}\nВодитель: ${driverName}\nКонтейнер: ${containerLine(ctx)}` +
      (first ? `\nПервая остановка: ${pointTitle(first)} · план ${formatDateTime(first.stop.plannedArrivalAt)}` : ""),
    ctx.request.id,
  );
}

/** Итог рейса: маршрут с фактическим временем и числом фото по остановкам. */
export function tripSummaryText(ctx: RequestContext, photos: Map<number, number>): string {
  return `🏁 *Рейс завершён* · ${ctx.request.number}\nКонтейнер: ${containerLine(ctx)}\n\n${routeLines(ctx, photos)}`;
}

export function doneNotification(ctx: RequestContext, driverName: string, photos: Map<number, number>) {
  return withPanel(`${tripSummaryText(ctx, photos)}\n\nВодитель: ${driverName}`, ctx.request.id);
}

export function attachmentNotification(ctx: RequestContext, view: StopView | null, driverName: string, count: number) {
  return withPanel(`📎 ${contextHeader(ctx, view)}\n${driverName}: файлов ${count}`, ctx.request.id);
}

export function geoNotification(ctx: RequestContext, view: StopView | null, driverName: string, lat: number, lon: number) {
  return withPanel(`📍 ${contextHeader(ctx, view)}\n${driverName}: ${lat}, ${lon}\n${mapUrl(lat, lon)}`, ctx.request.id);
}

export function commentNotification(ctx: RequestContext, view: StopView | null, driverName: string, text: string) {
  return withPanel(`💬 ${contextHeader(ctx, view)}\n${driverName}: ${text}`, ctx.request.id);
}

export function alertNotification(p: {
  ctx: RequestContext;
  type: string;
  view?: StopView | null;
  driverName: string;
  driverPhone?: string | null;
  message?: string | null;
}): MaxNewMessageBody {
  const view = p.view === undefined ? p.ctx.current : p.view;
  const title =
    p.type === "failure"
      ? "🚨🚨 СРЫВ ЗАЯВКИ"
      : p.type === "stop_late"
        ? "⏰ ОПАЗДЫВАЕТ НА ОСТАНОВКУ"
        : `⏳ ${(ALERT_LABELS[p.type] ?? p.type).toUpperCase()}`;
  let text =
    `${title}\n━━━━━━━━━━━━━━\n${contextHeader(p.ctx, view)}\n` +
    `Контейнер: ${containerLine(p.ctx)}\n` +
    `Водитель: *${p.driverName}*${p.driverPhone ? ` · ${formatPhone(p.driverPhone)}` : ""}\n` +
    `Статус: ${statusLabel(p.ctx.request.status)}`;
  if (view) text += `\nПлан прибытия: ${formatDateTime(view.stop.plannedArrivalAt)}`;
  if (p.message) text += `\nСообщение: ${p.message}`;
  text += "\n━━━━━━━━━━━━━━\n❗ Требуется связь с водителем.";
  return withPanel(text, p.ctx.request.id);
}

/** Напоминание водителю перед прибытием на остановку. */
export function reminderMessage(ctx: RequestContext, view: StopView, minutes: number): MaxNewMessageBody {
  const p = view.point;
  return {
    text:
      `⏰ *Напоминание* · ${contextHeader(ctx, view)}\n` +
      `Прибытие по плану: ${formatDateTime(view.stop.plannedArrivalAt)} — через ${minutes} мин.\n` +
      (p?.address ? `Адрес: ${p.address}\n` : "") +
      "Если не успеваете — нажмите «Опоздание» в карточке.",
    attachments: keyboard([[{ type: "callback", text: "🗂 Открыть карточку", payload: CB.card(ctx.request.id) }]]),
    format: "markdown",
    notify: true,
  };
}

/**
 * Кнопка запуска панели как мини-приложения MAX.
 * Работает только после подключения мини-приложения в кабинете организации
 * (нужен HTTPS-адрес в MAX_MINIAPP_URL и username бота); пока адреса нет —
 * возвращаем null, и сообщение уходит без кнопки.
 */
export function openPanelButton(startParam?: string): MaxButton | null {
  if (!maxConfig.miniAppUrl || !maxConfig.botUsername) return null;
  return {
    type: "open_app",
    text: "🖥 Открыть панель",
    web_app: maxConfig.botUsername,
    ...(startParam ? { payload: startParam } : {}),
  };
}

/** Тот же переход ссылкой — для случаев, когда мини-приложение ещё не подключено. */
export function panelLinkButton(path = ""): MaxButton | null {
  if (!maxConfig.miniAppUrl) return null;
  return { type: "link", text: "🖥 Открыть панель", url: `${maxConfig.miniAppUrl}${path}` };
}

/** Кнопка панели: внутри MAX — мини-приложение, иначе обычная ссылка. */
export function panelButton(startParam?: string, path = ""): MaxButton | null {
  return openPanelButton(startParam) ?? panelLinkButton(path);
}



/** Сообщение-заглушка для тех, у кого нет доступа. */
export const awaitingApprovalMessage: MaxNewMessageBody = {
  text: "Данные подтверждены. Доступ откроется после подтверждения администратором — бот пришлёт сообщение.",
  format: "markdown",
};

const ROLE_NAMES: Record<string, string> = { admin: "Администратор", dispatcher: "Диспетчер", driver: "Водитель" };

export function approvalRequestMessage(
  member: { id: number; fullName: string; phone: string; role: string },
  via: string,
): MaxNewMessageBody {
  return {
    text:
      `🛂 *Запрос допуска*\n` +
      `${member.fullName} · ${ROLE_NAMES[member.role] ?? member.role}\n` +
      `Телефон +${member.phone} подтверждён в MAX (${via}).\n` +
      `Допустить к работе?`,
    format: "markdown",
    attachments: keyboard([
      [
        { type: "callback", text: "✅ Допустить", payload: CB.approve(member.id), intent: "positive" },
        { type: "callback", text: "⛔ Отклонить", payload: CB.reject(member.id), intent: "negative" },
      ],
    ]),
  };
}

export function newDeviceMessage(device: string, ip: string | null): MaxNewMessageBody {
  return {
    text:
      `🔐 *Вход в панель с нового устройства*\n` +
      `${device}${ip ? ` · IP ${ip}` : ""}\n` +
      `Если это были не вы — нажмите кнопку, все сеансы будут завершены.`,
    format: "markdown",
    attachments: keyboard([
      [{ type: "callback", text: "🚫 Это не я — завершить все сеансы", payload: CB.signOutAll(), intent: "negative" }],
    ]),
  };
}

export const noAccessMessage: MaxNewMessageBody = {
  text: "Доступ не предоставлен. Обратитесь к диспетчеру или администратору автопарка.",
  format: "markdown",
};

export function contactRequestMessage(fullName: string): MaxNewMessageBody {
  return {
    text:
      `Здравствуйте! Для подтверждения личности поделитесь контактом — ` +
      `номер должен совпадать с номером в карточке сотрудника (${fullName}).`,
    attachments: keyboard([
      [{ type: "request_contact", text: "📱 Поделиться контактом" }],
    ]),
    format: "markdown",
  };
}

export function nameConfirmMessage(fullName: string): MaxNewMessageBody {
  return {
    text: `Проверьте данные: *${fullName}*\nВсё верно?`,
    attachments: keyboard([
      [
        { type: "callback", text: "Да, это я", payload: CB.nameConfirm(true), intent: "positive" },
        { type: "callback", text: "Нет", payload: CB.nameConfirm(false), intent: "negative" },
      ],
    ]),
    format: "markdown",
  };
}

/**
 * Запрос согласия на обработку персональных данных (ст. 9 152-ФЗ).
 *
 * Отдельный шаг, а не часть подтверждения ФИО: с 01.09.2025 согласие на
 * обработку ПДн (в том числе на данные о местоположении — ст. 10) оформляется
 * отдельным документом. Отказ — не блокировка, а отказ от активации.
 */
export function consentMessage(fullName: string, version: string): MaxNewMessageBody {
  return {
    text:
      `Остался последний шаг, ${fullName}.\n\n` +
      `*Согласие на обработку персональных данных*\n\n` +
      `Для работы в системе обрабатываются ваши персональные данные: ФИО, номер телефона, ` +
      `идентификатор аккаунта в MAX, гос. номер автомобиля, а при отметке прибытия — ` +
      `данные о местоположении (широта, долгота) и фотографии товарно-транспортных документов.\n\n` +
      `Цели: оформление и сопровождение заявок на перевозку, контроль маршрута, ` +
      `уведомление о статусе, обеспечение безопасности доступа.\n\n` +
      `Данные хранятся в базе на территории России и не передаются за границу. ` +
      `Вы можете отозвать согласие и потребовать удаления данных — тогда доступ прекратится.\n\n` +
      `Полный текст политики — на странице «Политика обработки персональных данных» в панели ` +
      `или по ссылке /privacy.\n\n` +
      `Версия согласия: ${version}.`,
    attachments: keyboard([
      [
        { type: "callback", text: "✅ Согласен", payload: CB.consent(true), intent: "positive" },
        { type: "callback", text: "Не согласен", payload: CB.consent(false), intent: "negative" },
      ],
    ]),
    format: "markdown",
  };
}

export function otpMessage(code: string): MaxNewMessageBody {
  return {
    text:
      `Код для входа в панель диспетчеризации: *${code}*\n` +
      `Код действует 5 минут. Никому его не сообщайте.`,
    format: "markdown",
    notify: true,
  };
}
