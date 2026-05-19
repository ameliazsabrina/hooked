import type { PublicKey } from "@solana/web3.js";
import { FishRarity } from "@hooked/shared";

import { FishingSession, Player, Room } from "../../db/schema.js";
import { env } from "../../config/env.js";
import { baitAmountForDeposit } from "../baitAmount.js";
import { getActiveEvent } from "../eventConfig.js";
import {
  CANCEL_CAST_GRACE_SECS,
  abandonCast,
  cancelCast,
  initiateCast,
  submitInputSamples,
} from "./castEngine.js";
import { CastEngineError } from "./errors.js";
import { dailySeedDateFor, loadDailySeed } from "./dailySeed.js";
import { startSession } from "./sessionEngine.js";

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
  /** Server-side seed for replayable physics. */
  rngSeed: number;
}

const RARITY_ORDER: FishRarity[] = [
  FishRarity.Basic,
  FishRarity.Rare,
  FishRarity.Monster,
  FishRarity.Legendary,
  FishRarity.Apex,
];

function rngSeedFromBytes(buf: Buffer): number {
  let h = 0;
  for (let i = 0; i < Math.min(buf.length, 16); i++) {
    h = (h * 31 + buf[i]) >>> 0;
  }
  return (h ^ 0x9e3779b9) >>> 0;
}

/** Lazily ensures a FishingSession for the current window. */
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

  // Fail closed regardless of keeper health: check room state directly
  // (deposits[].returned only flips when keeper succeeds, which can stall).
  // Only "entry" and "active" phases allow casting.
  const room = await Room.findOne(
    { roomId: active.poolId },
    { phase: 1, closesAt: 1 },
  ).lean();
  const nowMs = Date.now();
  if (
    !room ||
    (room.phase !== "entry" && room.phase !== "active") ||
    room.closesAt.getTime() <= nowMs
  ) {
    throw new CastEngineError(
      "WINDOW_CLOSED",
      `Room ${active.poolId} is no longer accepting casts ` +
        `(phase=${room?.phase ?? "missing"}, closesAt=${room?.closesAt?.toISOString() ?? "—"})`,
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
          // kg → hg (×10) for integer math.
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

  // Stale pendingCast (>30s) blocks the next cast on CAST_PENDING. Clear
  // without refund — past the 8s cancel grace, the bait counts as spent.
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

/** Idempotently creates a session for the current window then rolls. */
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

/** Returns score so the gateway can push catch_resolved without a DB requery. */
export async function executeSubmitResolveOffchain(
  sessionId: string,
  hit: boolean,
): Promise<{ score: number; weightHg: number } | null> {
  try {
    const result = await submitInputSamples({ sessionId, hit });
    if (!result.hit) {
      return { score: 0, weightHg: 0 };
    }
    return { score: result.score, weightHg: 0 };
  } catch (err) {
    if (err instanceof CastEngineError && err.code === "NO_CAST_TO_RESOLVE") {
      // Race — gateway falls back to its own scoring.
      return null;
    }
    throw err;
  }
}

/** Pre-tap disconnect refund (8s grace). */
export async function executeCancelOnDisconnectOffchain(
  sessionId: string,
): Promise<void> {
  try {
    await cancelCast({ sessionId });
  } catch (err) {
    if (err instanceof CastEngineError) {
      console.warn(
        `[wsExecutor] cancel skipped (${err.code}): ${err.message}`,
      );
      return;
    }
    throw err;
  }
}

/** Post-tap disconnect refund (ABANDON_CAST_GRACE_SECS). */
export async function executeAbandonOnDisconnectOffchain(
  sessionId: string,
): Promise<{ refunded: boolean }> {
  try {
    const result = await abandonCast({ sessionId });
    return { refunded: result.refunded };
  } catch (err) {
    if (err instanceof CastEngineError) {
      console.warn(
        `[wsExecutor] abandon skipped (${err.code}): ${err.message}`,
      );
      return { refunded: false };
    }
    throw err;
  }
}

export const CANCEL_GRACE_SECS = CANCEL_CAST_GRACE_SECS;
