import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { errorText } from "../lib/api";
import { formatPhone } from "../../api/lib/domain";
import { closeMiniApp, initData, initDataUnsafe, requestContact } from "../lib/miniapp";
import { wasLoggedOut } from "../lib/session";
import { useMiniAppLink, useMiniAppLogin } from "../queries/auth";
import Login from "./login";

type Phase = "checking" | "link" | "failed" | "signedOut" | "expired";

/**
 * Вход внутри мини-приложения MAX.
 *
 * 1. При открытии отправляем подписанную строку initData на сервер — если аккаунт
 *    MAX уже привязан к карточке сотрудника, сессия создаётся без кода.
 * 2. Если привязки нет — предлагаем подтвердить номер нативным окном MAX
 *    (WebApp.requestContact), сервер сверяет подпись и активирует карточку.
 * 3. Если initData отклонена — остаётся обычный вход по номеру и коду.
 */
export default function MaxLogin() {
  // После «Выйти» автовход не запускаем — иначе выход мгновенно отменяется.
  const [phase, setPhase] = useState<Phase>(() => (wasLoggedOut() ? "signedOut" : "checking"));
  const [closeHint, setCloseHint] = useState(false);
  const [contactError, setContactError] = useState<string | null>(null);
  const started = useRef(false);

  const login = useMiniAppLogin();
  const link = useMiniAppLink();
  const unsafe = initDataUnsafe();
  const firstName = unsafe?.user?.first_name ?? null;

  const autoLogin = useCallback(() => {
    const raw = initData();
    if (!raw) {
      setPhase("failed");
      return;
    }
    setPhase("checking");
    login
      .mutateAsync(raw)
      .then((res) => {
        // res.token !== null → сессия уже сохранена в useMiniAppLogin, экран сменится сам.
        if (!res.token) setPhase("link");
      })
      // Подпись MAX действует 1 час (рекомендация MAX). Если окно мини-приложения висело
      // открытым дольше, повторный вход не пройдёт — подсказываем перезапуск, а не молча
      // уводим на вход по коду.
      .catch((e) => setPhase(/просроч/i.test(errorText(e)) ? "expired" : "failed"));
  }, [login]);

  useEffect(() => {
    // Автовход выполняется один раз за открытие мини-приложения: флаг
    // started.current отсекает повторные срабатывания эффекта.
    if (started.current || phase !== "checking") return;
    started.current = true;
    autoLogin();
  }, [autoLogin, phase]);

  async function confirmPhone() {
    setContactError(null);
    const raw = initData();
    if (!raw) {
      setPhase("failed");
      return;
    }
    const contact = await requestContact();
    if (!contact.ok) {
      setContactError(
        /refused|declined/i.test(contact.error)
          ? "Вы отклонили запрос номера. Без подтверждения номера вход невозможен."
          : contact.error,
      );
      return;
    }
    try {
      await link.mutateAsync({
        initData: raw,
        phone: contact.phone,
        authDate: contact.authDate,
        hash: contact.hash,
      });
    } catch {
      /* ошибка показывается ниже из link.error */
    }
  }

  if (phase === "failed") return <Login />;

  if (phase === "expired") {
    return (
      <div className="grid min-h-screen place-items-center px-4 py-10">
        <div className="w-full max-w-sm rounded-lg border border-border bg-[var(--surface)] p-5 text-center">
          <p className="text-base font-extrabold">Перезапустите мини-приложение</p>
          <p className="mt-2 text-xs leading-relaxed text-[var(--muted-foreground)]">
            Окно было открыто больше часа, и подпись MAX для входа устарела. Закройте мини-приложение
            и откройте его снова из чата с ботом — вход произойдёт автоматически.
          </p>
          <Button
            className="mt-4 w-full"
            onClick={() => {
              if (!closeMiniApp()) setCloseHint(true);
            }}
          >
            Закрыть мини-приложение
          </Button>
          {closeHint && (
            <p className="mt-3 text-[11px] text-[var(--muted-foreground)]">Закройте окно кнопкой ✕ в шапке MAX.</p>
          )}
          <Button variant="outline" className="mt-2 w-full" onClick={() => setPhase("failed")}>
            Войти по номеру и коду
          </Button>
        </div>
      </div>
    );
  }

  if (phase === "signedOut") {
    return (
      <div className="grid min-h-screen place-items-center px-4 py-10">
        <div className="w-full max-w-sm rounded-lg border border-border bg-[var(--surface)] p-5 text-center">
          <span className="mx-auto mb-4 grid size-11 place-items-center rounded-lg bg-[var(--primary)] text-base font-extrabold text-[var(--primary-foreground)]">
            MD
          </span>
          <p className="text-base font-extrabold">Вы вышли из панели</p>
          <p className="mt-2 text-xs leading-relaxed text-[var(--muted-foreground)]">
            Сеанс на этом устройстве завершён. Чтобы снова открыть заявки, нажмите «Войти» — вход
            подтвердит ваш аккаунт MAX, код не нужен.
          </p>
          <Button className="mt-4 w-full" onClick={autoLogin}>
            Войти снова
          </Button>
          <Button
            variant="outline"
            className="mt-2 w-full"
            onClick={() => {
              if (!closeMiniApp()) setCloseHint(true);
            }}
          >
            Закрыть мини-приложение
          </Button>
          {closeHint && (
            <p className="mt-3 text-[11px] text-[var(--muted-foreground)]">
              Закройте окно кнопкой ✕ в шапке MAX.
            </p>
          )}
        </div>
      </div>
    );
  }

  if (phase === "checking") {
    return (
      <div className="grid min-h-screen place-items-center px-6 text-center">
        <div>
          <div className="mx-auto mb-4 size-8 animate-spin rounded-full border-2 border-[var(--border)] border-t-[var(--primary)]" />
          <p className="text-sm text-[var(--muted-foreground)]">Проверяем аккаунт MAX…</p>
        </div>
      </div>
    );
  }

  const linked = link.data?.user ?? null;

  return (
    <div className="grid min-h-screen place-items-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-3">
          <span className="grid size-11 place-items-center rounded-lg bg-[var(--primary)] text-base font-extrabold text-[var(--primary-foreground)]">
            MD
          </span>
          <div>
            <h1 className="text-lg font-extrabold leading-tight tracking-tight">Диспетчерская</h1>
            <p className="text-xs text-[var(--muted-foreground)]">
              Мини-приложение MAX · привязка аккаунта
            </p>
          </div>
        </div>

        <div className="rounded-lg border border-border bg-[var(--surface)] p-5">
          <p className="text-sm font-semibold">
            {firstName ? `${firstName}, подтвердите номер телефона` : "Подтвердите номер телефона"}
          </p>
          <p className="mt-2 text-xs leading-relaxed text-[var(--muted-foreground)]">
            Ваш аккаунт MAX ещё не привязан к карточке сотрудника. Нажмите кнопку ниже — MAX
            покажет системное окно и передаст номер с подписью. Доступ откроется, только если
            номер есть в списке сотрудников, созданном администратором.
          </p>

          {contactError && (
            <p className="mt-3 text-xs font-semibold text-[var(--danger)]">{contactError}</p>
          )}
          {link.isError && (
            <p className="mt-3 text-xs font-semibold text-[var(--danger)]">{errorText(link.error)}</p>
          )}
          {linked && link.data?.pending && (
            <p className="mt-3 text-xs font-semibold text-[var(--warning)]">
              Номер подтверждён: {linked.fullName} · {formatPhone(linked.phone)}. Доступ откроется после
              допуска администратором — бот пришлёт сообщение, затем откройте приложение снова.
            </p>
          )}
          {linked && !link.data?.pending && (
            <p className="mt-3 text-xs font-semibold text-[var(--success)]">
              Готово: {linked.fullName} · {formatPhone(linked.phone)}
            </p>
          )}

          <Button onClick={confirmPhone} className="mt-4 w-full" disabled={link.isPending || !!link.data?.pending}>
            {link.isPending ? "Проверяем…" : "Подтвердить номер в MAX"}
          </Button>
        </div>

        <p className="mt-4 text-center text-[11px] leading-relaxed text-[var(--muted-foreground)]">
          Не получается? Обратитесь к диспетчеру или администратору автопарка — учётные записи
          создаются только вручную.
        </p>
      </div>
    </div>
  );
}
