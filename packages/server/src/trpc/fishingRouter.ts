import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { Player, FishingSession } from "../db/schema.js";
import { enqueueScoreBridge } from "../jobs/queue.js";
import { baitAmountForDeposit } from "../services/baitAmount.js";
import { getActiveEvent } from "../services/eventConfig.js";
import {
  cancelCast,
  initiateCast,
  submitInputSamples,
} from "../services/fishing/castEngine.js";
import { dailySeedDateFor, loadDailySeed } from "../services/fishing/dailySeed.js";
import { mapFishingError } from "../services/fishing/errorMapper.js";
import {
  commitSession,
  startSession,
} from "../services/fishing/sessionEngine.js";
import { assignWindow } from "../services/fishing/window.js";
import { protectedProcedure, publicProcedure, router } from "./trpc.js";

const ObjectIdString = z
  .string()
  .regex(/^[0-9a-f]{24}$/i, "Must be a 24-char hex ObjectId");

const SessionStartOutput = z
  .object({
    sessionId: z.string(),
    dateKey: z.number().int(),
    window: z.union([z.literal(0), z.literal(1)]),
    baitInitial: z.number().int().nonnegative(),
    baitRemaining: z.number().int().nonnegative(),
    status: z.enum(["active", "committed", "abandoned"]),
    startedAt: z.string(),
    eventApexBpAtStart: z.number().int().nonnegative(),
    isNew: z.boolean(),
  })
  .strict();

const CastInitiateInput = z.object({ sessionId: ObjectIdString }).strict();
const CastInitiateOutput = z
  .object({
    castIndex: z.number().int().positive(),
    speciesId: z.number().int().nonnegative(),
    rarity: z.number().int().min(0).max(4),
    weightHg: z.number().int().nonnegative(),
    greenZoneStart: z.number().int().nonnegative(),
    greenZoneWidth: z.number().int().positive(),
    mechanic: z.number().int().min(0).max(1),
    baitRemaining: z.number().int().nonnegative(),
    castAt: z.string(),
    seedHash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

const CastCancelInput = z.object({ sessionId: ObjectIdString }).strict();
const CastCancelOutput = z
  .object({ baitRemaining: z.number().int().nonnegative() })
  .strict();

const CastSubmitInput = z
  .object({
    sessionId: ObjectIdString,
    hit: z.boolean(),
    weightHg: z.number().int().nonnegative().max(2000).optional(),
  })
  .strict();
const CastSubmitOutput = z
  .object({
    hit: z.boolean(),
    catchId: z.string().nullable(),
    score: z.number().int().nonnegative(),
    sessionScore: z.number().int().nonnegative(),
    pityCounter: z.number().int().nonnegative(),
    catchCount: z.number().int().nonnegative(),
  })
  .strict();

const SessionCommitInput = z.object({ sessionId: ObjectIdString }).strict();
const SessionCommitOutput = z
  .object({
    sessionId: z.string(),
    sessionScore: z.number().int().nonnegative(),
    catchCount: z.number().int().nonnegative(),
    baitUnused: z.number().int().nonnegative(),
    merkleRoot: z.string().regex(/^[0-9a-f]{64}$/),
    committedAt: z.string(),
    alreadyCommitted: z.boolean(),
  })
  .strict();

const ApexFishStatusEntry = z.object({
  id: z.string().regex(/^[0-9a-f]{24}$/i),
  name: z.string(),
  weightMinKg: z.number().nonnegative(),
  weightMaxKg: z.number().nonnegative(),
  assetUrl: z.string().url(),
});

const EventsCurrentOutput = z
  .object({
    active: z.boolean(),
    name: z.string(),
    startsAt: z.number().nullable(),
    endsAt: z.number().nullable(),
    apexBp: z.number().int().nonnegative(),
    apexFishes: z.array(ApexFishStatusEntry),
  })
  .strict();

async function assertOwnedSession(
  sessionId: string,
  walletAddress: string,
): Promise<void> {
  const session = await FishingSession.findById(sessionId)
    .select({ walletAddress: 1 })
    .lean();
  if (!session) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Session not found" });
  }
  if (session.walletAddress !== walletAddress) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Not your session" });
  }
}

