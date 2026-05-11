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
  executeCancelOnDisconnectOffchain,
  executeInitiateCastOffchain,
  executeSubmitResolveOffchain,
  type RolledCast,
} from "../services/fishing/wsExecutor.js";
import {
  getActiveEvent,
  getEventStatus,
  onEventChange,
  startEventPolling,
  type EventStatus,
} from "../services/eventConfig.js";
import type {
  ClientMessage,
  ServerMessage,
  InputSample,
} from "./protocol.js";
import {
  recordReactionLog,
  computeSampleJitterMaxMs,
  type ReactionOutcome,
} from "../services/reactionLog.js";
import type Redis from "ioredis";
import { Player } from "../db/schema.js";
import { creditCatch } from "../services/leaderboardCredit.js";
import { getRoomLeaderboard } from "../services/leaderboard.js";

// Module-scoped redis handle. Captured from `fastify.redis` when the plugin
// boots so module-level functions like `resolveCatch` (defined outside the
// plugin closure) can credit leaderboards without threading the fastify
// instance through every call site.
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
import {
  BAR_MAX_Y,
  FishRarity,
  INPUT_DELAY_S,
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
  // Stored so we can emit fish_hooked after the nibble timer fires and the
  // player taps to hook (deferred from immediate emission post-cast).
  pendingHookPayload: Extract<ServerMessage, { type: "fish_hooked" }> | null;
  samples: InputSample[];
  heldLatest: boolean;
  // Physics starts only once the client has sent its first input sample.
  physicsStarted: boolean;
  lastTickAt: number;
  // Fixed-timestep accumulator (seconds). Mirrors the client's RAF-driven
  // accumulator in components/fishing/timing-bar.tsx — both sides MUST step
  // at PHYSICS_FIXED_DT or the shared mulberry32 RNG state diverges within
  // a few seconds and the fish swims down different trajectories.
  physicsAccumS: number;
  // Lag-comp state. The first input sample's `t_ms` defines simulation
  // time = 0; every later sample's simTimeS = (t_ms - physicsClientOriginMs)
  // / 1000. The same mapping runs on the client. Both sides step physics up
  // to `(wallNow - physicsServerOriginMs)/1000 - INPUT_DELAY_S`, looking up
  // the input that was *active* at each step's simTimeS — so the bar
  // trajectory is a deterministic function of the input timeline, identical
  // on both sides modulo the constant clock-skew offset baked into origin.
  physicsClientOriginMs: number | null;
  physicsServerOriginMs: number;
  simTimeS: number;
  inputHistory: TimedInput[];
  inputCursor: number;
  profile: VerticalProfile;
  greenBarHeight: number;
  game: FishingGameState;
  // Server-determined nibble delay (fixed 3000ms) and timer plumbing.
  // The client cannot predict this — it only sees `cast_accepted` followed
  // some ms later by `nibble_event`. Validating `nibble_response` against
  // `nibbleSentAt` gates the entry to the input mechanic.
  nibbleDelayMs: number;
  nibbleTimer: ReturnType<typeof setTimeout> | null;
  nibbleSentAt: number | null;
  reactionTimer: ReturnType<typeof setTimeout> | null;
  reactionTimeMs: number | null;
  preNibbleTapCount: number;
  // Becomes true after a valid nibble_response (and fish_hooked has been sent).
  // Until then, input_samples are rejected.
  hooked: boolean;
  // Server-authoritative spinner state for Legendary/Apex casts. Computed at
  // startSession() time from the same `(rarity, profile)` the renderer sees
  // so `validateCircularTapTaps` can replay client-reported taps and decide
  // pass/fail without trusting any boolean from the wire (C-1 fix).
  circularTap: {
    profile: CircularProfile;
    targets: number[];
  } | null;
  // For Legendary/Apex casts, the vertical profile used by the timing-bar
  // phase that chains AFTER a successful spinner. Pre-built at startSession
  // (matching the client's `legendaryVerticalProfileRef`) so when
  // circular_tap_complete passes, we can swap ctx.profile/greenBarHeight
  // to the correct legendary/apex difficulty rather than the Basic
  // placeholder used during the spinner phase.
  secondaryVerticalProfile: VerticalProfile | null;
  // Original cast seed (kept so the chained timing-bar can re-init game
  // state with the same seed the client uses for its remounted TimingBar).
  rngSeed: number;
}

