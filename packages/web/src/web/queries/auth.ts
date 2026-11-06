import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { client, orpc } from "../lib/api";
import { inMax } from "../lib/miniapp";
import { clearToken, markLoggedOut, setToken } from "../lib/session";

export function useMe() {
  return useQuery(orpc.auth.me.queryOptions({ staleTime: 30_000, retry: false }));
}

export function useBotStatus() {
  return useQuery(orpc.auth.botStatus.queryOptions({ staleTime: 60_000 }));
}

export function useRequestCode() {
  return useMutation({
    mutationFn: (input: { phone: string; consent: boolean }) =>
      client.auth.requestCode(input),
  });
}

export function useVerifyCode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { phone: string; code: string }) => client.auth.verifyCode(input),
    onSuccess: async (data) => {
      setToken(data.token);
      await qc.invalidateQueries();
    },
  });
}

/** Автовход внутри MAX: initData → сессия, без ввода кода. */
export function useMiniAppLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (initData: string) => client.auth.miniAppLogin({ initData }),
    onSuccess: async (data) => {
      if (data.token) {
        setToken(data.token);
        await qc.invalidateQueries();
      }
    },
  });
}

/** Привязка аккаунта из мини-приложения по подписанному номеру MAX. */
export function useMiniAppLink() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { initData: string; phone: string; authDate: string; hash: string }) =>
      client.auth.miniAppLink(input),
    onSuccess: async (data) => {
      // Ждёт допуска администратора — сеанса ещё нет.
      if (!data.token) return;
      setToken(data.token);
      await qc.invalidateQueries();
    },
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => client.auth.logout(),
    onSettled: async () => {
      clearToken();
      if (inMax()) markLoggedOut();
      // Раньше здесь был qc.clear(): кэш очищался, но экран не перерисовывался и
      // панель оставалась открытой — «Выйти» выглядело неработающим. Теперь явно
      // ставим me = null (App сразу показывает вход), остальные данные удаляем.
      const meKey = orpc.auth.me.queryKey();
      await qc.cancelQueries();
      qc.setQueryData(meKey, null);
      qc.removeQueries({ predicate: (q) => JSON.stringify(q.queryKey) !== JSON.stringify(meKey) });
    },
  });
}
