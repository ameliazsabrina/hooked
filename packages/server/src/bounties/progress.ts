import type { Types } from "mongoose";
import {
  BountyPeriod,
  type BountyPeriodDocument,
  type CatchDocument,
  Player,
  PlayerBountyProgress,
  type PlayerBountyProgressDocument,
} from "../db/schema.js";
import { getQueues } from "../jobs/queue.js";
import { getOrCreateCurrentPeriod } from "./period.js";

type PeriodWithId = BountyPeriodDocument & { _id: Types.ObjectId };
type ProgressWithId = PlayerBountyProgressDocument & { _id: Types.ObjectId };

async function getActivePeriods(): Promise<PeriodWithId[]> {
  const weekly = await getOrCreateCurrentPeriod("weekly");
  return [weekly] as unknown as PeriodWithId[];
}

async function bumpProgress(opts: {
  playerId: Types.ObjectId;
  periodId: Types.ObjectId;
  slot: number;
  target: number;
  delta: number;
  setTo?: number;
}): Promise<ProgressWithId | null> {
  const { playerId, periodId, slot, target, delta, setTo } = opts;

  await PlayerBountyProgress.updateOne(
    { playerId, periodId, slot },
    {
      $setOnInsert: {
        playerId,
        periodId,
        slot,
        target,
        progress: 0,
        completed: false,
        rewardCredited: false,
      },
    },
    { upsert: true }
  );

  const update =
    typeof setTo === "number"
      ? { $max: { progress: setTo } }
      : { $inc: { progress: delta } };

  const bumped = await PlayerBountyProgress.findOneAndUpdate(
    { playerId, periodId, slot, completed: false },
    update,
    { new: true }
  ).lean();

  if (!bumped) return null;
  const doc = bumped as ProgressWithId;
  if (doc.progress < target) return null;

  const flipped = await PlayerBountyProgress.findOneAndUpdate(
    { _id: doc._id, completed: false },
    { $set: { completed: true, completedAt: new Date() } },
    { new: true }
  ).lean();
  return (flipped as ProgressWithId | null) ?? null;
}

async function creditReward(
  progress: ProgressWithId,
  period: PeriodWithId,
  walletAddress: string
): Promise<void> {
  const slotDef = period.slots.find((s) => s.slot === progress.slot);
  if (!slotDef) return;

  if (slotDef.reward.kind === "shells") {
    const amount = slotDef.reward.amount ?? 0;
    const claim = await PlayerBountyProgress.findOneAndUpdate(
      { _id: progress._id, rewardCredited: false },
      {
        $set: { rewardCredited: true, rewardShellsCredited: amount },
      },
      { new: true }
    ).lean();
    if (!claim) return;
    await Player.updateOne(
      { _id: progress.playerId },
      { $inc: { shellBalance: amount } }
    );
    return;
  }

  if (slotDef.reward.kind === "sol") {
    const lamports = slotDef.reward.lamports ?? 0;
    const claim = await PlayerBountyProgress.findOneAndUpdate(
      { _id: progress._id, rewardCredited: false },
      {
        $set: {
          rewardCredited: true,
          rewardSolPayoutStatus: "pending",
        },
      },
      { new: true }
    ).lean();
    if (!claim) return;

    const { bountySolPayoutQueue } = getQueues();
    if (bountySolPayoutQueue) {
      await bountySolPayoutQueue.add(
        "bounty-sol-payout",
        {
          progressId: String(progress._id),
          walletAddress,
          lamports,
        },
        {
          attempts: 5,
          backoff: { type: "exponential", delay: 30_000 },
          removeOnComplete: 100,
          removeOnFail: 500,
        }
      );
    } else {
      console.error(
        "[bounty] SOL payout queue not initialized — marking failed",
        { progressId: String(progress._id) }
      );
      await PlayerBountyProgress.updateOne(
        { _id: progress._id },
        { $set: { rewardSolPayoutStatus: "failed" } }
      );
    }
  }
}

