export type ClientMessage =
  | AuthenticateMessage
  | CastInitiateMessage
  | NibbleResponseMessage
  | InputSamplesMessage
  | CastFinalizeMessage
  | CircularTapCompleteMessage
  | PingMessage;

export type ServerMessage =
  | AuthenticatedMessage
  | AuthFailedMessage
  | CastAcceptedMessage
  | NibbleEventMessage
  | FishEscapedMessage
  | FishHookedMessage
  | FishingStateMessage
  | DesyncCorrectionMessage
  | CatchResolvedMessage
  | LeaderboardUpdateMessage
  | BaitRefilledMessage
  | EventStatusMessage
  | ErrorMessage
  | PongMessage;

export interface WsDelegation {
  wallet: string;
  sessionPubkey: string;
  expiresAt: number;
  message: string;
  signature: string;
}

export interface AuthenticateMessage {
  type: "authenticate";
  wallet: string;
  nonce: string;
  signature: string;
  // If present, `signature` is signed by the delegated session key.
  delegation?: WsDelegation;
}

export interface AuthenticatedMessage {
  type: "authenticated";
  wallet: string;
  sessionPda?: string;
}

export interface AuthFailedMessage {
  type: "auth_failed";
  reason: string;
}

export interface CastInitiateMessage {
  type: "cast_initiate";
  power: number;
  clientCastId: string;
}

export interface CastAcceptedMessage {
  type: "cast_accepted";
  sessionId: string;
  clientCastId: string;
  castTimestamp: number;
}

// `serverTs` is authoritative for reaction-time validation; clientTs is
// recorded for cheat telemetry only.
export interface NibbleEventMessage {
  type: "nibble_event";
  sessionId: string;
  clientCastId: string;
  serverTs: number;
}

export interface NibbleResponseMessage {
  type: "nibble_response";
  sessionId: string;
  clientCastId: string;
  clientTs: number;
}

// Distinguished from catch_resolved so the client can play a line-slack anim.
export interface FishEscapedMessage {
  type: "fish_escaped";
  sessionId: string;
  clientCastId: string;
  reason: "no_tap" | "early_tap";
}

export interface InputSample {
  held: boolean;
  index: number;
  t_ms: number;
}

export interface InputSamplesMessage {
  type: "input_samples";
  sessionId: string;
  clientCastId: string;
  samples: InputSample[];
}

/**
 * Verdict claim separated from input_samples — prevents phantom
 * input-history transitions from retried "final" messages. Server-side
 * floor check is authoritative; client state is not trusted.
 */
export interface CastFinalizeMessage {
  type: "cast_finalize";
  sessionId: string;
  clientCastId: string;
}

export interface FishHookedMessage {
  type: "fish_hooked";
  sessionId: string;
  clientCastId: string;
  /** SPECIES_TABLE index for non-apex casts; -1 when apex rolled. */
  speciesId: number;
  /** ApexFish ObjectId (24-char hex) when apex rolled; null otherwise. */
  apexFishId: string | null;
  /** Null for non-apex (client renders from FISH_SPECIES by speciesId). */
  apexAssetUrl: string | null;
  speciesName: string;
  rarity: number;
  mechanic: number;
  greenZoneStart: number;
  greenZoneWidth: number;
  weightHg: number;
  castTimestamp: number;
  /** Same seed the server uses, so client visuals match resolution. */
  rngSeed: number;
  /**
   * Adaptive lag-comp buffer (ms) the server chose for this cast based on the
   * socket's measured network jitter. The client MUST step its local physics
   * to `wallSinceOrigin - inputDelayMs/1000` with this exact value so its
   * simulation tracks the server's. Falls back to INPUT_DELAY_MS if absent.
   */
  inputDelayMs: number;
}

export interface FishingStateMessage {
  type: "fishing_state";
  sessionId: string;
  clientCastId: string;
  barY: number;
  fishY: number;
  progress: number;
  tickIndex: number;
}

export interface DesyncCorrectionMessage {
  type: "desync_correction";
  sessionId: string;
  clientCastId: string;
  barY: number;
  fishY: number;
  progress: number;
  tickIndex: number;
}

export interface CatchResolvedMessage {
  type: "catch_resolved";
  sessionId: string;
  clientCastId: string;
  hit: boolean;
  /** SPECIES_TABLE index for non-apex catches; -1 when apex was resolved. */
  speciesId: number;
  apexFishId: string | null;
  apexAssetUrl: string | null;
  speciesName: string;
  rarity: number;
  weightHg: number;
  score: number;
  roomId?: string;
}

export interface LeaderboardUpdateMessage {
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

export interface BaitRefilledMessage {
  type: "bait_refilled";
  bait: number;
  window: number;
  date: number;
}

/** msSinceTapStart resets per tap so the server can replay without RTT correction. */
export interface CircularTapInputMsg {
  tapIndex: number;
  msSinceTapStart: number;
}

// Server replays taps through its own spinner physics — verdict is
// server-authoritative.
export interface CircularTapCompleteMessage {
  type: "circular_tap_complete";
  sessionId: string;
  clientCastId: string;
  /** Submission order matters; index 0 = first tap of the encounter. */
  taps: CircularTapInputMsg[];
}

export interface EventStatusApexFish {
  id: string;
  name: string;
  weightMinKg: number;
  weightMaxKg: number;
  assetUrl: string;
}

export interface EventStatusMessage {
  type: "event_status";
  active: boolean;
  name: string;
  startsAt: number;
  endsAt: number;
  apexBp: number;
  prizePoolSol: number;
  apexFishes: EventStatusApexFish[];
}

export interface PingMessage {
  type: "ping";
  t: number;
}

export interface PongMessage {
  type: "pong";
  t: number;
}

export interface ErrorMessage {
  type: "error";
  code: string;
  message: string;
}
