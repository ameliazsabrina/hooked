import { ReactionLog } from "../db/schema.js";

export type ReactionOutcome =
  | "hit"
  | "escaped_no_tap"
  | "escaped_miss"
  | "cancelled";

export interface ReactionLogEntry {
  wallet: string;
  clientCastId: string;
  sessionPda: string | null;
  nibbleDelayMs: number;
  reactionTimeMs: number | null;
  preNibbleTapCount: number;
  sampleJitterMaxMs: number | null;
  outcome: ReactionOutcome;
  rarity: number | null;
  speciesId: number | null;
}

// Fire-and-forget. Telemetry must never block the cast resolution path; if
// Mongo is degraded we'd rather drop a log than stall the player's UI.
export function recordReactionLog(entry: ReactionLogEntry): void {
  ReactionLog.create(entry).catch((err) => {
    console.warn("[reactionLog] failed to persist:", (err as Error).message);
  });
}

// Largest gap between consecutive input_samples in ms. Bot-driven inputs
// often produce near-zero jitter (uniform spacing) or wildly uneven gaps
// where a real player's hand wouldn't.
export function computeSampleJitterMaxMs(
  samples: ReadonlyArray<{ t_ms: number }>,
): number | null {
  if (samples.length < 2) return null;
  let max = 0;
  for (let i = 1; i < samples.length; i++) {
    const dt = samples[i].t_ms - samples[i - 1].t_ms;
    if (dt > max) max = dt;
  }
  return max;
}
