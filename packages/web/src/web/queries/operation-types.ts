import { useQuery } from "@tanstack/react-query";
import { client, orpc } from "../lib/api";
import { useInvalidatingMutation } from "../lib/mutation";

export function useOperationTypes(input?: Parameters<typeof client.operationTypes.list>[0]) {
  return useQuery(orpc.operationTypes.list.queryOptions({ input: input ?? {}, staleTime: 30_000 }));
}

const keys = () => [orpc.operationTypes.key(), orpc.requests.key(), orpc.notifications.key()];

export function useCreateOperationType() {
  return useInvalidatingMutation((i: Parameters<typeof client.operationTypes.create>[0]) => client.operationTypes.create(i), keys());
}

export function useUpdateOperationType() {
  return useInvalidatingMutation((i: Parameters<typeof client.operationTypes.update>[0]) => client.operationTypes.update(i), keys());
}

export function useArchiveOperationType() {
  return useInvalidatingMutation((i: { id: number; archived: boolean }) => client.operationTypes.archive(i), keys());
}

export function useRemoveOperationType() {
  return useInvalidatingMutation((i: { id: number }) => client.operationTypes.remove(i), keys());
}
