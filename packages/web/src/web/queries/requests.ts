import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { client, orpc } from "../lib/api";

const POLL = 10_000;

export type RequestScope = "active" | "all" | "archive";

export function useRequests(scope: RequestScope) {
  return useQuery(
    orpc.requests.list.queryOptions({
      input: { scope },
      refetchInterval: POLL,
    }),
  );
}

export function useRequest(id: number | null) {
  return useQuery(
    orpc.requests.get.queryOptions({
      input: { id: id ?? 0 },
      enabled: !!id,
      refetchInterval: POLL,
    }),
  );
}

export function useStats() {
  return useQuery(orpc.requests.stats.queryOptions({ refetchInterval: POLL }));
}

export function useOpenAlerts() {
  return useQuery(orpc.requests.openAlerts.queryOptions({ refetchInterval: POLL }));
}

/** Все мутации по заявкам обновляют список, карточку, сводку и тревоги. */
function useRequestMutation<TInput, TResult>(fn: (input: TInput) => Promise<TResult>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: orpc.requests.key() });
    },
  });
}

type CreateInput = Parameters<typeof client.requests.create>[0];
type UpdateInput = Parameters<typeof client.requests.update>[0];

export function useCreateRequest() {
  return useRequestMutation((input: CreateInput) => client.requests.create(input));
}

export function useUpdateRequest() {
  return useRequestMutation((input: UpdateInput) => client.requests.update(input));
}

export function useAssignDriver() {
  return useRequestMutation((input: { id: number; driverId: number }) => client.requests.assign(input));
}

export function useCancelRequest() {
  return useRequestMutation((input: { id: number; reason?: string }) => client.requests.cancel(input));
}

export function useResendCard() {
  return useRequestMutation((input: { id: number }) => client.requests.resendCard(input));
}

export function useAddComment() {
  return useRequestMutation((input: { id: number; comment: string; notifyDriver: boolean }) =>
    client.requests.addComment(input),
  );
}

export function useAcknowledgeAlert() {
  return useRequestMutation((input: { alertId: number }) => client.requests.acknowledgeAlert(input));
}

export function useRaiseAlert() {
  return useRequestMutation(
    (input: { id: number; type: "late" | "failure" | "no_contact"; message?: string }) =>
      client.requests.raiseAlert(input),
  );
}
