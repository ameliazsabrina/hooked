import { trpc } from "~/utils/trpc";

interface BountiesOptions {
  enabled?: boolean;
  refetchInterval?: number;
  staleTime?: number;
}

// The only place that reads trpc.bounty.active.
export function useBounties(options?: BountiesOptions) {
  return trpc.bounty.active.useQuery(undefined, options);
}
