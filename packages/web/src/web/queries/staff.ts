import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { client, orpc } from "../lib/api";

export function useStaff(role?: "admin" | "dispatcher" | "driver") {
  return useQuery(orpc.staff.list.queryOptions({ input: { role }, refetchInterval: 20_000 }));
}

export function useDrivers() {
  return useQuery(orpc.staff.assignableDrivers.queryOptions({ staleTime: 15_000 }));
}

export function useTtlPresets() {
  return useQuery(orpc.staff.ttlPresets.queryOptions({ staleTime: Infinity }));
}

export function useAccessLog(limit = 50) {
  return useQuery(orpc.staff.accessLog.queryOptions({ input: { limit }, refetchInterval: 30_000 }));
}

function useStaffMutation<TInput, TResult>(fn: (input: TInput) => Promise<TResult>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: orpc.staff.key() });
    },
  });
}

type CreateStaffInput = Parameters<typeof client.staff.create>[0];
type UpdateStaffInput = Parameters<typeof client.staff.update>[0];

export function useCreateStaff() {
  return useStaffMutation((input: CreateStaffInput) => client.staff.create(input));
}

export function useUpdateStaff() {
  return useStaffMutation((input: UpdateStaffInput) => client.staff.update(input));
}

export function useIssueInvite() {
  return useStaffMutation((input: { staffId: number; ttlHours: 1 | 24 | 72 | 168 }) =>
    client.staff.issueInvite(input),
  );
}

export function useRevokeInvite() {
  return useStaffMutation((input: { inviteId: number }) => client.staff.revokeInvite(input));
}

export function useSetBlocked() {
  return useStaffMutation((input: { id: number; blocked: boolean }) => client.staff.setBlocked(input));
}

export function useResetMaxLink() {
  return useStaffMutation((input: { id: number }) => client.staff.resetMaxLink(input));
}

export function useApproveStaff() {
  return useStaffMutation((input: { id: number }) => client.staff.approve(input));
}

export function useRejectStaff() {
  return useStaffMutation((input: { id: number }) => client.staff.reject(input));
}

export function useUnlockLogin() {
  return useStaffMutation((input: { id: number }) => client.staff.unlockLogin(input));
}

/* ── Персональные данные (ст. 14–17 152-ФЗ) ─────────────────────────────── */

/** Выгрузка всех данных о сотруднике — ст. 14 152-ФЗ. */
export function useExportStaffData() {
  return useMutation({
    mutationFn: (id: number) => client.staff.exportData({ id }),
  });
}

/** Стирание персональных данных сотрудника — ст. 15 и 17 152-ФЗ. */
export function useEraseStaffData() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => client.staff.eraseData({ id, confirm: "УДАЛИТЬ" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: orpc.staff.key() });
    },
  });
}

/* ── Журнал административных действий (ст. 19 152-ФЗ) ────────────────────── */

export function useAuditLog(limit = 100) {
  return useQuery(
    orpc.staff.auditLog.queryOptions({
      input: { limit },
      refetchInterval: 30_000,
      placeholderData: (prev) => prev,
    }),
  );
}

export function useAuditActions() {
  return useQuery(orpc.staff.auditActions.queryOptions({ staleTime: 300_000 }));
}