/** Picks the most recent un-returned deposit (1 deposit per (date, window)). */
async function deriveBaitForWallet(
  walletAddress: string,
): Promise<{ baitInitial: number; tier: number; roomId: string }> {
  const player = await Player.findOne({ walletAddress }).lean();
  if (!player) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Player not found" });
  }
  const active = (player.deposits ?? [])
    .filter((d) => !d.returned)
    .sort((a, b) => b.depositedAt.getTime() - a.depositedAt.getTime())[0];
  if (!active) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "No active room deposit — cannot start a fishing session",
    });
  }
  let baitInitial: number;
  try {
    baitInitial = baitAmountForDeposit(active.amount);
  } catch (err) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Invalid deposit for bait derivation: ${(err as Error).message}`,
    });
  }
  // Tier derived from deposit in 0.5 SOL steps.
  const tier = Math.min(4, Math.max(1, Math.round(active.amount / 0.5)));
  return { baitInitial, tier, roomId: active.poolId };
}

export const fishingRouter = router({
  /** Idempotent within (player, UTC window). */
  sessionStart: protectedProcedure
    .output(SessionStartOutput)
    .mutation(async ({ ctx }) => {
      try {
        const { baitInitial, tier, roomId } = await deriveBaitForWallet(
          ctx.walletAddress,
        );
        const event = getActiveEvent();
        const now = new Date();
        const result = await startSession({
          walletAddress: ctx.walletAddress,
          roomId,
          baitInitial,
          tier,
          event: event
            ? {
                active: true,
                name: event.name,
                apexBp: event.apexBp,
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
        return {
          sessionId: result.sessionId,
          dateKey: result.dateKey,
          window: result.window,
          baitInitial: result.baitInitial,
          baitRemaining: result.baitRemaining,
          status: result.status,
          startedAt: result.startedAt.toISOString(),
          eventApexBpAtStart: result.eventApexBpAtStart,
          isNew: result.isNew,
        };
      } catch (err) {
        mapFishingError(err);
      }
    }),

  /** Used on reconnect to restore HUD state. */
  sessionCurrent: protectedProcedure
    .output(SessionStartOutput.nullable())
    .query(async ({ ctx }) => {
      const { window, dateKey } = assignWindow(new Date());
      const session = await FishingSession.findOne({
        walletAddress: ctx.walletAddress,
        dateKey,
        window,
        status: "active",
      }).lean();
      if (!session) return null;
      return {
        sessionId: String(session._id),
        dateKey: session.dateKey,
        window: session.window as 0 | 1,
        baitInitial: session.baitInitial,
        baitRemaining: session.baitRemaining,
        status: session.status as "active" | "committed" | "abandoned",
        startedAt: session.startedAt.toISOString(),
        eventApexBpAtStart: session.eventApexBpAtStart,
        isNew: false,
      };
    }),

  /** Score push to chain is async via the scoreBridge keeper. */
  sessionCommit: protectedProcedure
    .input(SessionCommitInput)
    .output(SessionCommitOutput)
    .mutation(async ({ ctx, input }) => {
      try {
        await assertOwnedSession(input.sessionId, ctx.walletAddress);
        const result = await commitSession({ sessionId: input.sessionId });
        // BullMQ dedupes on sessionId; no-op when queue not registered (tests).
        await enqueueScoreBridge(result.sessionId).catch((err) => {
          console.error(
            `[fishingRouter] enqueue scoreBridge failed for ${result.sessionId}: ${(err as Error).message}`,
          );
        });
        return {
          sessionId: result.sessionId,
          sessionScore: result.sessionScore,
          catchCount: result.catchCount,
          baitUnused: result.baitUnused,
          merkleRoot: result.merkleRoot.toString("hex"),
          committedAt: result.committedAt.toISOString(),
          alreadyCommitted: result.alreadyCommitted,
        };
      } catch (err) {
        mapFishingError(err);
      }
    }),

  /** Decrement bait, roll catch via HMAC-SHA256, persist pendingCast. */
  castInitiate: protectedProcedure
    .input(CastInitiateInput)
    .output(CastInitiateOutput)
    .mutation(async ({ ctx, input }) => {
      try {
        await assertOwnedSession(input.sessionId, ctx.walletAddress);
        const dailySeed = await loadDailySeed();
        const result = await initiateCast({ sessionId: input.sessionId, dailySeed });
        return {
          castIndex: result.castIndex,
          speciesId: result.speciesId,
          rarity: result.rarity,
          weightHg: result.weightHg,
          greenZoneStart: result.greenZoneStart,
          greenZoneWidth: result.greenZoneWidth,
          mechanic: result.mechanic,
          baitRemaining: result.baitRemaining,
          castAt: result.castAt.toISOString(),
          seedHash: result.seedHash.toString("hex"),
        };
      } catch (err) {
        mapFishingError(err);
      }
    }),

  /** 8s grace. Refunds bait; castCount stays monotonic to prevent re-rolls. */
  castCancel: protectedProcedure
    .input(CastCancelInput)
    .output(CastCancelOutput)
    .mutation(async ({ ctx, input }) => {
      try {
        await assertOwnedSession(input.sessionId, ctx.walletAddress);
        const result = await cancelCast({ sessionId: input.sessionId });
        return result;
      } catch (err) {
        mapFishingError(err);
      }
    }),

  castSubmit: protectedProcedure
    .input(CastSubmitInput)
    .output(CastSubmitOutput)
    .mutation(async ({ ctx, input }) => {
      try {
        await assertOwnedSession(input.sessionId, ctx.walletAddress);
        const result = await submitInputSamples({
          sessionId: input.sessionId,
          hit: input.hit,
          weightHg: input.weightHg,
        });
        return result;
      } catch (err) {
        mapFishingError(err);
      }
    }),

  eventsCurrent: publicProcedure
    .output(EventsCurrentOutput)
    .query(async () => {
      const event = getActiveEvent();
      if (!event) {
        return {
          active: false,
          name: "",
          startsAt: null,
          endsAt: null,
          apexBp: 0,
          apexFishes: [],
        };
      }
      return {
        active: true,
        name: event.name,
        startsAt: event.startsAt,
        endsAt: event.endsAt,
        apexBp: event.apexBp,
        apexFishes: event.apexFishes,
      };
    }),
});
