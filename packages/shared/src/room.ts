export const ROOM_DURATION_DAYS = 7;
export const ROOM_ENTRY_WINDOW_DAYS = 1;
export const ROOM_CAPACITY_SOL = 20;
export const ROOM_MAX_PLAYERS = 40;
export const ROOMS_PER_DAY_LAUNCH = 1;
export const ROOMS_PER_DAY_POST_LAUNCH = 2;

export type RoomPhase = "entry" | "active" | "settling" | "closed";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function computeRoomTimestamps(createdAt: Date): {
  entryClosesAt: Date;
  closesAt: Date;
} {
  return {
    entryClosesAt: new Date(
      createdAt.getTime() + ROOM_ENTRY_WINDOW_DAYS * MS_PER_DAY,
    ),
    closesAt: new Date(createdAt.getTime() + ROOM_DURATION_DAYS * MS_PER_DAY),
  };
}

export function derivePhase(
  room: {
    entryClosesAt: Date;
    closesAt: Date;
    phase: RoomPhase;
  },
  now: Date = new Date(),
): RoomPhase {
  if (room.phase === "closed") return "closed";
  if (now >= room.closesAt) return "settling";
  if (now >= room.entryClosesAt) return "active";
  return "entry";
}

export function isRoomJoinable(room: {
  phase: RoomPhase;
  depositedSol: number;
  capacitySol: number;
  players: unknown[];
  maxPlayers: number;
}): boolean {
  return (
    room.phase === "entry" &&
    room.depositedSol < room.capacitySol &&
    room.players.length < room.maxPlayers
  );
}

// Room boundaries align with bait refill (02:00 / 14:00 UTC) so new bait and new room arrive together.
// See server/services/fishing/window.ts.
export function currentRoomWindowStart(now: Date = new Date()): Date {
  const hour = now.getUTCHours();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  if (hour < 2) return new Date(Date.UTC(y, m, d - 1, 14));
  if (hour < 14) return new Date(Date.UTC(y, m, d, 2));
  return new Date(Date.UTC(y, m, d, 14));
}

export function nextRoomOpensAt(now: Date = new Date()): Date {
  const hour = now.getUTCHours();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  if (hour < 2) return new Date(Date.UTC(y, m, d, 2));
  if (hour < 14) return new Date(Date.UTC(y, m, d, 14));
  return new Date(Date.UTC(y, m, d + 1, 2));
}
