import { useQuery } from "@tanstack/react-query";
import { client, orpc } from "../lib/api";
import { useInvalidatingMutation } from "../lib/mutation";

export function useRequestTypes(input?: Parameters<typeof client.requestTypes.list>[0]) {
  return useQuery(orpc.requestTypes.list.queryOptions({ input: input ?? {}, staleTime: 30_000 }));
}

const keys = () => [orpc.requestTypes.key(), orpc.requests.key()];

export function useCreateRequestType() {
  return useInvalidatingMutation((i: Parameters<typeof client.requestTypes.create>[0]) => client.requestTypes.create(i), keys());
}

export function useUpdateRequestType() {
  return useInvalidatingMutation((i: Parameters<typeof client.requestTypes.update>[0]) => client.requestTypes.update(i), keys());
}

export function useArchiveRequestType() {
  return useInvalidatingMutation((i: { id: number; archived: boolean }) => client.requestTypes.archive(i), keys());
}

export function useRemoveRequestType() {
  return useInvalidatingMutation((i: { id: number }) => client.requestTypes.remove(i), keys());
}