export async function applyCatchToBounties(
  playerId: Types.ObjectId,
  catchDoc: Pick<CatchDocument, "rarity" | "score">,
  walletAddress: string
): Promise<void> {
  const periods = await getActivePeriods();

  for (const period of periods) {
    for (const slot of period.slots) {
      let completed: ProgressWithId | null = null;

      if (
        slot.goalType === "catch_rarity_count" &&
        slot.goalParams?.rarity &&
        catchDoc.rarity === slot.goalParams.rarity
      ) {
        completed = await bumpProgress({
          playerId,
          periodId: period._id,
          slot: slot.slot,
          target: slot.target,
          delta: 1,
        });
      } else if (
        slot.goalType === "catch_single_trigger" &&
        slot.goalParams?.rarity &&
        catchDoc.rarity === slot.goalParams.rarity
      ) {
        completed = await bumpProgress({
          playerId,
          periodId: period._id,
          slot: slot.slot,
          target: slot.target,
          delta: 0,
          setTo: slot.target,
        });
      } else if (slot.goalType === "catch_score_threshold") {
        completed = await bumpProgress({
          playerId,
          periodId: period._id,
          slot: slot.slot,
          target: slot.target,
          delta: catchDoc.score,
        });
      }

      if (completed) {
        await creditReward(completed, period, walletAddress);
      }
    }
  }
}

export async function awardLeaderboardRankBounty(opts: {
  playerId: Types.ObjectId;
  walletAddress: string;
  period: PeriodWithId;
  rank: number;
}): Promise<void> {
  const { playerId, walletAddress, period, rank } = opts;

  for (const slot of period.slots) {
    if (slot.goalType !== "leaderboard_rank") continue;
    const rankLeq = slot.goalParams?.rankLeq;
    if (typeof rankLeq !== "number" || rank > rankLeq) continue;

    const completed = await bumpProgress({
      playerId,
      periodId: period._id,
      slot: slot.slot,
      target: slot.target,
      delta: 0,
      setTo: slot.target,
    });

    if (completed) {
      await creditReward(completed, period, walletAddress);
    }
  }
}

export async function listActiveBountiesForPlayer(
  playerId: Types.ObjectId
): Promise<
  Array<{
    periodId: string;
    cadence: "weekly";
    slot: number;
    templateId: string;
    label: string;
    reward:
      | { kind: "shells"; amount: number }
      | { kind: "sol"; lamports: number };
    target: number;
    progress: number;
    completed: boolean;
    completedAt: Date | null;
    endsAt: Date;
    rewardTxSignature: string | null;
    rewardSolPayoutStatus:
      | "pending"
      | "sent"
      | "failed"
      | null;
  }>
> {
  const weekly = await getOrCreateCurrentPeriod("weekly");
  const periods = [weekly] as unknown as PeriodWithId[];

  const progressDocs = await PlayerBountyProgress.find({
    playerId,
    periodId: { $in: periods.map((p) => p._id) },
  }).lean();

  const progressMap = new Map<string, ProgressWithId>();
  for (const p of progressDocs as ProgressWithId[]) {
    progressMap.set(`${String(p.periodId)}:${p.slot}`, p);
  }

  const result: Awaited<ReturnType<typeof listActiveBountiesForPlayer>> = [];
  for (const period of periods) {
    for (const slot of period.slots) {
      const key = `${String(period._id)}:${slot.slot}`;
      const p = progressMap.get(key);
      const reward =
        slot.reward.kind === "shells"
          ? { kind: "shells" as const, amount: slot.reward.amount ?? 0 }
          : { kind: "sol" as const, lamports: slot.reward.lamports ?? 0 };
      result.push({
        periodId: String(period._id),
        cadence: period.cadence,
        slot: slot.slot,
        templateId: slot.templateId,
        label: slot.label,
        reward,
        target: slot.target,
        progress: p?.progress ?? 0,
        completed: p?.completed ?? false,
        completedAt: (p?.completedAt as Date | null) ?? null,
        endsAt: period.endsAt,
        rewardTxSignature: p?.rewardTxSignature ?? null,
        rewardSolPayoutStatus:
          (p?.rewardSolPayoutStatus as
            | "pending"
            | "sent"
            | "failed"
            | null) ?? null,
      });
    }
  }

  return result;
}

export { BountyPeriod };