const NIBBLE_DELAY_MS = 3000;
const REACTION_WINDOW_MS = 2000;

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
}

const sockets = new Map<string, Socket>();
const socketsByWallet = new Map<string, Set<string>>();
const pendingNonces = new Map<string, number>();

const NONCE_TTL_MS = 2 * 60 * 1000;

function registerNonce(wallet: string, nonce: string): void {
  pendingNonces.set(`${wallet}:${nonce}`, Date.now());
}

function consumeNonce(wallet: string, nonce: string): boolean {
  const key = `${wallet}:${nonce}`;
  const stamp = pendingNonces.get(key);
  if (!stamp) return false;
  pendingNonces.delete(key);
  return Date.now() - stamp < NONCE_TTL_MS;
}

function verifySignature(
  walletBase58: string,
  nonce: string,
  signatureBase58: string,
): boolean {
  try {
    const wallet = new PublicKey(walletBase58);
    const sigBytes = bs58.decode(signatureBase58);
    const msgBytes = Buffer.from(
      `Hooked Auth Nonce: ${nonce}`,
      "utf8",
    );
    return nacl.sign.detached.verify(
      msgBytes,
      sigBytes,
      wallet.toBytes(),
    );
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

export function broadcastToWallet(
  wallet: string,
  msg: ServerMessage,
): void {
  const set = socketsByWallet.get(wallet);
  if (!set) return;
  for (const id of set) {
    const s = sockets.get(id);
    if (s) safeSend(s, msg);
  }
}

// Update the room binding for every open socket of a wallet. Called when the
// HTTP-side `recoverEntry` path admits the player to a room: existing WS
// connections need to learn the new roomId without forcing a reconnect.
export function bindWalletToRoom(
  walletAddress: string,
  roomId: string,
): void {
  const set = socketsByWallet.get(walletAddress);
  if (!set) return;
  for (const id of set) {
    const s = sockets.get(id);
    if (s) s.roomId = roomId;
  }
}

// Look up the player's active deposit and assign socket.roomId. Runs
// asynchronously after auth so the `authenticated` reply is not delayed by a
// Mongo round-trip. No-op if the socket has been closed by the time the
// lookup returns.
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

// Per-room debounce: a burst of catches in a busy room collapses into one
// broadcast. The skill spec calls this out — 250ms is short enough to feel
// real-time and long enough to absorb ~7 catches at our 30Hz physics tick.
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
    const playerMap = new Map(
      players.map((p) => [p._id.toString(), p]),
    );
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
          // catchCount isn't tracked in the score sorted set today; surface 0
          // so the wire shape stays stable for future consumers.
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
  // Self-healing: an event whose endsAt has passed reads as inactive on the
  // wire even if the lifecycle worker hasn't flipped the flag yet, so
  // clients always see state consistent with what the cast roll uses.
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
  eventCacheUnsubscribe = onEventChange((status) => broadcastEventStatus(status));
  // Warm cache + start the 30s poller. The listener fires only on
  // transitions, so an idle period costs one DB read every 30s and zero
  // WS broadcasts.
  void getEventStatus(true).catch(() => {});
  startEventPolling();
}

// Client and server run identical physics from @hooked/shared. Physics is
// paused until the client sends its first input sample, so the pre-reeling
// "BITE!" flash cannot drain the progress meter.
//
// LAG-COMP MODEL. The bar physics depends on player input timing; running it
// against `heldLatest` (newest sample regardless of when the player acted)
// drifts the server's bar trajectory away from the client's by exactly the
// network jitter on each transition. We instead replay inputs at their
// client-stamped time:
//
//   simTimeS(sample)     = (sample.t_ms - physicsClientOriginMs) / 1000
//   wallSinceOriginS     = (now - physicsServerOriginMs) / 1000
//   server steps physics → up to wallSinceOriginS - INPUT_DELAY_S
//
// Each fixed step looks up the input active at its simTimeS via the sorted
// `inputHistory`. INPUT_DELAY_S buffers the simulation behind wallclock so
// most samples land before their step is processed — late samples (RTT/2 >
// INPUT_DELAY) are dropped with a warning rather than rewinding state.

const PHYSICS_TICK_MS = 33;

function advancePhysics(ctx: SessionContext, now: number): void {
  if (!ctx.physicsStarted) return;
  if (ctx.physicsClientOriginMs === null) return;
  const wallSinceOriginS = (now - ctx.physicsServerOriginMs) / 1000;
  const targetSimTimeS = wallSinceOriginS - INPUT_DELAY_S;
  // Clamp how far we can sprint forward in one wall-tick (covers GC pauses).
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
  }
}

