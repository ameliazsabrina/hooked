import { trpc } from "~/utils/trpc";

interface RoomLeaderboardOptions {
  enabled?: boolean;
  refetchInterval?: number;
  staleTime?: number;
}

// The only place that reads trpc.room.leaderboard.
export function useRoomLeaderboard(
  roomId: string | null,
  options?: RoomLeaderboardOptions,
) {
  return trpc.room.leaderboard.useQuery({ roomId: roomId ?? "" }, options);
}

export function useActiveRoom(options?: {
  refetchInterval?: number;
  enabled?: boolean;
}) {
  return trpc.room.active.useQuery(undefined, options);
}

// Recover a room entry; invalidates room + player state on success so the
// caller doesn't need trpc utils.
export function useRecoverEntry() {
  const utils = trpc.useUtils();
  return trpc.room.recoverEntry.useMutation({
    onSuccess: async () => {
      await utils.room.active.invalidate();
      await utils.player.me.invalidate();
      await utils.player.sessionState.invalidate();
    },
  });
}
