export type ClientMessage =
  | AuthenticateMessage
  | CastInitiateMessage
  | NibbleResponseMessage
  | InputSamplesMessage
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
  // When present, `signature` is the nonce signed by the delegated session
  // key; server verifies delegation.signature against the wallet once.
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

// Acks the cast. The on-chain initiate_cast has already committed
// (bait spent, fish rolled); the server is now silently holding the
// nibble timer.
export interface CastAcceptedMessage {
  type: "cast_accepted";
  sessionId: string;
  clientCastId: string;
  castTimestamp: number;
}

// Server-determined "fish is biting" signal. `serverTs` is the gateway's wall
// clock at the moment of emission and is the reference for reaction-time
// validation: a nibble_response with `clientTs` outside [serverTs, serverTs+2000]
// is treated as an escape (or, if before, a pre-nibble tap and silently
// ignored).
export interface NibbleEventMessage {
  type: "nibble_event";
  sessionId: string;
  clientCastId: string;
  serverTs: number;
}

// Player tap during the 2s reaction window. The client sends its own clock
// for cheat telemetry; the server validates against its own `nibbleSentAt`
// and never trusts the client value for window admission.
export interface NibbleResponseMessage {
  type: "nibble_response";
  sessionId: string;
  clientCastId: string;
  clientTs: number;
}

// Server tells the client the fish has escaped (no tap in 2s window, or a
// pre-nibble tap that the server chose to surface). Bait stays consumed.
// Distinguished from catch_resolved so the client can play a line-slack /
// "got away" anim before transitioning back to idle.
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
  final?: boolean;
}

export interface FishHookedMessage {
  type: "fish_hooked";
  sessionId: string;
  clientCastId: string;
  /** SPECIES_TABLE index for non-apex casts; -1 when apex rolled. */
  speciesId: number;
  /** ApexFish ObjectId (24-char hex) when apex rolled; null otherwise. */
  apexFishId: string | null;
  /**
   * Public asset URL for apex catches (admin-uploaded image). Null for
   * non-apex casts; the client renders those from the static FISH_SPECIES
   * table lookup keyed on `speciesId`.
   */
  apexAssetUrl: string | null;
  /** Display name (FISH_SPECIES for non-apex, ApexFish.name for apex). */
  speciesName: string;
  rarity: number;
  mechanic: number;
  greenZoneStart: number;
  greenZoneWidth: number;
  weightHg: number;
  castTimestamp: number;
  // Same RNG seed the server uses for fish motion so client visuals match resolution.
  rngSeed: number;
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

// Server→client push when sessionLifecycle issues fresh bait at window rotation.
// Lets the HUD update without the client having to poll or re-run sessionState.
export interface BaitRefilledMessage {
  type: "bait_refilled";
  bait: number;
  window: number;
  date: number;
}

/**
 * One tap as the renderer recorded it. `msSinceTapStart` is the per-tap-local
 * elapsed time (the renderer resets its tap clock each time it advances), so
 * the server can replay the spinner physics without needing absolute clocks
 * or RTT correction.
 */
export interface CircularTapInputMsg {
  tapIndex: number;
  msSinceTapStart: number;
}

// Client sends this once the circular-tap phase has completed (whether
// every tap landed or not). The server replays the taps through its own
// spinner physics — the boolean outcome is server-authoritative; the
// client cannot win the encounter by lying about hits. On a server-verified
// pass the server then chains into the timing-bar second phase (physics,
// safety-timeout, resolution path) for Legendary/Apex casts.
export interface CircularTapCompleteMessage {
  type: "circular_tap_complete";
  sessionId: string;
  clientCastId: string;
  /** Submission order matters; index 0 = first tap of the encounter. */
  taps: CircularTapInputMsg[];
}

// Server→client push when the active event transitions (or on initial auth).
// `active=false` clears any active-event UI. `name` is empty when inactive
// so the client doesn't need a separate null check; `apexFishes` carries
// each apex fish's id + name + asset URL so HUD banners and announcement
// modals can render the active pool without re-querying.
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