function fallbackScore(ctx: SessionContext, hit: boolean): number {
  if (!hit) return 0;
  return Math.floor((ctx.weightHg * (1 + ctx.rarity * 5)) / 10);
}

// Pre-nibble disconnect refund. The on-chain initiate_cast already consumed
// bait, so we ask the program to roll it back. Best-effort: if ER is offline
// or the call fails, the keeper will eventually clean up stale pending
// casts; the worst case for the player is one bait lost to a network blip.
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
}

// Fire the server-determined nibble. Idempotent against late cancels (a
// disconnect that races the timer leaves activeCastId null).
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

// 2s elapsed without nibble_response → fish escapes. Bait stays consumed
// (the spec calls this out explicitly: missed reactions still cost a bait).
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

// Promotes the pending hook payload into a fish_hooked broadcast and lets
// input_samples through. Validates the response is inside the reaction
// window using server clock (clientTs is logged but never trusted for
// admission).
function handleNibbleResponse(
  socket: Socket,
  clientCastId: string,
  clientTs: number,
): void {
  const ctx = socket.session;
  if (!ctx || ctx.activeCastId !== clientCastId) return;
  if (ctx.hooked) return;
  if (ctx.nibbleSentAt === null) {
    // Pre-nibble tap: count it for cheat telemetry and ignore. The client
    // also gates locally, so seeing this server-side is suspicious.
    ctx.preNibbleTapCount += 1;
    return;
  }
  const elapsed = Date.now() - ctx.nibbleSentAt;
  if (elapsed > REACTION_WINDOW_MS) {
    // The reaction timer should already be in flight or fired; let it
    // handle the escape. Don't double-resolve.
    return;
  }
  if (ctx.reactionTimer) {
    clearTimeout(ctx.reactionTimer);
    ctx.reactionTimer = null;
  }
  ctx.reactionTimeMs = elapsed;
  // clientTs is recorded for offline drift analysis (clock skew, replay
  // detection). Server clock is authoritative for the window.
  void clientTs;
  ctx.hooked = true;
  if (ctx.pendingHookPayload) {
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
  // Clear the slot before async work so a follow-up cast can start while the
  // ER CPI + fetch are in flight.
  const activeCastId = ctx.activeCastId;
  const sessionIdStr = ctx.sessionPda ?? "";
  const speciesId = ctx.speciesId;
  const apexFishId = ctx.apexFishId;
  const apexAssetUrl = ctx.apexAssetUrl;
  const speciesName = ctx.speciesName;
  const rarity = ctx.rarity;
  const fallbackWeight = hit ? ctx.weightHg : 0;
  const fallback = fallbackScore(ctx, hit);
  const roomId = socket.roomId;

  // Snapshot reaction telemetry before we wipe the cast slot so the async
  // log write below sees consistent data even if a follow-up cast races in.
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

  const deliver = (score: number, weightHg: number) => {
    const msg: ServerMessage = {
      type: "catch_resolved",
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
    safeSend(socket, msg);
  };

  if (!ctx.sessionPda) {
    deliver(fallback, fallbackWeight);
    return;
  }
  void (async () => {
    try {
      const res = await executeSubmitResolveOffchain(sessionIdStr, hit);
      // Off-chain submit persists the canonical weightHg via the rolled cast
      // — the gateway already has it in `ctx.weightHg`. Use that for the wire
      // so the client gets the same value the catch row was written with.
      if (res) {
        deliver(res.score, fallbackWeight);
        // Credit leaderboards only when the catch row was persisted (res
        // truthy) AND was a hit. Skipping miss/fallback paths keeps the
        // Redis sorted sets aligned with what's actually in Mongo. Errors
        // inside creditCatch are logged and swallowed; this must never
        // throw past the WS handler.
        if (hit && walletStr && redisRef && res.score > 0) {
          void creditCatch({
            redis: redisRef,
            walletAddress: walletStr,
            score: res.score,
            weightHg: fallbackWeight,
            rarity,
            speciesName,
            roomId: roomId ?? null,
          });
        }
      } else deliver(fallback, fallbackWeight);
    } catch (err) {
      console.error("[gateway] off-chain submit failed:", err);
      deliver(fallback, fallbackWeight);
    }
  })();
}

// Cast roll types are owned by services/fishing/wsExecutor.ts now; the
// gateway just consumes them.

const WS_MAX_PAYLOAD_BYTES = 64 * 1024;

const AUTH_RATE_LIMIT = {
  max: 30,
  timeWindow: "1 minute",
};

// CSWSH defense: reject any /ws/* request whose Origin doesn't match the CORS
// allowlist. Runs before the WebSocket upgrade so a bad origin gets a 403
// instead of an open socket. Missing Origin is allowed (matches CORS) so
// non-browser callers like wscat/curl still work.
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

  // Capture redis once at plugin boot so resolveCatch (module-scope) can
  // fire leaderboard credits without needing the fastify instance.
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
      registerNonce(wallet, nonce);
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
    };
    sockets.set(socketId, socket);

    const physicsTimer = setInterval(() => {
      const ctx = socket.session;
      if (!ctx || !ctx.activeCastId) return;
      // Circular-tap casts resolve on the final input batch.
      if (ctx.mechanic !== TIMING_BAR_MECHANIC) return;
      const now = Date.now();
      advancePhysics(ctx, now);
      if (ctx.game.sampleCount % 3 === 0) {
        safeSend(socket, {
          type: "fishing_state",
          sessionId: ctx.sessionPda ?? "",
          clientCastId: ctx.activeCastId,
          barY: ctx.game.barY,
          // Push the SMOOTHED fish position. Both server stepProgress and
          // client rendering use this same value, eliminating the local-vs-
          // server fishY divergence that previously let local progress fill
          // to 0.99 while server progress stayed at 0.
          fishY: ctx.game.fishYDisplay,
          progress: ctx.game.progress,
          tickIndex: ctx.game.sampleCount,
        });
      }
      // Diagnostic: state snapshot every ~1s. Drop once verified.
      if (ctx.game.sampleCount % 60 === 0 && ctx.physicsStarted) {
        console.warn(
          `[gateway] tick @${ctx.game.sampleCount} ` +
            `progress=${ctx.game.progress.toFixed(3)} ` +
            `barY=${ctx.game.barY.toFixed(0)} ` +
            `fishY=${ctx.game.fishYDisplay.toFixed(0)} ` +
            `held=${ctx.heldLatest}`,
        );
      }
      // Server-authoritative resolution. The server runs its own copy of
      // the physics every tick; as soon as terminalState() declares a
      // verdict, we resolve. Previously the server only checked at safety
      // timeout / on `input_samples final`, which forced resolution against
      // whatever the server's state happened to be at the moment the client
      // gave up — even if the server's physics had a different fish position
      // due to RNG/rate drift. Always resolving on the server's own terminal
      // state means the player can never lose a cast the server thinks is
      // still in progress.
      const terminalNow = terminalState(ctx.game, ctx.greenBarHeight);
      if (terminalNow !== null) {
        console.warn(
          `[gateway] terminal-resolve verdict=${terminalNow} ` +
            `progress=${ctx.game.progress.toFixed(3)} ` +
            `fishY=${ctx.game.fishYDisplay.toFixed(1)} ` +
            `castMs=${now - ctx.castStartedAt}`,
        );
        resolveCatch(socket, terminalNow === "caught");
        return;
      }
      const SAFETY_TIMEOUT_MS = 30_000;
      if (now - ctx.castStartedAt > SAFETY_TIMEOUT_MS) {
        console.warn(
          `[gateway] safety-timeout fired ` +
            `progress=${ctx.game.progress.toFixed(3)} ` +
            `barY=${ctx.game.barY.toFixed(1)} ` +
            `fishY=${ctx.game.fishYDisplay.toFixed(1)} ` +
            `held=${ctx.heldLatest}`,
        );
        // Force escape — physics didn't reach terminal in time.
        resolveCatch(socket, false);
      }
    }, PHYSICS_TICK_MS);

    raw.on("message", (data: Buffer) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(data.toString()) as ClientMessage;
      } catch {
        safeSend(socket, {
          type: "error",
          code: "invalid_json",
          message: "invalid JSON",
        });
        return;
      }

      switch (msg.type) {
        case "authenticate": {
          // Temporary diagnostic log — surface why auth keeps failing in the
          // dev loop. Drop once we've stabilized the auth path.
          const authFail = (reason: string) => {
            console.warn(
              `[gateway] auth_failed wallet=${msg.wallet?.slice(0, 8)}… reason=${reason} hasDelegation=${!!msg.delegation}`,
            );
            safeSend(socket, { type: "auth_failed", reason });
          };
          if (!consumeNonce(msg.wallet, msg.nonce)) {
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
          // Push current event status so the HUD alert mounts before the
          // first cast; status tracks the L1 cache (refresh on TTL or change).
          void getEventStatus().then((status) =>
            safeSend(socket, eventStatusMessage(status)),
          );
          // Resolve the player's current room from their active deposit and
          // bind it to this socket so room-scoped broadcasts (leaderboard
          // updates) reach them. Async — must not delay the auth reply.
          void hydrateRoomBindingForSocket(socketId, msg.wallet);
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
          const startSession = (
            rolled: RolledCast,
            sessionPdaStr: string | null,
            baitSlug: string,
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
              computeModifiers({ streak: 0, poolTier: 0, sessionElapsedMs: 0 }),
            ) as VerticalProfile;
            // For circular casts we additionally pre-compute the canonical
            // spinner state so the gateway can replay client-reported taps
            // without trusting any wire boolean (C-1). Targets are derived
            // deterministically from `(rarity, castCount=0)` — same call
            // shape the renderer uses on the client.
            const circularTap =
              rolled.mechanic === CIRCULAR_TAP_MECHANIC &&
              (rolled.rarityEnum === FishRarity.Legendary ||
                rolled.rarityEnum === FishRarity.Apex)
                ? buildCircularTapState(rolled.rarityEnum, 0)
                : null;
            // Pre-build the chained timing-bar profile for Legendary/Apex.
            // Mirrors the client's `legendaryVerticalProfileRef` (built at
            // fish_hooked from the same seed + zero modifiers) so when the
            // spinner clears and we swap ctx.profile, both sides agree on
            // the chained-phase difficulty.
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
            const greenBarHeight = resolveGreenBarHeight(profile, 0);
            const game = initialFishingGameState({
              sessionId: sessionPdaStr ?? "local",
              verticalProfile: profile,
              greenBarHeight,
              rodTier: 0,
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
              // Physics starts when the first input_sample arrives — the
              // server is silent during the nibble window, and the input
              // mechanic only mounts once we've broadcast fish_hooked after
              // a valid nibble_response.
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
            };
            // Acks the cast so the client may begin its splash + idle anim.
            // The fish has been rolled and bait is consumed; the gateway is
            // now silently holding the nibble timer.
            safeSend(socket, {
              type: "cast_accepted",
              sessionId: sessionPdaStr ?? "",
              clientCastId,
              castTimestamp,
            });
            // Schedule nibble. Using the captured ctx ref via socket.session
            // keeps cancellation centralized in clearCastTimers / disconnect.
            socket.session.nibbleTimer = setTimeout(() => {
              fireNibble(socket, clientCastId);
            }, nibbleDelayMs);
          };

          // wallet is guaranteed non-null by the not_authenticated guard
          // earlier in this case. Claim the slot immediately so a rapid
          // follow-up cast can't race the in-flight engine call; startSession()
          // fills the real fields after.
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
          };
          void (async () => {
            const baitSlug = await loadEquippedBaitSlug(wallet);
            try {
              const { rolled, sessionId } = await executeInitiateCastOffchain(
                wallet,
                clientCastId,
              );
              startSession(rolled, sessionId, baitSlug);
            } catch (err) {
              // Off-chain initiate can fail with NO_BAIT (no active deposit)
              // or transient DB errors. Surface a clean error to the client
              // rather than silently rolling a stub cast — the player needs
              // to know they can't fish.
              console.warn(
                "[gateway] off-chain initiate failed:",
                (err as Error).message,
              );
              socket.session = null;
              safeSend(socket, {
                type: "error",
                code: "cast_failed",
                message: (err as Error).message,
              });
            }
          })();
          return;
        }

        case "nibble_response": {
          const ctx = socket.session;
          if (!ctx?.activeCastId || ctx.activeCastId !== msg.clientCastId) {
            return;
          }
          handleNibbleResponse(socket, msg.clientCastId, msg.clientTs);
          return;
        }

        case "circular_tap_complete": {
          // Server-authoritative resolution of the circular-tap phase. We
          // replay the client-reported per-tap timestamps through our copy
          // of the spinner physics; the client's hit/miss claims are never
          // trusted. On a verified pass we then chain into the timing-bar
          // second phase (still server-authoritative) for Legendary/Apex.
          // On a verified fail we resolve the catch as missed immediately.
          //
          // C-1 fix: the previous handler trusted the client's "all hits
          // landed" signal. Sending `circular_tap_complete` was enough to
          // skip the spinner entirely. Now the gateway recomputes hits from
          // submitted timestamps against its own copy of the spinner.
          const ctx = socket.session;
          if (!ctx?.activeCastId || ctx.activeCastId !== msg.clientCastId) return;
          if (!ctx.hooked) return;
          if (ctx.mechanic !== CIRCULAR_TAP_MECHANIC) return;
          if (!ctx.circularTap) {
            // Should be impossible — startSession sets this for every
            // circular cast — but fail closed if it ever isn't.
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
          // Pass. Chain into the timing-bar phase. Critically, swap the
          // server's vertical profile from the Basic placeholder used during
          // the spinner to the real legendary/apex profile — otherwise the
          // chained physics runs at Basic difficulty while the client renders
          // a Legendary/Apex UI. Also re-init the game state so the chained
          // phase starts from canonical bar/fish positions, matching the
          // client's freshly-mounted `TimingBar` component.
          if (ctx.secondaryVerticalProfile) {
            ctx.profile = ctx.secondaryVerticalProfile;
            ctx.greenBarHeight = resolveGreenBarHeight(ctx.profile, 0);
            ctx.game = initialFishingGameState({
              sessionId: ctx.sessionPda ?? "local",
              verticalProfile: ctx.profile,
              greenBarHeight: ctx.greenBarHeight,
              rodTier: 0,
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
            safeSend(socket, {
              type: "error",
              code: "no_active_cast",
              message: "no active cast matching clientCastId",
            });
            return;
          }
          // Reject samples that arrive before the player has been hooked.
          // The client's input mechanic isn't supposed to mount until after
          // fish_hooked, so any samples here are suspect.
          if (!ctx.hooked) {
            return;
          }
          for (const s of msg.samples) ctx.samples.push(s);
          // Build the lag-comp input history. The simulation-time origin is
          // the `t_ms` of the FIRST sample with held=true — the first frame
          // the player actually inputs. Pre-tap keep-alives (held=false,
          // re-stating default) are absorbed silently so client and server
          // origins land on the same wallclock instant: the bar's local
          // setHeld and the WS hook's setHeld both capture Date.now() in
          // the same React event handler, and only that first held=true
          // event matters.
          //
          // Late arrivals (sample.t_ms whose simTimeS is already behind the
          // server's stepped simTimeS) get clamped forward — the input
          // takes effect at the earliest simTime the server can absorb.
          // With INPUT_DELAY_S = 60ms of buffer this should be rare.
          let lateArrivalCount = 0;
          for (const s of msg.samples) {
            if (ctx.physicsClientOriginMs === null) {
              if (!s.held) continue;
              ctx.physicsClientOriginMs = s.t_ms;
              ctx.physicsServerOriginMs = Date.now();
            }
            let simTimeS = (s.t_ms - ctx.physicsClientOriginMs) / 1000;
            if (simTimeS < ctx.simTimeS) {
              lateArrivalCount += 1;
              simTimeS = ctx.simTimeS;
            }
            const last = ctx.inputHistory[ctx.inputHistory.length - 1];
            if (last && last.held === s.held) continue;
            ctx.inputHistory.push({ simTimeS, held: s.held });
          }
          const latest = msg.samples[msg.samples.length - 1];
          if (latest) {
            const prev = ctx.heldLatest;
            ctx.heldLatest = latest.held;
            if (prev !== latest.held) {
              console.warn(
                `[gateway] held-changed ${prev}→${latest.held} ` +
                  `final=${msg.final ?? false} ` +
                  `progress=${ctx.game.progress.toFixed(3)} ` +
                  `simTimeS=${ctx.simTimeS.toFixed(3)}`,
              );
            }
          }
          if (lateArrivalCount > 0) {
            console.warn(
              `[gateway] late-input lateArrivals=${lateArrivalCount} ` +
                `simTimeS=${ctx.simTimeS.toFixed(3)} ` +
                `(consider raising INPUT_DELAY_MS if persistent)`,
            );
          }
          // Start physics on first input so server timing aligns with the
          // client's TimingBar (mounts 450ms after fish_hooked).
          if (!ctx.physicsStarted && ctx.mechanic === TIMING_BAR_MECHANIC) {
            ctx.physicsStarted = true;
            ctx.lastTickAt = Date.now();
            ctx.physicsAccumS = 0;
          }
          // Circular-tap is now resolved exclusively via the
          // `circular_tap_complete` handler, which replays the client's
          // tap timestamps through server-side spinner physics (C-1 fix).
          // Reject any attempt to resolve circular casts via input_samples,
          // including the legacy "final sample + held bit" path that an
          // attacker could otherwise use to bypass the spinner entirely.
          if (msg.final && ctx.mechanic === CIRCULAR_TAP_MECHANIC) {
            safeSend(socket, {
              type: "error",
              code: "wrong_resolution_path",
              message:
                "circular-tap casts must resolve via circular_tap_complete",
            });
            return;
          }
          // Timing-bar: server's physicsTimer is the primary resolver. But
          // when the client signals it's reached terminal locally AND the
          // server's own progress is already in the safe zone, force the
          // catch immediately — otherwise the player sees their bar visibly
          // full for several hundred ms while the server fills the last 15%
          // at FILL_RATE_PER_SEC. This is bounded: server only honours the
          // signal when its own progress is already past CLIENT_FINAL_FLOOR
          // (== client-side NEAR_WIN_THRESHOLD), so a malicious client can
          // at best skip the last ~150ms of fill — not force a catch from
          // nowhere. Force-escape from client final is NEVER honoured;
          // misses are always decided by the server's own terminalState.
          if (msg.final && ctx.mechanic === TIMING_BAR_MECHANIC) {
            advancePhysics(ctx, Date.now());
            // Server progress floor required to accept a client-driven catch.
            // Now that both sides score against the SAME smoothed fish
            // position (`fishYDisplay`), local and server progress should
            // track each other closely. Restore a stricter floor (0.65) so
            // the catch only fires once the player has genuinely earned it.
            // Cheat surface: a forged client-final can at most skip ~1.6s
            // of server fill — not produce a catch from nothing.
            const CLIENT_FINAL_FLOOR = 0.65;
            if (ctx.game.progress >= CLIENT_FINAL_FLOOR) {
              console.warn(
                `[gateway] client-final accepted as catch ` +
                  `progress=${ctx.game.progress.toFixed(3)} ` +
                  `castMs=${Date.now() - ctx.castStartedAt}`,
              );
              resolveCatch(socket, true);
              return;
            }
            console.warn(
              `[gateway] client-final ignored (progress too low) ` +
                `progress=${ctx.game.progress.toFixed(3)} ` +
                `castMs=${Date.now() - ctx.castStartedAt}`,
            );
            return;
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
          // Pre-nibble disconnect: the on-chain cast already consumed bait.
          // Refund via cancel_cast (best effort — the keeper will sweep
          // stale pending casts on the next session-lifecycle pass too).
          void cancelCastOnDisconnect(socket, ctx);
        }
      }
      if (socket.wallet) {
        removeWalletSocket(socket.wallet.toBase58(), socketId);
      }
      sockets.delete(socketId);
    });
  });
});
