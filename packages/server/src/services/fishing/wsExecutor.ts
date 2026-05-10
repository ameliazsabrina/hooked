/**
 * Off-chain executor for the WS gateway. Implements the same surface that
 * the legacy `initiateCastOnEr` / `submitResolveOnEr` / `cancelCastOnDisconnect`
 * functions in `ws/gateway.ts` do, but routes through the off-chain engine
 * (services/fishing/castEngine + sessionEngine) instead of CPI'ing into the
 * on-chain hooked_fishing program.
 *
 * The shapes returned here are deliberately string-typed for `sessionId` so
 * the gateway's existing `ctx.sessionPda: string | null` field accepts either
 * a base58 PublicKey (legacy) or a Mongo ObjectId (off-chain) without
 * touching the rest of the gateway. Phase 6 will collapse the field name to
 * `sessionId` once the legacy path is removed.
 */

import type { PublicKey } from "@solana/web3.js";
import { FishRarity } from "@hooked/shared";

import { FishingSession, Player } from "../../db/schema.js";
import { env } from "../../config/env.js";
import { baitAmountForDeposit } from "../baitAmount.js";
import { getActiveEvent } from "../eventConfig.js";
import {
  CANCEL_CAST_GRACE_SECS,
  cancelCast,
  initiateCast,
  submitInputSamples,
} from "./castEngine.js";
import { CastEngineError } from "./errors.js";
import { dailySeedDateFor, loadDailySeed } from "./dailySeed.js";
import { startSession } from "./sessionEngine.js";

/** Mirrors the on-chain executor's RolledCast shape so the gateway doesn't need
 *  to know which path produced the roll. Apex casts surface `apexFishId` +
 *  `apexAssetUrl` + `speciesName` so the WS broadcast can render the rolled
 *  fish without a follow-up query. */
export interface RolledCast {
  /** SPECIES_TABLE index for non-apex casts; -1 when apex rolled. */
  speciesId: number;
  apexFishId: string | null;
  apexAssetUrl: string | null;
  speciesName: string;
  rarity: number;
  rarityEnum: FishRarity;
  mechanic: number;
  weightHg: number;
  /** Server-side seed for replayable physics. Independent of the cast roll
   *  bytes so the legacy path's hash-of-seed semantics carry over. */
  rngSeed: number;
}

const RARITY_ORDER: FishRarity[] = [
  FishRarity.Basic,
  FishRarity.Rare,
  FishRarity.Monster,
  FishRarity.Legendary,
  FishRarity.Apex,
];

/** Hash a buffer to a u32 for the `rngSeed` field of `RolledCast`. */
function rngSeedFromBytes(buf: Buffer): number {
  let h = 0;
  for (let i = 0; i < Math.min(buf.length, 16); i++) {
    h = (h * 31 + buf[i]) >>> 0;
  }
  return (h ^ 0x9e3779b9) >>> 0;
}

/**
 * Ensure a FishingSession exists for the player in the current window and
 * return its id. Mirrors the legacy keeper-driven init_session flow but is
 * done lazily on first cast so the WS gateway doesn't need to coordinate
 * with the keeper job for off-chain players.
 */
