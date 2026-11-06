import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { client, orpc } from "../lib/api";

export function useMySessions() {
  return useQuery(orpc.sessions.mine.queryOptions({ refetchInterval: 60_000 }));
}

export function useStaffSessions(staffId: number, enabled: boolean) {
  return useQuery(orpc.sessions.forStaff.queryOptions({ input: { staffId }, enabled }));
}

function useSessionMutation<TInput, TResult>(fn: (input: TInput) => Promise<TResult>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: orpc.sessions.key() });
    },
  });
}

export function useRevokeSession() {
  return useSessionMutation((input: { id: number }) => client.sessions.revoke(input));
}

export function useRevokeOtherSessions() {
  return useSessionMutation(() => client.sessions.revokeOthers());
}

export function useRevokeAllForStaff() {
  return useSessionMutation((input: { staffId: number }) => client.sessions.revokeAllForStaff(input));
}
