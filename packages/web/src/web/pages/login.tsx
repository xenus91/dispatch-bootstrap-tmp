import { useState } from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { errorText } from "../lib/api";
import { formatPhone } from "../../api/lib/domain";
import { useBotStatus, useRequestCode, useVerifyCode } from "../queries/auth";

export default function Login() {
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"phone" | "code">("phone");
  const [devCode, setDevCode] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);

  const bot = useBotStatus();
  const requestCode = useRequestCode();
  const verify = useVerifyCode();

  async function submitPhone(e: React.FormEvent) {
    e.preventDefault();
    if (!consent) return;
    const res = await requestCode.mutateAsync({ phone, consent: true });
    setDevCode(res.devCode ?? null);
    setStep("code");
  }

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
              Контейнерные перевозки · вход по номеру
            </p>
          </div>
        </div>

        <div className="rounded-lg border border-border bg-[var(--surface)] p-5">
          {step === "phone" ? (
            <form onSubmit={submitPhone} className="space-y-4">
              <div>
                <label
                  htmlFor="login-phone"
                  className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-foreground)]"
                >
                  Телефон, привязанный к MAX
                </label>
                <input
                  id="login-phone"
                  aria-label="Телефон, привязанный к MAX"
                  inputMode="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="+7 900 000-00-00"
                  className="mono w-full"
                />
              </div>
              <p className="text-xs leading-relaxed text-[var(--muted-foreground)]">
                Код придёт сообщением от бота в ваш личный чат MAX. Учётные записи создаёт
                администратор — самостоятельная регистрация недоступна.
              </p>
              {requestCode.isError && (
                <p className="text-xs font-semibold text-[var(--danger)]">
                  {errorText(requestCode.error)}
                </p>
              )}
              <div className="flex items-start gap-2">
                <input
                  id="login-consent"
                  aria-label="Согласие на обработку персональных данных"
                  type="checkbox"
                  checked={consent}
                  onChange={(e) => setConsent(e.target.checked)}
                  className="mt-0.5 size-4 shrink-0"
                />
                <label htmlFor="login-consent" className="text-xs leading-relaxed text-[var(--muted-foreground)]">
                  Согласен на обработку персональных данных{" "}
                  <Link href="/privacy" className="underline underline-offset-2 hover:text-foreground">
                    политика обработки
                  </Link>
                </label>
              </div>

              <Button
                type="submit"
                className="w-full"
                disabled={requestCode.isPending || phone.length < 6 || !consent}
              >
                {requestCode.isPending ? "Отправляем…" : "Получить код"}
              </Button>
            </form>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                verify.mutate({ phone, code });
              }}
              className="space-y-4"
            >
              <div>
                <label
                  htmlFor="login-code"
                  className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-foreground)]"
                >
                  Код из чата MAX
                </label>
                <input
                  id="login-code"
                  aria-label="Код из чата MAX"
                  inputMode="numeric"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                  placeholder="000000"
                  className="mono w-full text-center text-lg tracking-[0.4em]"
                />
                <p className="mt-2 text-xs text-[var(--muted-foreground)]">
                  Отправлен на {formatPhone(phone)} · действует 5 минут
                </p>
              </div>

              {devCode && (
                <div className="rounded-md border border-[color-mix(in_srgb,var(--warning)_35%,transparent)] bg-[color-mix(in_srgb,var(--warning)_12%,transparent)] p-3 text-xs">
                  <div className="font-bold text-[var(--warning)]">
                    {bot.data?.stub ? "Режим без бота MAX" : "Аккаунт MAX не привязан"}
                  </div>
                  <div className="mt-1 text-[var(--muted-foreground)]">
                    Код показан здесь, потому что доставить его в чат MAX пока нельзя:{" "}
                    <span className="mono font-bold text-foreground">{devCode}</span>
                  </div>
                </div>
              )}

              {verify.isError && (
                <p className="text-xs font-semibold text-[var(--danger)]">{errorText(verify.error)}</p>
              )}

              <Button type="submit" className="w-full" disabled={verify.isPending || code.length < 4}>
                {verify.isPending ? "Проверяем…" : "Войти"}
              </Button>
              <button
                type="button"
                onClick={() => {
                  setStep("phone");
                  setCode("");
                  setDevCode(null);
                }}
                className="w-full text-xs text-[var(--muted-foreground)] hover:text-foreground"
              >
                Изменить номер
              </button>
            </form>
          )}
        </div>

        <p className="mt-4 text-center text-[11px] leading-relaxed text-[var(--muted-foreground)]">
          Обрабатываемые данные, цели и сроки хранения — в{" "}
          <Link href="/privacy" className="underline underline-offset-2 hover:text-foreground">
            политике обработки персональных данных
          </Link>
          .
        </p>

        {bot.data?.devLogin && !bot.data?.stub && (
          <p className="mt-4 text-center text-[11px] text-[var(--warning)]">
            Включён режим приёмки (DEV_LOGIN): код входа показывается в панели. Перед вводом в
            эксплуатацию режим нужно отключить.
          </p>
        )}

        {bot.data?.stub && (
          <p className="mt-4 text-center text-[11px] text-[var(--muted-foreground)]">
            Бот MAX работает в режиме заглушки — исходящие сообщения пишутся в журнал, а не в мессенджер.
          </p>
        )}
      </div>
    </div>
  );
}
