import { useQuery } from "@tanstack/react-query";
import { client, orpc } from "../lib/api";
import { useInvalidatingMutation } from "../lib/mutation";

export function usePoints(input?: Parameters<typeof client.points.list>[0]) {
  return useQuery(orpc.points.list.queryOptions({ input: input ?? {}, staleTime: 30_000 }));
}

const keys = () => [orpc.points.key(), orpc.requests.key()];

export function useCreatePoint() {
  return useInvalidatingMutation((i: Parameters<typeof client.points.create>[0]) => client.points.create(i), keys());
}

export function useUpdatePoint() {
  return useInvalidatingMutation((i: Parameters<typeof client.points.update>[0]) => client.points.update(i), keys());
}

export function useArchivePoint() {
  return useInvalidatingMutation((i: { id: number; archived: boolean }) => client.points.archive(i), keys());
}

export function useRemovePoint() {
  return useInvalidatingMutation((i: { id: number }) => client.points.remove(i), keys());
}
