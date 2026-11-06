/**
 * Обёртка над MAX Bridge (`window.WebApp`, подключается в index.html через
 * https://st.max.ru/js/max-web-app.js).
 *
 * Одна и та же сборка работает двумя способами:
 *  - как обычный сайт в браузере ПК — все методы ниже просто no-op;
 *  - как мини-приложение внутри MAX — доступны initData, кнопка «Назад»,
 *    запрос контакта, открытие ссылок, скачивание файлов.
 *
 * Никакой логики авторизации здесь нет: строка initData уходит на сервер,
 * где проверяется подпись ботовым токеном (см. api/max/initdata.ts).
 */

interface MaxInitDataUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string | null;
  language_code?: string;
  photo_url?: string | null;
}

export interface MaxInitDataUnsafe {
  query_id?: string;
  auth_date?: number;
  hash?: string;
  user?: MaxInitDataUser;
  chat?: { id: number; type: "DIALOG" | "CHAT" | "CHANNEL" };
  start_param?: string;
}

interface MaxWebApp {
  initData?: string;
  initDataUnsafe?: MaxInitDataUnsafe;
  platform?: string;
  version?: string;
  deviceName?: string;
  getViewportSize?: () => Promise<{ height: string; width: string }>;
  requestContact?: () => Promise<{ phone?: string; authDate?: string; hash?: string; error?: { code: string } }>;
  openLink?: (url: string) => void;
  openMaxLink?: (url: string) => void;
  downloadFile?: (url: string, fileName: string) => Promise<unknown>;
  enableClosingConfirmation?: () => void;
  disableClosingConfirmation?: () => void;
  shareMaxContent?: (params: { text?: string; link?: string }) => Promise<unknown>;
  /** Не описан в документации MAX Bridge, но есть в части клиентов — вызываем, только если он есть. */
  close?: () => void;
  BackButton?: {
    show: () => void;
    hide: () => void;
    isVisible?: boolean;
    onClick?: (handler: () => void) => void;
    offClick?: (handler: () => void) => void;
  };
}

function bridge(): MaxWebApp | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { WebApp?: MaxWebApp }).WebApp ?? null;
}

/** Внутри MAX мы только если мост реально отдал initData с подписью. */
export function inMax(): boolean {
  const wa = bridge();
  return !!wa && typeof wa.initData === "string" && wa.initData.length > 0;
}

export function initData(): string | null {
  const raw = bridge()?.initData;
  return raw && raw.length > 0 ? raw : null;
}

export function initDataUnsafe(): MaxInitDataUnsafe | null {
  return bridge()?.initDataUnsafe ?? null;
}

export function maxPlatform(): string | null {
  return bridge()?.platform ?? null;
}

/** start_param из диплинка вида https://max.ru/<bot>?startapp=<payload>. */
export function startParam(): string | null {
  return initDataUnsafe()?.start_param ?? null;
}

/** Ссылки: внутри MAX — через мост, иначе обычный переход. */
export function openExternal(url: string) {
  const wa = bridge();
  if (wa?.openMaxLink && url.startsWith("https://max.ru/")) {
    wa.openMaxLink(url);
    return;
  }
  if (wa?.openLink) {
    wa.openLink(url);
    return;
  }
  window.open(url, "_blank", "noopener");
}

/** Скачивание: в мини-приложении href не работает, нужен метод моста. */
export function downloadFile(url: string, fileName: string) {
  const wa = bridge();
  if (wa?.downloadFile) {
    void wa.downloadFile(url, fileName);
    return;
  }
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.rel = "noopener";
  a.click();
}

/** Запрос номера телефона нативным окном MAX — для привязки аккаунта из мини-приложения. */
export async function requestContact(): Promise<
  { ok: true; phone: string; authDate: string; hash: string } | { ok: false; error: string }
> {
  const wa = bridge();
  if (!wa?.requestContact) return { ok: false, error: "Метод доступен только в мини-приложении MAX." };
  try {
    const res = await wa.requestContact();
    if (res?.error?.code) return { ok: false, error: res.error.code };
    if (!res?.phone || !res.hash || !res.authDate) {
      return { ok: false, error: "MAX не вернул номер телефона." };
    }
    return { ok: true, phone: res.phone, authDate: res.authDate, hash: res.hash };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Закрыть мини-приложение. false — клиент MAX не поддерживает закрытие из кода. */
export function closeMiniApp(): boolean {
  const wa = bridge();
  if (!wa?.close) return false;
  try {
    wa.close();
    return true;
  } catch {
    return false;
  }
}

/** Кнопка «Назад» в шапке MAX: показываем на вложенных экранах. */
export function backButton(visible: boolean) {
  const bb = bridge()?.BackButton;
  if (!bb) return;
  try {
    if (visible) bb.show();
    else bb.hide();
  } catch {
    /* старая версия клиента — игнорируем */
  }
}

/**
 * Подписка на нажатие системной кнопки «Назад» в шапке MAX.
 * Возвращает функцию отписки (no-op вне мини-приложения).
 */
export function onBackButton(handler: () => void): () => void {
  const bb = bridge()?.BackButton;
  if (!bb?.onClick) return () => {};
  try {
    bb.onClick(handler);
  } catch {
    return () => {};
  }
  return () => {
    try {
      bb.offClick?.(handler);
    } catch {
      /* ignore */
    }
  };
}

/** Предупреждение о потере данных при закрытии — включаем на формах. */
export function closingConfirmation(enabled: boolean) {
  const wa = bridge();
  try {
    if (enabled) wa?.enableClosingConfirmation?.();
    else wa?.disableClosingConfirmation?.();
  } catch {
    /* ignore */
  }
}

/** Реальная высота вьюпорта мини-приложения (учитывает шапку клиента MAX). */
export async function applyViewport() {
  const wa = bridge();
  if (!wa?.getViewportSize) return;
  try {
    const size = await wa.getViewportSize();
    const h = Number.parseInt(String(size.height), 10);
    if (Number.isFinite(h) && h > 200) {
      document.documentElement.style.setProperty("--max-viewport-height", `${h}px`);
    }
  } catch {
    /* ignore */
  }
}
