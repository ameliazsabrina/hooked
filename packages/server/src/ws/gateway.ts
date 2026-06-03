import fp from "fastify-plugin";
import websocket from "@fastify/websocket";
import type { FastifyReply, FastifyRequest } from "fastify";
import { PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { randomUUID } from "node:crypto";
import "../plugins/redis.js";
import { isAllowedOrigin } from "../config/env.js";
import {
  executeAbandonOnDisconnectOffchain,
  executeCancelOnDisconnectOffchain,
  executeInitiateCastOffchain,
  executeSubmitResolveOffchain,
  type RolledCast,
} from "../services/fishing/wsExecutor.js";
import { CastEngineError } from "../services/fishing/errors.js";
import { computeCatchScore } from "../services/fishing/scoring.js";
import type { Rarity } from "../services/fishing/types.js";
import {
  getActiveEvent,
  getEventStatus,
  onEventChange,
  startEventPolling,
  type EventStatus,
} from "../services/eventConfig.js";
import type { ClientMessage, ServerMessage, InputSample } from "./protocol.js";
import { ClientMessageSchema } from "./schemas.js";
import {
  getTerminal,
  markEscaped,
  markInFlight,
  markResolved,
} from "./idempotency.js";
import {
  recordReactionLog,
  computeSampleJitterMaxMs,
  type ReactionOutcome,
} from "../services/reactionLog.js";
import type Redis from "ioredis";
import { Player } from "../db/schema.js";
import { creditCatch } from "../services/leaderboardCredit.js";
import { getRoomLeaderboard } from "../services/leaderboard.js";

// Captured at plugin boot so module-scope helpers (resolveCatch) can credit
// leaderboards without threading the fastify instance through every call site.
let redisRef: Redis | null = null;

async function loadEquippedBaitSlug(wallet: PublicKey): Promise<string> {
  try {
    const player = await Player.findOne(
      { walletAddress: wallet.toBase58() },
      { "equipment.baitEquipped": 1 },
    ).lean();
    return player?.equipment?.baitEquipped ?? "fly";
  } catch (err) {
    console.warn(
      "[gateway] failed to load equipped bait, defaulting to fly:",
      (err as Error).message,
    );
    return "fly";
  }
}

// Server MUST use the same rodTier as client — green-bar height scales per
// tier (10px each), and a mismatch makes the in-bar predicate disagree so
// progress diverges. Symptom: client bar fills, server resolves as escape.
async function loadEquippedRodTier(wallet: PublicKey): Promise<number> {
  try {
    const player = await Player.findOne(
      { walletAddress: wallet.toBase58() },
      { "equipment.rodTier": 1 },
    ).lean();
    return player?.equipment?.rodTier ?? 0;
  } catch (err) {
    console.warn(
      "[gateway] failed to load equipped rod, defaulting to tier 0:",
      (err as Error).message,
    );
    return 0;
  }
}
import {
  BAR_MAX_Y,
  FishRarity,
  INPUT_DELAY_MS,
  INPUT_DELAY_S,
  INPUT_DELAY_MAX_MS,
  INPUT_DELAY_MARGIN_MS,
  PHYSICS_FIXED_DT,
  PHYSICS_MAX_STEP_ACCUM,
  buildDifficultyProfile,
  buildCircularTapState,
  buildLegendaryVerticalProfile,
  computeModifiers,
  initialFishingGameState,
  lookupActiveInput,
  resolveGreenBarHeight,
  stepAll,
  terminalState,
  validateCircularTapTaps,
  type CircularProfile,
  type FishingGameState,
  type TimedInput,
  type VerticalProfile,
} from "@hooked/shared";

type MinimalWebSocket = {
  readyState: number;
  OPEN: number;
  send: (data: string) => void;
  on: (event: "message" | "close", handler: (data: Buffer) => void) => void;
};

interface SessionContext {
  wallet: PublicKey | null;
  sessionPda: string | null;
  activeCastId: string | null;
  castStartedAt: number;
  speciesId: number;
  /** Set when the rolled cast was Apex; otherwise null. */
  apexFishId: string | null;
  apexAssetUrl: string | null;
  speciesName: string;
  rarity: number;
  mechanic: number;
  weightHg: number;
  // Deferred fish_hooked payload — emitted after nibble timer fires and the
  // player taps to hook.
  pendingHookPayload: Extract<ServerMessage, { type: "fish_hooked" }> | null;
  samples: InputSample[];
  heldLatest: boolean;
  physicsStarted: boolean;
  lastTickAt: number;
  // Fixed-timestep accumulator (seconds). Both sides MUST step at
  // PHYSICS_FIXED_DT or the shared mulberry32 RNG state diverges.
  physicsAccumS: number;
  // Lag-comp: first input sample's `t_ms` defines simTimeS=0. Both sides
  // step physics up to (wallNow - physicsServerOriginMs)/1000 - INPUT_DELAY_S,
  // looking up the input active at each step's simTimeS so the bar trajectory
  // is deterministic modulo the clock-skew offset baked into origin.
  physicsClientOriginMs: number | null;
  physicsServerOriginMs: number;
  simTimeS: number;
  inputHistory: TimedInput[];
  inputCursor: number;
  profile: VerticalProfile;
  greenBarHeight: number;
  game: FishingGameState;
  // Server-determined nibble delay (fixed 3000ms). Validating nibble_response
  // against nibbleSentAt gates entry to the input mechanic.
  nibbleDelayMs: number;
  nibbleTimer: ReturnType<typeof setTimeout> | null;
  nibbleSentAt: number | null;
  reactionTimer: ReturnType<typeof setTimeout> | null;
  reactionTimeMs: number | null;
  preNibbleTapCount: number;
  // True after a valid nibble_response. Until then input_samples are rejected.
  hooked: boolean;
  // Server-authoritative spinner state — lets validateCircularTapTaps replay
  // client-reported taps without trusting any wire boolean (C-1 fix).
  circularTap: {
    profile: CircularProfile;
    targets: number[];
  } | null;
  secondaryVerticalProfile: VerticalProfile | null;
  rngSeed: number;
  rodTier: number;

  rejectedFinalCount: number;
  desyncDetectedAt: number | null;
  clampedCount: number;
  maxClampMs: number;
  peakProgress: number;
  // Adaptive lag-comp buffer (seconds) chosen for THIS cast at hook time and
  // shipped to the client. advancePhysics steps to wall - inputDelayS using
  // this instead of the static INPUT_DELAY_S so both sides stay aligned.
  inputDelayS: number;
}

const NIBBLE_DELAY_MS = 3000;
const REACTION_WINDOW_MS = 2000;
// 2 trades a small false-positive risk for ~500ms-of-disagreement recovery
// at the client's 250ms retry cadence.
const DESYNC_REJECT_THRESHOLD = 2;
// After divergence is declared, resolve within this window rather than
// running the full 30s SAFETY_TIMEOUT_MS.
const DESYNC_TIMEOUT_MS = 5000;

function rollNibbleDelayMs(): number {
  return NIBBLE_DELAY_MS;
}

function clearCastTimers(ctx: SessionContext): void {
  if (ctx.nibbleTimer) {
    clearTimeout(ctx.nibbleTimer);
    ctx.nibbleTimer = null;
  }
  if (ctx.reactionTimer) {
    clearTimeout(ctx.reactionTimer);
    ctx.reactionTimer = null;
  }
}

const TIMING_BAR_MECHANIC = 0;
const CIRCULAR_TAP_MECHANIC = 1;

interface Socket {
  id: string;
  raw: MinimalWebSocket;
  wallet: PublicKey | null;
  session: SessionContext | null;
  roomId: string | null;
  send: (m: ServerMessage) => void;
  // Adaptive lag-comp telemetry, persisted across casts on this connection.
  // netMinOffsetMs ≈ (clock skew + best-case one-way latency); subtracting it
  // from each sample's (arrival - t_ms) cancels the skew and yields the live
  // network jitter we must buffer. netJitterMs is a decaying max so a single
  // spike raises the buffer then relaxes.
  netMinOffsetMs: number | null;
  netJitterMs: number;
}

// Decay applied to the per-socket jitter max on every observed sample so the
// buffer shrinks back toward the floor once a latency spike passes.
const NET_JITTER_DECAY = 0.97;

// Pick the lag-comp buffer for a cast from the socket's observed jitter,
// clamped to [INPUT_DELAY_MS, INPUT_DELAY_MAX_MS]. First cast on a fresh
// connection has no samples yet → floor.
function computeAdaptiveDelayMs(socket: Socket): number {
  const candidate = Math.ceil(socket.netJitterMs) + INPUT_DELAY_MARGIN_MS;
  return Math.min(INPUT_DELAY_MAX_MS, Math.max(INPUT_DELAY_MS, candidate));
}

const sockets = new Map<string, Socket>();
const socketsByWallet = new Map<string, Set<string>>();

// Nonce store lives in Redis, not process memory: the WS upgrade and the
// preceding /ws/claim-nonce HTTP call may land on different Fly machines
// when min_machines_running > 1 or during rolling deploys. In-memory state
// produced split-brain "unknown or expired nonce" failures and triggered
// the client's auth_failed → re-sign → loop.
const NONCE_TTL_MS = 2 * 60 * 1000;

function nonceRedisKey(wallet: string, nonce: string): string {
  return `ws:nonce:${wallet}:${nonce}`;
}

async function registerNonce(wallet: string, nonce: string): Promise<void> {
  if (!redisRef) throw new Error("[gateway] redis not initialized");
  await redisRef.set(nonceRedisKey(wallet, nonce), "1", "PX", NONCE_TTL_MS);
}

async function consumeNonce(wallet: string, nonce: string): Promise<boolean> {
  if (!redisRef) return false;
  // GETDEL is atomic in Redis 6.2+: exactly one consumer wins, no
  // races between competing WS upgrades reusing the same nonce.
  const value = await redisRef.getdel(nonceRedisKey(wallet, nonce));
  return value === "1";
}

function verifySignature(
  walletBase58: string,
  nonce: string,
  signatureBase58: string,
): boolean {
  try {
    const wallet = new PublicKey(walletBase58);
    const sigBytes = bs58.decode(signatureBase58);
    const msgBytes = Buffer.from(`Hooked Auth Nonce: ${nonce}`, "utf8");
    return nacl.sign.detached.verify(msgBytes, sigBytes, wallet.toBytes());
  } catch {
    return false;
  }
}

function verifyDelegation(
  walletBase58: string,
  delegation: import("./protocol.js").WsDelegation,
): boolean {
  try {
    if (delegation.wallet !== walletBase58) return false;
    if (delegation.expiresAt < Date.now()) return false;
    const expectedMessage = [
      "Hooked WS Session Delegation",
      `wallet: ${delegation.wallet}`,
      `session: ${delegation.sessionPubkey}`,
      `expires: ${delegation.expiresAt}`,
    ].join("\n");
    if (delegation.message !== expectedMessage) return false;
    new PublicKey(delegation.sessionPubkey);
    const wallet = new PublicKey(delegation.wallet);
    const sigBytes = bs58.decode(delegation.signature);
    const msgBytes = Buffer.from(delegation.message, "utf8");
    return nacl.sign.detached.verify(msgBytes, sigBytes, wallet.toBytes());
  } catch {
    return false;
  }
}

function verifySessionKeyNonce(
  sessionPubkeyBase58: string,
  nonce: string,
  signatureBase58: string,
): boolean {
  try {
    const sessionPub = bs58.decode(sessionPubkeyBase58);
    const sigBytes = bs58.decode(signatureBase58);
    const msgBytes = Buffer.from(`Hooked Auth Nonce: ${nonce}`, "utf8");
    return nacl.sign.detached.verify(msgBytes, sigBytes, sessionPub);
  } catch {
    return false;
  }
}

function safeSend(socket: Socket, msg: ServerMessage): void {
  if (socket.raw.readyState === socket.raw.OPEN) {
    socket.raw.send(JSON.stringify(msg));
  }
}

// Replay the terminal outcome of an already-seen cast: resolved/escaped resend
// the cached frame, in-flight drops silently. Returns true if handled.
function replayTerminal(socket: Socket, clientCastId: string): boolean {
  const wallet = socket.wallet?.toBase58();
  if (!wallet) return false;
  const terminal = getTerminal(wallet, clientCastId);
  if (!terminal) return false;
  if (terminal.status === "resolved" || terminal.status === "escaped") {
    safeSend(socket, terminal.msg);
  }
  return true;
}

function addWalletSocket(wallet: string, id: string): void {
  let set = socketsByWallet.get(wallet);
  if (!set) {
    set = new Set();
    socketsByWallet.set(wallet, set);
  }
  set.add(id);
}

function removeWalletSocket(wallet: string, id: string): void {
  const set = socketsByWallet.get(wallet);
  if (!set) return;
  set.delete(id);
  if (set.size === 0) socketsByWallet.delete(wallet);
}

export function broadcastToRoom(
  roomId: string | null,
  msg: ServerMessage,
): void {
  for (const s of sockets.values()) {
    if (s.roomId === roomId) safeSend(s, msg);
  }
}

export function broadcastToWallet(wallet: string, msg: ServerMessage): void {
  const set = socketsByWallet.get(wallet);
  if (!set) return;
  for (const id of set) {
    const s = sockets.get(id);
    if (s) safeSend(s, msg);
  }
}

// Updates room binding for open sockets when the HTTP-side recoverEntry
// admits a player — avoids forcing a reconnect.
export function bindWalletToRoom(walletAddress: string, roomId: string): void {
  const set = socketsByWallet.get(walletAddress);
  if (!set) return;
  for (const id of set) {
    const s = sockets.get(id);
    if (s) s.roomId = roomId;
  }
}

// Runs async after auth so the `authenticated` reply isn't blocked on Mongo.
async function hydrateRoomBindingForSocket(
  socketId: string,
  walletAddress: string,
): Promise<void> {
  try {
    const player = await Player.findOne(
      { walletAddress },
      { deposits: 1 },
    ).lean();
    const active = player?.deposits?.find((d) => !d.returned);
    if (!active?.poolId) return;
    const s = sockets.get(socketId);
    if (!s) return;
    s.roomId = active.poolId;
  } catch (err) {
    console.warn(
      "[gateway] hydrateRoomBindingForSocket failed:",
      (err as Error).message,
    );
  }
}

// Per-room debounce: 250ms feels real-time and absorbs ~7 catches at 30Hz.
const lbBroadcastTimers = new Map<string, NodeJS.Timeout>();
const LB_BROADCAST_DEBOUNCE_MS = 250;

export function scheduleLeaderboardBroadcast(roomId: string): void {
  const existing = lbBroadcastTimers.get(roomId);
  if (existing) clearTimeout(existing);
  lbBroadcastTimers.set(
    roomId,
    setTimeout(() => {
      lbBroadcastTimers.delete(roomId);
      void emitRoomLeaderboard(roomId);
    }, LB_BROADCAST_DEBOUNCE_MS),
  );
}

async function emitRoomLeaderboard(roomId: string): Promise<void> {
  if (!redisRef) return;
  try {
    const entries = await getRoomLeaderboard(redisRef, roomId, 0, 50);
    if (entries.length === 0) return;
    const memberIds = entries.map((e) => e.member);
    const players = await Player.find(
      { _id: { $in: memberIds } },
      { _id: 1, nickname: 1, walletAddress: 1 },
    ).lean();
    const playerMap = new Map(players.map((p) => [p._id.toString(), p]));
    const date = new Date().toISOString().slice(0, 10);
    broadcastToRoom(roomId, {
      type: "leaderboard_update",
      roomId,
      date,
      entries: entries.map((e) => {
        const p = playerMap.get(e.member);
        return {
          wallet: p?.walletAddress ?? e.member,
          displayName: p?.nickname ?? "Anonymous",
          score: e.score,
          // Wire stability: catchCount not tracked in the score sorted set yet.
          catchCount: 0,
        };
      }),
    });
  } catch (err) {
    console.error(
      "[gateway] emitRoomLeaderboard failed:",
      (err as Error).message,
    );
  }
}

function eventStatusMessage(status: EventStatus | null): ServerMessage {
  if (!status) {
    return {
      type: "event_status",
      active: false,
      name: "",
      startsAt: 0,
      endsAt: 0,
      apexBp: 0,
      prizePoolSol: 0,
      apexFishes: [],
    };
  }
  // Self-healing: an expired event reads as inactive even if the lifecycle
  // worker hasn't flipped the flag — wire state matches what cast roll uses.
  const live = getActiveEvent();
  if (!live) {
    return {
      type: "event_status",
      active: false,
      name: status.name,
      startsAt: status.startsAt,
      endsAt: status.endsAt,
      apexBp: 0,
      prizePoolSol: 0,
      apexFishes: [],
    };
  }
  return {
    type: "event_status",
    active: true,
    name: live.name,
    startsAt: live.startsAt,
    endsAt: live.endsAt,
    apexBp: live.apexBp,
    prizePoolSol: live.prizePoolSol,
    apexFishes: live.apexFishes,
  };
}

function broadcastEventStatus(status: EventStatus | null): void {
  const msg = eventStatusMessage(status);
  for (const s of sockets.values()) safeSend(s, msg);
}

let eventCacheUnsubscribe: (() => void) | null = null;
function ensureEventCacheBound(): void {
  if (eventCacheUnsubscribe) return;
  eventCacheUnsubscribe = onEventChange((status) =>
    broadcastEventStatus(status),
  );
  void getEventStatus(true).catch(() => {});
  startEventPolling();
}

// LAG-COMP MODEL. Bar physics depends on input timing; running against
// `heldLatest` drifts trajectory by the network jitter on each transition.
// Instead we replay inputs at client-stamped simTime:
//   simTimeS(sample) = (sample.t_ms - physicsClientOriginMs) / 1000
//   server steps physics up to (now - physicsServerOriginMs)/1000 - INPUT_DELAY_S
// INPUT_DELAY_S buffers behind wallclock so most samples land before their
// step is processed — late samples (RTT/2 > INPUT_DELAY) are dropped.

const PHYSICS_TICK_MS = 33;

function advancePhysics(ctx: SessionContext, now: number): void {
  if (!ctx.physicsStarted) return;
  if (ctx.physicsClientOriginMs === null) return;
  const wallSinceOriginS = (now - ctx.physicsServerOriginMs) / 1000;
  const targetSimTimeS = wallSinceOriginS - ctx.inputDelayS;
  // Clamp forward sprint per wall-tick (covers GC pauses).
  const maxAdvance = ctx.simTimeS + PHYSICS_MAX_STEP_ACCUM;
  const stepUpTo = Math.min(targetSimTimeS, maxAdvance);
  while (ctx.simTimeS + PHYSICS_FIXED_DT <= stepUpTo) {
    const lookup = lookupActiveInput(
      ctx.inputHistory,
      ctx.simTimeS,
      ctx.inputCursor,
      false,
    );
    ctx.inputCursor = lookup.cursor;
    stepAll(
      ctx.game,
      ctx.profile,
      ctx.greenBarHeight,
      lookup.held,
      PHYSICS_FIXED_DT,
    );
    ctx.simTimeS += PHYSICS_FIXED_DT;
    if (ctx.game.progress > ctx.peakProgress) {
      ctx.peakProgress = ctx.game.progress;
    }
  }
}

// Pre-nibble disconnect refund. Best-effort — keeper cleans up stale pending
// casts if the rollback fails.
async function cancelCastOnDisconnect(
  socket: Socket,
  ctx: SessionContext,
): Promise<void> {
  if (!ctx.sessionPda) return;
  await executeCancelOnDisconnectOffchain(ctx.sessionPda);
  if (socket.wallet) {
    recordReactionLog({
      wallet: socket.wallet.toBase58(),
      clientCastId: ctx.activeCastId ?? "",
      sessionPda: ctx.sessionPda,
      nibbleDelayMs: ctx.nibbleDelayMs,
      reactionTimeMs: null,
      preNibbleTapCount: ctx.preNibbleTapCount,
      sampleJitterMaxMs: null,
      outcome: "cancelled",
      rarity: ctx.rarity,
      speciesId: ctx.speciesId,
    });
  }
  if (socket.wallet && ctx.activeCastId) {
    markEscaped(socket.wallet.toBase58(), ctx.activeCastId, {
      type: "fish_escaped",
      sessionId: ctx.sessionPda ?? "",
      clientCastId: ctx.activeCastId,
      reason: "no_tap",
    });
  }
}

// Mid-reel disconnect refund. Uses ABANDON_CAST_GRACE_SECS so a single blip
// doesn't burn a bait. Force-disconnect-to-re-roll cheats are bounded by the
// grace window and surfaced in the reaction log.
async function abandonCastOnDisconnect(
  socket: Socket,
  ctx: SessionContext,
): Promise<void> {
  if (!ctx.sessionPda) return;
  const { refunded } = await executeAbandonOnDisconnectOffchain(ctx.sessionPda);
  if (socket.wallet) {
    recordReactionLog({
      wallet: socket.wallet.toBase58(),
      clientCastId: ctx.activeCastId ?? "",
      sessionPda: ctx.sessionPda,
      nibbleDelayMs: ctx.nibbleDelayMs,
      reactionTimeMs: ctx.reactionTimeMs,
      preNibbleTapCount: ctx.preNibbleTapCount,
      sampleJitterMaxMs: computeSampleJitterMaxMs(ctx.samples),
      // Distinguishes "network blip" from "force-disconnect cheat attempt
      // past the grace window" in the audit pipeline.
      outcome: refunded ? "cancelled" : "escaped_miss",
      rarity: ctx.rarity,
      speciesId: ctx.speciesId,
    });
  }
  if (socket.wallet && ctx.activeCastId) {
    markEscaped(socket.wallet.toBase58(), ctx.activeCastId, {
      type: "fish_escaped",
      sessionId: ctx.sessionPda ?? "",
      clientCastId: ctx.activeCastId,
      reason: "no_tap",
    });
  }
}

// Idempotent against late cancels (a disconnect that races the timer leaves
// activeCastId null).
function fireNibble(socket: Socket, clientCastId: string): void {
  const ctx = socket.session;
  if (!ctx || ctx.activeCastId !== clientCastId) return;
  ctx.nibbleTimer = null;
  ctx.nibbleSentAt = Date.now();
  safeSend(socket, {
    type: "nibble_event",
    sessionId: ctx.sessionPda ?? "",
    clientCastId,
    serverTs: ctx.nibbleSentAt,
  });
  ctx.reactionTimer = setTimeout(() => {
    handleReactionTimeout(socket, clientCastId);
  }, REACTION_WINDOW_MS);
}

// 2s without nibble_response → escape. Missed reactions still cost a bait.
function handleReactionTimeout(socket: Socket, clientCastId: string): void {
  const ctx = socket.session;
  if (!ctx || ctx.activeCastId !== clientCastId) return;
  ctx.reactionTimer = null;
  safeSend(socket, {
    type: "fish_escaped",
    sessionId: ctx.sessionPda ?? "",
    clientCastId,
    reason: "no_tap",
  });
  resolveCatch(socket, false, "escaped_no_tap");
}

// Server clock is authoritative for the reaction window; clientTs is logged
// but never trusted for admission.
function handleNibbleResponse(
  socket: Socket,
  clientCastId: string,
  clientTs: number,
): void {
  const ctx = socket.session;
  if (!ctx || ctx.activeCastId !== clientCastId) return;
  if (ctx.hooked) return;
  if (ctx.nibbleSentAt === null) {
    // Pre-nibble tap: count for cheat telemetry and ignore.
    ctx.preNibbleTapCount += 1;
    return;
  }
  const elapsed = Date.now() - ctx.nibbleSentAt;
  if (elapsed > REACTION_WINDOW_MS) {
    // Reaction timer handles the escape; don't double-resolve.
    return;
  }
  if (ctx.reactionTimer) {
    clearTimeout(ctx.reactionTimer);
    ctx.reactionTimer = null;
  }
  ctx.reactionTimeMs = elapsed;
  // clientTs is recorded for offline drift analysis only.
  void clientTs;
  ctx.hooked = true;
  if (ctx.pendingHookPayload) {
    // Lock in the lag-comp buffer from the freshest jitter estimate (built up
    // over prior casts / keep-alives on this socket) and tell the client the
    // exact value so its local physics steps to the same simTime.
    const inputDelayMs = computeAdaptiveDelayMs(socket);
    ctx.inputDelayS = inputDelayMs / 1000;
    ctx.pendingHookPayload.inputDelayMs = inputDelayMs;
    safeSend(socket, ctx.pendingHookPayload);
    ctx.pendingHookPayload = null;
  }
}

function resolveCatch(
  socket: Socket,
  hit: boolean,
  outcomeOverride?: ReactionOutcome,
): void {
  const ctx = socket.session;
  if (!ctx || !ctx.activeCastId) return;
  // Clear slot before async work so a follow-up cast can start while the
  // ER CPI + fetch are in flight.
  const activeCastId = ctx.activeCastId;
  const sessionIdStr = ctx.sessionPda ?? "";
  const speciesId = ctx.speciesId;
  const apexFishId = ctx.apexFishId;
  const apexAssetUrl = ctx.apexAssetUrl;
  const speciesName = ctx.speciesName;
  const rarity = ctx.rarity;
  const weightHg = hit ? ctx.weightHg : 0;
  // Wire score == persisted score (same inputs as submitInputSamples), so
  // we can deliver catch_resolved immediately and persist in the background.
  const score = computeCatchScore(rarity as Rarity, weightHg);
  const roomId = socket.roomId;

  // Snapshot reaction telemetry before wiping the slot so the async log
  // write sees consistent data even if a follow-up cast races in.
  const reactionSnapshot = {
    sessionPda: ctx.sessionPda,
    nibbleDelayMs: ctx.nibbleDelayMs,
    reactionTimeMs: ctx.reactionTimeMs,
    preNibbleTapCount: ctx.preNibbleTapCount,
    sampleJitterMaxMs: computeSampleJitterMaxMs(ctx.samples),
    rarity: ctx.rarity,
    speciesId: ctx.speciesId,
    samplesCount: ctx.samples.length,
  };
  const outcome: ReactionOutcome =
    outcomeOverride ?? (hit ? "hit" : "escaped_miss");
  const walletStr = socket.wallet?.toBase58() ?? "";
  if (walletStr) {
    recordReactionLog({
      wallet: walletStr,
      clientCastId: activeCastId,
      sessionPda: reactionSnapshot.sessionPda,
      nibbleDelayMs: reactionSnapshot.nibbleDelayMs,
      reactionTimeMs: reactionSnapshot.reactionTimeMs,
      preNibbleTapCount: reactionSnapshot.preNibbleTapCount,
      sampleJitterMaxMs: reactionSnapshot.sampleJitterMaxMs,
      outcome,
      rarity: reactionSnapshot.rarity,
      speciesId: reactionSnapshot.speciesId,
    });
  }

  clearCastTimers(ctx);
  ctx.activeCastId = null;
  ctx.pendingHookPayload = null;
  ctx.samples = [];
  ctx.heldLatest = false;
  ctx.physicsStarted = false;
  ctx.physicsAccumS = 0;
  ctx.physicsClientOriginMs = null;
  ctx.physicsServerOriginMs = 0;
  ctx.simTimeS = 0;
  ctx.inputHistory = [];
  ctx.inputCursor = -1;
  ctx.hooked = false;
  ctx.nibbleSentAt = null;
  ctx.reactionTimeMs = null;
  ctx.preNibbleTapCount = 0;
  ctx.rejectedFinalCount = 0;
  ctx.desyncDetectedAt = null;
  ctx.clampedCount = 0;
  ctx.maxClampMs = 0;
  ctx.peakProgress = 0;
  ctx.inputDelayS = INPUT_DELAY_S;

  // Deliver on the tick — awaiting Mongo here added ~500-1500ms of dead air
  // between the bar filling and the catch popup. Persistence runs below.
  const resolvedMsg = {
    type: "catch_resolved" as const,
    sessionId: sessionIdStr,
    clientCastId: activeCastId,
    hit,
    speciesId,
    apexFishId,
    apexAssetUrl,
    speciesName,
    rarity,
    weightHg,
    score,
    roomId: roomId ?? undefined,
  };
  safeSend(socket, resolvedMsg);
  // Cache for retry replay + reconnect recovery.
  if (walletStr) markResolved(walletStr, activeCastId, resolvedMsg);

  if (!ctx.sessionPda) return;

  // Persistence runs after wire send. On failure the reaction log retains
  // the audit trail; the error log is loud enough for an ops alert.
  void (async () => {
    try {
      const res = await executeSubmitResolveOffchain(sessionIdStr, hit);
      // Credit leaderboards only on persisted hits — keeps Redis aligned with Mongo.
      if (hit && walletStr && redisRef && res && res.score > 0) {
        void creditCatch({
          redis: redisRef,
          walletAddress: walletStr,
          score: res.score,
          weightHg,
          rarity,
          speciesName,
          roomId: roomId ?? null,
        });
      }
    } catch (err) {
      console.error(
        `[gateway] persistence failed for delivered catch ` +
          `wallet=${walletStr} cast=${activeCastId} hit=${hit} ` +
          `score=${score} weightHg=${weightHg}:`,
        err,
      );
    }
  })();
}

const WS_MAX_PAYLOAD_BYTES = 64 * 1024;

const AUTH_RATE_LIMIT = {
  max: 30,
  timeWindow: "1 minute",
};

// CSWSH defense: pre-upgrade origin check. Missing Origin is allowed so
// non-browser callers (wscat/curl) still work.
async function rejectIfBadOrigin(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (!isAllowedOrigin(req.headers.origin)) {
    reply.code(403).send({ error: "origin not allowed" });
  }
}

export default fp(async (fastify) => {
  await fastify.register(websocket, {
    options: { maxPayload: WS_MAX_PAYLOAD_BYTES },
  });

  redisRef = fastify.redis;

  ensureEventCacheBound();

  fastify.get(
    "/ws/nonce",
    {
      config: { rateLimit: AUTH_RATE_LIMIT },
      preValidation: rejectIfBadOrigin,
    },
    async (_req, reply) => {
      const nonce = randomUUID();
      reply.send({
        nonce,
        message: `Hooked Auth Nonce: ${nonce}`,
        ttlMs: NONCE_TTL_MS,
      });
      return reply;
    },
  );

  fastify.post<{
    Body: { wallet: string; nonce: string };
  }>(
    "/ws/claim-nonce",
    {
      config: { rateLimit: AUTH_RATE_LIMIT },
      preValidation: rejectIfBadOrigin,
    },
    async (req, reply) => {
      const { wallet, nonce } = req.body ?? {};
      if (!wallet || !nonce) {
        reply.code(400).send({ error: "wallet + nonce required" });
        return reply;
      }
      try {
        new PublicKey(wallet);
      } catch {
        reply.code(400).send({ error: "invalid wallet" });
        return reply;
      }
      await registerNonce(wallet, nonce);
      reply.send({ ok: true });
      return reply;
    },
  );

  fastify.get(
    "/ws/gateway",
    { websocket: true, preValidation: rejectIfBadOrigin },
    (connection) => {
      const raw = connection as unknown as MinimalWebSocket;
      const socketId = randomUUID();
      const socket: Socket = {
        id: socketId,
        raw,
        wallet: null,
        session: null,
        roomId: null,
        send: (m) => safeSend({ ...socket, raw }, m),
        netMinOffsetMs: null,
        netJitterMs: 0,
      };
      sockets.set(socketId, socket);

      const physicsTimer = setInterval(() => {
        const ctx = socket.session;
        if (!ctx || !ctx.activeCastId) return;
        // Circular-tap casts resolve on the final input batch.
        if (ctx.mechanic !== TIMING_BAR_MECHANIC) return;
        const now = Date.now();
        advancePhysics(ctx, now);
        // Guard against spamming ~30 redundant "initial state" snapshots/sec
        // during the nibble window (sampleCount stays at 0 → 0%3===0 every tick).
        if (ctx.physicsStarted && ctx.game.sampleCount % 3 === 0) {
          safeSend(socket, {
            type: "fishing_state",
            sessionId: ctx.sessionPda ?? "",
            clientCastId: ctx.activeCastId,
            barY: ctx.game.barY,
            // SMOOTHED fish position — both server stepProgress and client
            // rendering use this same value to avoid fishY divergence.
            fishY: ctx.game.fishYDisplay,
            progress: ctx.game.progress,
            tickIndex: ctx.game.sampleCount,
          });
        }
        const terminalNow = terminalState(ctx.game, ctx.greenBarHeight);
        if (terminalNow !== null) {
          resolveCatch(socket, terminalNow === "caught");
          return;
        }
        const SAFETY_TIMEOUT_MS = 30_000;
        if (
          ctx.desyncDetectedAt !== null &&
          now - ctx.desyncDetectedAt > DESYNC_TIMEOUT_MS
        ) {
          resolveCatch(socket, false);
          return;
        }
        if (now - ctx.castStartedAt > SAFETY_TIMEOUT_MS) {
          resolveCatch(socket, false);
        }
      }, PHYSICS_TICK_MS);

      raw.on("message", async (data: Buffer) => {
        let parsedJson: unknown;
        try {
          parsedJson = JSON.parse(data.toString());
        } catch {
          safeSend(socket, {
            type: "error",
            code: "invalid_json",
            message: "invalid JSON",
          });
          return;
        }

        const validated = ClientMessageSchema.safeParse(parsedJson);
        if (!validated.success) {
          safeSend(socket, {
            type: "error",
            code: "invalid_message",
            message: validated.error.issues[0]?.message ?? "invalid message",
          });
          return;
        }
        const msg = validated.data as ClientMessage;

        switch (msg.type) {
          case "authenticate": {
            // TODO: drop diagnostic log once auth path is stable.
            const authFail = (reason: string) => {
              console.warn(
                `[gateway] auth_failed wallet=${msg.wallet?.slice(0, 8)}… reason=${reason} hasDelegation=${!!msg.delegation}`,
              );
              safeSend(socket, { type: "auth_failed", reason });
            };
            if (!(await consumeNonce(msg.wallet, msg.nonce))) {
              authFail("unknown or expired nonce");
              return;
            }
            if (msg.delegation) {
              if (!verifyDelegation(msg.wallet, msg.delegation)) {
                authFail("delegation verification failed");
                return;
              }
              if (
                !verifySessionKeyNonce(
                  msg.delegation.sessionPubkey,
                  msg.nonce,
                  msg.signature,
                )
              ) {
                authFail("session key signature verification failed");
                return;
              }
            } else if (!verifySignature(msg.wallet, msg.nonce, msg.signature)) {
              authFail("signature verification failed");
              return;
            }
            try {
              socket.wallet = new PublicKey(msg.wallet);
            } catch {
              authFail("invalid wallet pubkey");
              return;
            }
            addWalletSocket(msg.wallet, socketId);
            safeSend(socket, {
              type: "authenticated",
              wallet: msg.wallet,
            });
            void getEventStatus().then((status) =>
              safeSend(socket, eventStatusMessage(status)),
            );
            void hydrateRoomBindingForSocket(socketId, msg.wallet);
            // Reconnect recovery: replay the terminal outcome of the cast that
            // was in flight when the prior socket dropped, so a catch resolved
            // mid-disconnect isn't lost (and an escape isn't double-counted).
            if (msg.recoverCastId) {
              replayTerminal(socket, msg.recoverCastId);
            }
            return;
          }

          case "cast_initiate": {
            if (!socket.wallet) {
              safeSend(socket, {
                type: "error",
                code: "not_authenticated",
                message: "authenticate first",
              });
              return;
            }
            // A retried initiate for an already-resolved cast replays the result
            // instead of rolling a fresh fish.
            if (replayTerminal(socket, msg.clientCastId)) return;
            if (socket.session?.activeCastId) {
              safeSend(socket, {
                type: "error",
                code: "cast_pending",
                message: "resolve the current cast first",
              });
              return;
            }
            const wallet = socket.wallet;
            const clientCastId = msg.clientCastId;
            markInFlight(wallet.toBase58(), clientCastId);
            const startSession = (
              rolled: RolledCast,
              sessionPdaStr: string | null,
              baitSlug: string,
              rodTier: number,
            ) => {
              const castTimestamp = Date.now();
              const rarityForProfile =
                rolled.mechanic === TIMING_BAR_MECHANIC
                  ? rolled.rarityEnum
                  : // Circular-tap doesn't use vertical physics; placeholder.
                    FishRarity.Basic;
              const profile = buildDifficultyProfile(
                rarityForProfile,
                rolled.rngSeed,
                computeModifiers({
                  streak: 0,
                  poolTier: 0,
                  sessionElapsedMs: 0,
                }),
              ) as VerticalProfile;
              // Pre-computed spinner state lets gateway replay client taps
              // without trusting any wire boolean (C-1).
              const circularTap =
                rolled.mechanic === CIRCULAR_TAP_MECHANIC &&
                (rolled.rarityEnum === FishRarity.Legendary ||
                  rolled.rarityEnum === FishRarity.Apex)
                  ? buildCircularTapState(rolled.rarityEnum, 0)
                  : null;
              // Mirrors client's legendaryVerticalProfileRef so post-spinner
              // swap leaves both sides on the same chained difficulty.
              const secondaryVerticalProfile =
                rolled.mechanic === CIRCULAR_TAP_MECHANIC &&
                (rolled.rarityEnum === FishRarity.Legendary ||
                  rolled.rarityEnum === FishRarity.Apex)
                  ? buildLegendaryVerticalProfile(
                      rolled.rarityEnum,
                      rolled.rngSeed,
                      computeModifiers({
                        streak: 0,
                        poolTier: 0,
                        sessionElapsedMs: 0,
                      }),
                    )
                  : null;
              const greenBarHeight = resolveGreenBarHeight(profile, rodTier);
              const game = initialFishingGameState({
                sessionId: sessionPdaStr ?? "local",
                verticalProfile: profile,
                greenBarHeight,
                rodTier,
                luckyLureTier: 0,
                baitSlug,
                rngSeed: rolled.rngSeed,
                startingBarY: BAR_MAX_Y * 0.9,
                startingFishY: BAR_MAX_Y * 0.85,
                chestSpawned: false,
                chestY: 0,
                startedAt: castTimestamp,
              });
              const nibbleDelayMs = rollNibbleDelayMs();
              const pendingHookPayload: Extract<
                ServerMessage,
                { type: "fish_hooked" }
              > = {
                type: "fish_hooked",
                sessionId: sessionPdaStr ?? "",
                clientCastId,
                speciesId: rolled.speciesId,
                apexFishId: rolled.apexFishId,
                apexAssetUrl: rolled.apexAssetUrl,
                speciesName: rolled.speciesName,
                rarity: rolled.rarity,
                mechanic: rolled.mechanic,
                greenZoneStart: 0,
                greenZoneWidth: 0,
                weightHg: rolled.weightHg,
                castTimestamp,
                rngSeed: rolled.rngSeed,
                // Placeholder; re-stamped from the latest jitter estimate at
                // emit time (deliverPendingHook) so it reflects observed RTT.
                inputDelayMs: INPUT_DELAY_MS,
              };
              socket.session = {
                wallet,
                sessionPda: sessionPdaStr,
                activeCastId: clientCastId,
                castStartedAt: castTimestamp,
                speciesId: rolled.speciesId,
                apexFishId: rolled.apexFishId,
                apexAssetUrl: rolled.apexAssetUrl,
                speciesName: rolled.speciesName,
                rarity: rolled.rarity,
                mechanic: rolled.mechanic,
                weightHg: rolled.weightHg,
                pendingHookPayload,
                samples: [],
                heldLatest: false,
                // Physics starts on first input_sample (after fish_hooked).
                physicsStarted: false,
                lastTickAt: castTimestamp,
                physicsAccumS: 0,
                physicsClientOriginMs: null,
                physicsServerOriginMs: 0,
                simTimeS: 0,
                inputHistory: [],
                inputCursor: -1,
                profile,
                greenBarHeight,
                game,
                nibbleDelayMs,
                nibbleTimer: null,
                nibbleSentAt: null,
                reactionTimer: null,
                reactionTimeMs: null,
                preNibbleTapCount: 0,
                hooked: false,
                circularTap,
                secondaryVerticalProfile,
                rngSeed: rolled.rngSeed,
                rodTier,
                rejectedFinalCount: 0,
                desyncDetectedAt: null,
                clampedCount: 0,
                maxClampMs: 0,
                peakProgress: 0,
                inputDelayS: INPUT_DELAY_S,
              };
              safeSend(socket, {
                type: "cast_accepted",
                sessionId: sessionPdaStr ?? "",
                clientCastId,
                castTimestamp,
              });
              socket.session.nibbleTimer = setTimeout(() => {
                fireNibble(socket, clientCastId);
              }, nibbleDelayMs);
            };

            // Claim the slot immediately so a rapid follow-up cast can't race
            // the in-flight engine call; startSession() fills real fields after.
            socket.session = {
              wallet,
              sessionPda: null,
              activeCastId: clientCastId,
              castStartedAt: Date.now(),
              speciesId: 0,
              apexFishId: null,
              apexAssetUrl: null,
              speciesName: "",
              rarity: 0,
              mechanic: TIMING_BAR_MECHANIC,
              weightHg: 0,
              pendingHookPayload: null,
              samples: [],
              heldLatest: false,
              physicsStarted: false,
              lastTickAt: Date.now(),
              physicsAccumS: 0,
              physicsClientOriginMs: null,
              physicsServerOriginMs: 0,
              simTimeS: 0,
              inputHistory: [],
              inputCursor: -1,
              profile: {} as VerticalProfile,
              greenBarHeight: 0,
              game: {} as FishingGameState,
              nibbleDelayMs: 0,
              nibbleTimer: null,
              nibbleSentAt: null,
              reactionTimer: null,
              reactionTimeMs: null,
              preNibbleTapCount: 0,
              hooked: false,
              circularTap: null,
              secondaryVerticalProfile: null,
              rngSeed: 0,
              rodTier: 0,
              rejectedFinalCount: 0,
              desyncDetectedAt: null,
              clampedCount: 0,
              maxClampMs: 0,
              peakProgress: 0,
              inputDelayS: INPUT_DELAY_S,
            };
            void (async () => {
              const [baitSlug, rodTier] = await Promise.all([
                loadEquippedBaitSlug(wallet),
                loadEquippedRodTier(wallet),
              ]);
              try {
                const { rolled, sessionId } = await executeInitiateCastOffchain(
                  wallet,
                  clientCastId,
                );
                startSession(rolled, sessionId, baitSlug, rodTier);
              } catch (err) {
                // Surface clean error (NO_BAIT, transient DB) rather than
                // silently rolling a stub cast.
                console.warn(
                  "[gateway] off-chain initiate failed:",
                  (err as Error).message,
                );
                socket.session = null;
                // Distinguish a settling/closed room so the client can disable
                // the Cast button + show the settling notice, rather than
                // treating it like a generic failure.
                const code =
                  err instanceof CastEngineError &&
                  err.code === "WINDOW_CLOSED"
                    ? "window_closed"
                    : "cast_failed";
                safeSend(socket, {
                  type: "error",
                  code,
                  message: (err as Error).message,
                });
              }
            })();
            return;
          }

          case "nibble_response": {
            const ctx = socket.session;
            if (!ctx?.activeCastId || ctx.activeCastId !== msg.clientCastId) {
              replayTerminal(socket, msg.clientCastId);
              return;
            }
            handleNibbleResponse(socket, msg.clientCastId, msg.clientTs);
            return;
          }

          case "circular_tap_complete": {
            // C-1 fix: replay client-reported tap timestamps through server's
            // own spinner copy. The client's hit/miss claims are never trusted.
            const ctx = socket.session;
            if (!ctx?.activeCastId || ctx.activeCastId !== msg.clientCastId) {
              replayTerminal(socket, msg.clientCastId);
              return;
            }
            if (!ctx.hooked) return;
            if (ctx.mechanic !== CIRCULAR_TAP_MECHANIC) return;
            if (!ctx.circularTap) {
              // Should be impossible; fail closed.
              console.warn(
                "[gateway] circular_tap_complete with no server-side state",
              );
              resolveCatch(socket, false);
              return;
            }
            const verdict = validateCircularTapTaps({
              profile: ctx.circularTap.profile,
              targets: ctx.circularTap.targets,
              taps: msg.taps ?? [],
            });
            if (!verdict.passed) {
              resolveCatch(socket, false);
              return;
            }
            // Swap to the real legendary/apex profile — otherwise chained
            // physics runs at Basic difficulty while the client renders Legendary.
            if (ctx.secondaryVerticalProfile) {
              ctx.profile = ctx.secondaryVerticalProfile;
              ctx.greenBarHeight = resolveGreenBarHeight(
                ctx.profile,
                ctx.rodTier,
              );
              ctx.game = initialFishingGameState({
                sessionId: ctx.sessionPda ?? "local",
                verticalProfile: ctx.profile,
                greenBarHeight: ctx.greenBarHeight,
                rodTier: ctx.rodTier,
                luckyLureTier: 0,
                baitSlug: "fly",
                rngSeed: ctx.rngSeed,
                startingBarY: BAR_MAX_Y * 0.9,
                startingFishY: BAR_MAX_Y * 0.85,
                chestSpawned: false,
                chestY: 0,
                startedAt: Date.now(),
              });
            }
            ctx.mechanic = TIMING_BAR_MECHANIC;
            ctx.physicsStarted = true;
            ctx.lastTickAt = Date.now();
            ctx.physicsAccumS = 0;
            return;
          }

          case "input_samples": {
            const ctx = socket.session;
            if (!ctx?.activeCastId || ctx.activeCastId !== msg.clientCastId) {
              if (!replayTerminal(socket, msg.clientCastId)) {
                safeSend(socket, {
                  type: "error",
                  code: "no_active_cast",
                  message: "no active cast matching clientCastId",
                });
              }
              return;
            }
            // Pre-hook samples are suspect — the input mechanic shouldn't
            // mount until after fish_hooked.
            if (!ctx.hooked) {
              return;
            }
            for (const s of msg.samples) ctx.samples.push(s);
            // Update the socket's network-jitter estimate (drives the next
            // cast's adaptive lag-comp buffer). (arrival - t_ms) folds in clock
            // skew + one-way latency; subtracting the rolling min cancels the
            // skew, leaving live jitter. Decaying max so a spike relaxes later.
            const arrivalNow = Date.now();
            for (const s of msg.samples) {
              const offset = arrivalNow - s.t_ms;
              if (
                socket.netMinOffsetMs === null ||
                offset < socket.netMinOffsetMs
              ) {
                socket.netMinOffsetMs = offset;
              }
              const jitter = offset - socket.netMinOffsetMs;
              socket.netJitterMs = Math.max(
                jitter,
                socket.netJitterMs * NET_JITTER_DECAY,
              );
            }
            // Simulation-time origin = `t_ms` of the FIRST held=true sample.
            // Pre-tap keep-alives are absorbed so client/server origins land
            // on the same wallclock instant. Late arrivals are clamped forward
            // to the earliest simTime the server can absorb.
            for (const s of msg.samples) {
              if (ctx.physicsClientOriginMs === null) {
                if (!s.held) continue;
                ctx.physicsClientOriginMs = s.t_ms;
                ctx.physicsServerOriginMs = Date.now();
              }
              let simTimeS = (s.t_ms - ctx.physicsClientOriginMs) / 1000;
              if (simTimeS < ctx.simTimeS) {
                // TEMP instrumentation: this transition arrived too late for the
                // lag-comp buffer; clamping it forward diverges the server sim
                // from the client's. Track how often and how badly.
                const clampMs = (ctx.simTimeS - simTimeS) * 1000;
                ctx.clampedCount += 1;
                if (clampMs > ctx.maxClampMs) ctx.maxClampMs = clampMs;
                simTimeS = ctx.simTimeS;
              }
              const last = ctx.inputHistory[ctx.inputHistory.length - 1];
              if (last && last.held === s.held) continue;
              ctx.inputHistory.push({ simTimeS, held: s.held });
            }
            const latest = msg.samples[msg.samples.length - 1];
            if (latest) {
              ctx.heldLatest = latest.held;
            }
            // Align server start with client's TimingBar (mounts 450ms after fish_hooked).
            if (!ctx.physicsStarted && ctx.mechanic === TIMING_BAR_MECHANIC) {
              ctx.physicsStarted = true;
              ctx.lastTickAt = Date.now();
              ctx.physicsAccumS = 0;
            }
            return;
          }

          case "cast_finalize": {
            const ctx = socket.session;
            if (!ctx?.activeCastId || ctx.activeCastId !== msg.clientCastId) {
              if (!replayTerminal(socket, msg.clientCastId)) {
                safeSend(socket, {
                  type: "error",
                  code: "no_active_cast",
                  message: "no active cast matching clientCastId",
                });
              }
              return;
            }
            if (!ctx.hooked) {
              return;
            }
            if (ctx.mechanic !== TIMING_BAR_MECHANIC) {
              // Circular-tap resolves via circular_tap_complete only.
              safeSend(socket, {
                type: "error",
                code: "wrong_resolution_path",
                message:
                  "circular-tap casts must resolve via circular_tap_complete",
              });
              return;
            }
            // Floor check sees the freshest state — lets the player feel an
            // instant catch vs. waiting for the last ~150ms of fill to drift in.
            advancePhysics(ctx, Date.now());
            // Cheat surface: a forged finalize can at most skip ~1.6s of fill
            // — never produce a catch from nothing. Misses are ALWAYS decided
            // by the server's terminalState / safety timeout / desync timeout.
            const CLIENT_FINAL_FLOOR = 0.65;
            if (ctx.game.progress >= CLIENT_FINAL_FLOOR) {
              // TEMP desync instrumentation — see fly logs.
              console.log(
                `[finalize] cast=${ctx.activeCastId} progress=${ctx.game.progress.toFixed(3)} peak=${ctx.peakProgress.toFixed(3)} rejects=${ctx.rejectedFinalCount} clamped=${ctx.clampedCount} maxClampMs=${ctx.maxClampMs.toFixed(0)} delayMs=${(ctx.inputDelayS * 1000).toFixed(0)} -> CATCH`,
              );
              ctx.rejectedFinalCount = 0;
              ctx.desyncDetectedAt = null;
              resolveCatch(socket, true);
              return;
            }
            ctx.rejectedFinalCount += 1;
            // TEMP desync instrumentation — see fly logs.
            console.log(
              `[finalize] cast=${ctx.activeCastId} progress=${ctx.game.progress.toFixed(3)} peak=${ctx.peakProgress.toFixed(3)} rejects=${ctx.rejectedFinalCount} clamped=${ctx.clampedCount} maxClampMs=${ctx.maxClampMs.toFixed(0)} delayMs=${(ctx.inputDelayS * 1000).toFixed(0)} -> ${ctx.rejectedFinalCount >= DESYNC_REJECT_THRESHOLD ? "ESCAPE" : "REJECT(retry)"}`,
            );
            // On divergence, resolve as escaped instead of looping. Previously
            // we emitted desync_correction and kept retrying; in practice the
            // input timeline can be permanently diverged (late transitions
            // clamped server-side), so the cast would spiral until the 30s
            // safety timeout. Server is authoritative — progress didn't reach
            // the floor, so the catch isn't earned.
            if (
              ctx.rejectedFinalCount === DESYNC_REJECT_THRESHOLD &&
              ctx.desyncDetectedAt === null
            ) {
              ctx.desyncDetectedAt = Date.now();
              resolveCatch(socket, false);
            }
            return;
          }

          case "ping": {
            safeSend(socket, { type: "pong", t: msg.t });
            return;
          }

          default: {
            safeSend(socket, {
              type: "error",
              code: "unknown_message",
              message: `unknown message type`,
            });
          }
        }
      });

      raw.on("close", () => {
        clearInterval(physicsTimer);
        const ctx = socket.session;
        if (ctx?.activeCastId) {
          clearCastTimers(ctx);
          if (!ctx.hooked) {
            // 8s cancel grace.
            void cancelCastOnDisconnect(socket, ctx);
          } else {
            // 30s abandon grace covers mid-reel network blips.
            void abandonCastOnDisconnect(socket, ctx);
          }
        }
        if (socket.wallet) {
          removeWalletSocket(socket.wallet.toBase58(), socketId);
        }
        sockets.delete(socketId);
      });
    },
  );
});
