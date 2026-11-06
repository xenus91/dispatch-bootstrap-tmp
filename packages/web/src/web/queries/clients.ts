import { useQuery } from "@tanstack/react-query";
import { client, orpc } from "../lib/api";
import { useInvalidatingMutation } from "../lib/mutation";

export function useClients(input?: Parameters<typeof client.clients.list>[0]) {
  return useQuery(orpc.clients.list.queryOptions({ input: input ?? {}, staleTime: 30_000 }));
}

const keys = () => [orpc.clients.key(), orpc.requests.key()];

export function useCreateClient() {
  return useInvalidatingMutation((i: Parameters<typeof client.clients.create>[0]) => client.clients.create(i), keys());
}

export function useUpdateClient() {
  return useInvalidatingMutation((i: Parameters<typeof client.clients.update>[0]) => client.clients.update(i), keys());
}

export function useArchiveClient() {
  return useInvalidatingMutation((i: { id: number; archived: boolean }) => client.clients.archive(i), keys());
}

export function useRemoveClient() {
  return useInvalidatingMutation((i: { id: number }) => client.clients.remove(i), keys());
}