async function ensureActiveSession(walletBase58: string): Promise<string> {
  const player = await Player.findOne(
    { walletAddress: walletBase58 },
    { deposits: 1 },
  ).lean();
  if (!player) {
    throw new CastEngineError(
      "SESSION_NOT_FOUND",
      `No player for wallet ${walletBase58}`,
    );
  }
  const active = (player.deposits ?? [])
    .filter((d) => !d.returned)
    .sort((a, b) => b.depositedAt.getTime() - a.depositedAt.getTime())[0];
  if (!active) {
    throw new CastEngineError(
      "NO_BAIT",
      "No active room deposit — cannot start a fishing session",
    );
  }
  const baitInitial = baitAmountForDeposit(active.amount);
  const tier = Math.min(4, Math.max(1, Math.round(active.amount / 0.5)));

  const event = getActiveEvent();
  const now = new Date();
  const result = await startSession({
    walletAddress: walletBase58,
    roomId: active.poolId,
    baitInitial,
    tier,
    event: event
      ? {
          active: true,
          name: event.name,
          apexBp: event.apexBp,
          // Convert kg → hg (×10) once at snapshot time so the cast roll
          // keeps integer math.
          apexFishes: event.apexFishes.map((f) => ({
            apexFishId: f.id,
            name: f.name,
            weightMinHg: Math.round(f.weightMinKg * 10),
            weightMaxHg: Math.round(f.weightMaxKg * 10),
          })),
        }
      : undefined,
    dailySeedDate: dailySeedDateFor(now),
    now,
  });

  // Self-heal stale pendingCast: a cast whose castAt is older than the
  // 30s "should have resolved by now" threshold means the player either
  // dropped the connection mid-cast or never tapped, and the bait was
  // already debited at initiate time. Without this, the next cast hits
  // CAST_PENDING in initiateCast and the timing-bar / circular-tap UI
  // never appears. No bait refund — the cast was abandoned, not cancelled
  // within the 8s grace window.
  const STALE_CAST_MS = 30_000;
  await FishingSession.updateOne(
    {
      _id: result.sessionId,
      status: "active",
      "pendingCast.castAt": { $lt: new Date(now.getTime() - STALE_CAST_MS) },
    },
    { $set: { pendingCast: null } },
  );

  return result.sessionId;
}

/**
 * Roll a cast off-chain and return the same `{ rolled, sessionId }` shape the
 * legacy on-chain executor produces. Auto-creates a session for the wallet
 * if one doesn't exist for the current window (idempotent).
 */
export async function executeInitiateCastOffchain(
  wallet: PublicKey,
  _clientCastId: string,
): Promise<{ rolled: RolledCast; sessionId: string }> {
  const walletBase58 = wallet.toBase58();
  const sessionId = await ensureActiveSession(walletBase58);

  const dailySeed = await loadDailySeed();
  const result = await initiateCast({ sessionId, dailySeed });

  const rarityIdx = Math.max(0, Math.min(RARITY_ORDER.length - 1, result.rarity));
  const apexAssetUrl = result.apexFishId
    ? `${env.SERVER_PUBLIC_URL}/admin/apex-fish/${result.apexFishId}/image`
    : null;
  return {
    sessionId,
    rolled: {
      speciesId: result.speciesId,
      apexFishId: result.apexFishId,
      apexAssetUrl,
      speciesName: result.speciesName,
      rarity: rarityIdx,
      rarityEnum: RARITY_ORDER[rarityIdx],
      mechanic: result.mechanic,
      weightHg: result.weightHg,
      rngSeed: rngSeedFromBytes(result.seedHash),
    },
  };
}

/**
 * Resolve a pending cast off-chain. The score returned here lets the gateway
 * push `catch_resolved` to the client without re-querying the DB.
 */
export async function executeSubmitResolveOffchain(
  sessionId: string,
  hit: boolean,
): Promise<{ score: number; weightHg: number } | null> {
  try {
    const result = await submitInputSamples({ sessionId, hit });
    if (!result.hit) {
      return { score: 0, weightHg: 0 };
    }
    // For weightHg, re-read the catch we just wrote — but submitInputSamples
    // already persisted the canonical weight, so the gateway's caller-side
    // weight from the rolled cast is fine. Return the score we just locked in.
    return { score: result.score, weightHg: 0 };
  } catch (err) {
    if (err instanceof CastEngineError && err.code === "NO_CAST_TO_RESOLVE") {
      // Cast was already resolved (race) — gateway falls back to its own scoring.
      return null;
    }
    throw err;
  }
}

/**
 * Refund bait for a cast abandoned mid-flight (player disconnected before
 * tapping). Same 8s grace as the on-chain path.
 */
export async function executeCancelOnDisconnectOffchain(
  sessionId: string,
): Promise<void> {
  try {
    await cancelCast({ sessionId });
  } catch (err) {
    if (err instanceof CastEngineError) {
      // CANCEL_GRACE_EXPIRED, NO_CAST_TO_RESOLVE — both are normal in the
      // disconnect flow and don't warrant a stack trace.
      console.warn(
        `[wsExecutor] cancel skipped (${err.code}): ${err.message}`,
      );
      return;
    }
    throw err;
  }
}

export const CANCEL_GRACE_SECS = CANCEL_CAST_GRACE_SECS;
