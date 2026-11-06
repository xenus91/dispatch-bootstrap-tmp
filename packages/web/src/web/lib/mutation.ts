import { useMutation, useQueryClient, type QueryKey } from "@tanstack/react-query";

/** Мутация, после которой сбрасываются указанные запросы (справочники, заявки). */
export function useInvalidatingMutation<TInput, TResult>(fn: (input: TInput) => Promise<TResult>, keys: QueryKey[]) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      for (const queryKey of keys) void qc.invalidateQueries({ queryKey });
    },
  });
}
