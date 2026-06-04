import { trpc } from "~/utils/trpc";

// Narrow options (no `select`) so the query's inferred output type is preserved.
interface UsePlayerOptions {
  enabled?: boolean;
  retry?: number | boolean;
  staleTime?: number;
}

// The only place that reads trpc.player.me — callers pass their own gating.
export function usePlayer(options?: UsePlayerOptions) {
  return trpc.player.me.useQuery(undefined, options);
}

// Sets the nickname and refreshes player state; caller maps errors for the UI.
export function useSetNickname(options?: {
  onError?: (error: unknown) => void;
}) {
  const utils = trpc.useUtils();
  return trpc.player.setNickname.useMutation({
    onSuccess: () => {
      void utils.player.me.invalidate();
    },
    onError: options?.onError,
  });
}
