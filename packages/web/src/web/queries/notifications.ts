import { useQuery } from "@tanstack/react-query";
import { client, orpc } from "../lib/api";
import { useInvalidatingMutation } from "../lib/mutation";

export function useNotifications() {
  return useQuery(orpc.notifications.get.queryOptions({ staleTime: 30_000 }));
}

export function useSaveNotifications() {
  return useInvalidatingMutation(
    (input: Parameters<typeof client.notifications.save>[0]) => client.notifications.save(input),
    [orpc.notifications.key()],
  );
}
