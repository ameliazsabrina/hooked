import type { RouterInputs, RouterOutputs } from "@hooked/server/trpc";

// Contract-driven UI types: derive from the router, never hand-write.
export type { RouterInputs, RouterOutputs };

export type Player = RouterOutputs["player"]["me"];
export type RoomLeaderboard = RouterOutputs["room"]["leaderboard"];
export type ActiveBounties = RouterOutputs["bounty"]["active"];
