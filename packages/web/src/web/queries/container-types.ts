import { useQuery } from "@tanstack/react-query";
import { client, orpc } from "../lib/api";
import { useInvalidatingMutation } from "../lib/mutation";

export function useContainerTypes(input?: Parameters<typeof client.containerTypes.list>[0]) {
  return useQuery(orpc.containerTypes.list.queryOptions({ input: input ?? {}, staleTime: 30_000 }));
}

const keys = () => [orpc.containerTypes.key(), orpc.requests.key()];

export function useCreateContainerType() {
  return useInvalidatingMutation((i: Parameters<typeof client.containerTypes.create>[0]) => client.containerTypes.create(i), keys());
}

export function useUpdateContainerType() {
  return useInvalidatingMutation((i: Parameters<typeof client.containerTypes.update>[0]) => client.containerTypes.update(i), keys());
}

export function useArchiveContainerType() {
  return useInvalidatingMutation((i: { id: number; archived: boolean }) => client.containerTypes.archive(i), keys());
}

export function useRemoveContainerType() {
  return useInvalidatingMutation((i: { id: number }) => client.containerTypes.remove(i), keys());
}
