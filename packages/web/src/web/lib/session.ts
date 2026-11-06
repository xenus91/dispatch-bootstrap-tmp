const KEY = "maxdispatch.token";

/** Токен сессии живёт в localStorage — панель открывается и в браузере, и в Mini App MAX. */
export function getToken(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

/**
 * Флаг «пользователь сам вышел». Внутри MAX вход происходит автоматически по initData,
 * поэтому без флага кнопка «Выйти» сразу же снова входила — выход «не работал».
 */
const LOGGED_OUT_KEY = "maxdispatch.loggedOut";

export function markLoggedOut() {
  try {
    localStorage.setItem(LOGGED_OUT_KEY, "1");
  } catch {
    /* ignore */
  }
}

export function wasLoggedOut(): boolean {
  try {
    return localStorage.getItem(LOGGED_OUT_KEY) === "1";
  } catch {
    return false;
  }
}

export function setToken(token: string) {
  try {
    localStorage.removeItem(LOGGED_OUT_KEY);
    localStorage.setItem(KEY, token);
  } catch {
    /* приватный режим — работаем в пределах сессии страницы */
  }
}

export function clearToken() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/** Запущены ли мы внутри Mini App MAX (iframe/webview мессенджера). */
export function isMiniApp(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as unknown as { max?: unknown; WebApp?: unknown };
  if (w.max || w.WebApp) return true;
  return /MAX|OneMe/i.test(navigator.userAgent) || window.self !== window.top;
}
