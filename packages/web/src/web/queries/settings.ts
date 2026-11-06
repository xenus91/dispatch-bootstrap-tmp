import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { client, orpc } from "../lib/api";

/** Публичные настройки — доступны без авторизации (страница политики). */
export function usePublicSettings() {
  return useQuery(orpc.settings.public.queryOptions({ staleTime: 300_000 }));
}

export function useSettings() {
  return useQuery(orpc.settings.get.queryOptions({ staleTime: 30_000 }));
}

export function useIntegration(enabled: boolean) {
  return useQuery(orpc.settings.integration.queryOptions({ enabled, staleTime: 30_000 }));
}

export function useSubscribeWebhook() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (url: string) => client.settings.subscribeWebhook({ url }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: orpc.settings.key() });
    },
  });
}

export function useUnsubscribeWebhook() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (url: string) => client.settings.unsubscribeWebhook({ url }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: orpc.settings.key() });
    },
  });
}

type UpdateSettingsInput = Parameters<typeof client.settings.update>[0];

export function useUpdateSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateSettingsInput) => client.settings.update(input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: orpc.settings.key() });
    },
  });
}

export function useSecurity() {
  return useQuery(orpc.settings.security.queryOptions({ staleTime: 30_000 }));
}

type UpdateSecurityInput = Parameters<typeof client.settings.updateSecurity>[0];

export function useUpdateSecurity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateSecurityInput) => client.settings.updateSecurity(input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: orpc.settings.key() });
    },
  });
}

/* ── Вебхуки MAX ─────────────────────────────────────────────────────────── */

export function useCheckWebhook() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (url: string) => client.settings.checkWebhook({ url }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: orpc.settings.key() });
    },
  });
}

export function useRotateWebhookSecret() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => client.settings.rotateWebhookSecret(),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: orpc.settings.key() });
    },
  });
}

export function useWebhookStats(enabled: boolean) {
  return useQuery(
    orpc.settings.webhookStats.queryOptions({ enabled, refetchInterval: 30_000 }),
  );
}
