export const DEFAULT_GATEWAY_HTTP = "http://localhost:3001";
export const RECONNECT_DELAY_MS = 1500;
export const CAST_ANIMATION_MS = 700;
export const HOOK_ANIMATION_MS = 350;
export const NIBBLE_WINDOW_MS = 2000;

export type ServerMessage =
  | { type: "authenticated"; wallet: string; sessionPda?: string }
  | { type: "auth_failed"; reason: string }
  | {
      type: "cast_accepted";
      sessionId: string;
      clientCastId: string;
      castTimestamp: number;
    }
  | {
      type: "nibble_event";
      sessionId: string;
      clientCastId: string;
      serverTs: number;
    }
  | {
      type: "fish_escaped";
      sessionId: string;
      clientCastId: string;
      reason: "no_tap" | "early_tap";
    }
  | {
      type: "fish_hooked";
      sessionId: string;
      clientCastId: string;
      speciesId: number;
      apexFishId: string | null;
      apexAssetUrl: string | null;
      speciesName: string;
      rarity: number;
      mechanic: number;
      greenZoneStart: number;
      greenZoneWidth: number;
      weightHg: number;
      castTimestamp: number;
      rngSeed: number;
      // Server-chosen adaptive lag-comp buffer; optional so an older server parses (falls back to INPUT_DELAY_MS).
      inputDelayMs?: number;
    }
  | {
      type: "fishing_state";
      sessionId: string;
      clientCastId: string;
      barY: number;
      fishY: number;
      progress: number;
      tickIndex: number;
    }
  | {
      type: "desync_correction";
      sessionId: string;
      clientCastId: string;
      barY: number;
      fishY: number;
      progress: number;
      tickIndex: number;
    }
  | {
      type: "catch_resolved";
      sessionId: string;
      clientCastId: string;
      hit: boolean;
      speciesId: number;
      apexFishId: string | null;
      apexAssetUrl: string | null;
      speciesName: string;
      rarity: number;
      weightHg: number;
      score: number;
      roomId?: string;
    }
  | {
      type: "leaderboard_update";
      roomId?: string;
      date: string;
      entries: Array<{
        wallet: string;
        displayName?: string;
        score: number;
        catchCount: number;
      }>;
    }
  | { type: "bait_refilled"; bait: number; window: number; date: number }
  | {
      type: "event_status";
      active: boolean;
      name: string;
      startsAt: number;
      endsAt: number;
      apexBp: number;
      prizePoolSol: number;
      apexFishes: Array<{
        id: string;
        name: string;
        weightMinKg: number;
        weightMaxKg: number;
        assetUrl: string;
      }>;
    }
  | { type: "error"; code: string; message: string }
  | { type: "pong"; t: number };

export function httpBase(): string {
  const override = import.meta.env.VITE_GATEWAY_HTTP as string | undefined;
  return override ?? DEFAULT_GATEWAY_HTTP;
}

export function wsUrl(): string {
  const override = import.meta.env.VITE_WS_URL as string | undefined;
  if (override) return override;
  const http = httpBase();
  return http.replace(/^http/, "ws") + "/ws/gateway";
}
