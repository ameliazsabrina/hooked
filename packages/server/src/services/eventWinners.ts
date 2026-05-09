import type { Types } from "mongoose";

import { Catch, FishingEvent, Player, type FishingEventFinalRank } from "../db/schema.js";

/**
 * Prize-pool split formula for event winners. Top 10 by score. Weights sum
 * to 100 so the total payout always equals `prizePoolSol` (modulo 1e-9
 * rounding from JS floats — payments truncate to 9 decimals downstream).
 *
 * Mirrors the leaderboard-style payout shape the rest of the codebase uses
 * (see roomWinnerSchema, dailyLeaderboardSchema). Tweak the array to
 * change the curve; the rest of the pipeline doesn't care about length.
 */
export const EVENT_PRIZE_WEIGHTS_PCT: readonly number[] = [
  40, 20, 15, 10, 5, 3, 2, 2, 2, 1,
];

export interface ComputeEventWinnersOptions {
  /** Override `now` for deterministic tests. */
  now?: Date;
  /**
   * Allow re-computation even when finalRanks already exist. By default the
   * function refuses to overwrite a populated finalRanks array (idempotent
   * by default so paying out partial winners doesn't get reset). Pass true
   * from the admin dashboard to force a recompute, e.g. after fixing a bug.
   */
  force?: boolean;
}

export interface ComputeEventWinnersResult {
  eventId: string;
  ranks: FishingEventFinalRank[];
  /** True if a previously-computed finalRanks was already present. */
  alreadyComputed: boolean;
}

/**
 * Aggregate event-window catches by player, rank by total score, apply the
 * prize-pool split, and persist `finalRanks` on the event document. Used by
 * both the admin `computeWinners` route and the lifecycle worker on auto-end.
 *
 * Trust model: catches are persisted server-side at submit time
 * (services/fishing/castEngine.submitInputSamples), so the score totals are
 * the same numbers the audit Merkle root commits to. A subsequent admin who
 * forces a re-compute can verify against those audit Merkle roots.
 */
export async function computeEventWinners(
  eventId: string,
  options: ComputeEventWinnersOptions = {},
): Promise<ComputeEventWinnersResult> {
  const event = await FishingEvent.findById(eventId);
  if (!event) {
    throw new Error(`Event ${eventId} not found`);
  }

  const now = options.now ?? new Date();
  if (event.endsAt.getTime() > now.getTime()) {
    throw new Error(
      `Event ${eventId} hasn't ended yet (endsAt=${event.endsAt.toISOString()}, now=${now.toISOString()})`,
    );
  }

  const alreadyComputed = Array.isArray(event.finalRanks) && event.finalRanks.length > 0;
  if (alreadyComputed && !options.force) {
    return {
      eventId: String(event._id),
      ranks: event.finalRanks ?? [],
      alreadyComputed: true,
    };
  }

  // Aggregate catches in [startsAt, endsAt] by player, summed score. Sorted
  // desc and capped at the prize-weight length — extra players don't get
  // ranks. Tie-break is implicit: Mongo's sort with equal scores defers to
  // _id order, which is stable.
  const aggregated = await Catch.aggregate<{
    _id: Types.ObjectId;
    score: number;
  }>([
    {
      $match: {
        caughtAt: { $gte: event.startsAt, $lte: event.endsAt },
      },
    },
    { $group: { _id: "$playerId", score: { $sum: "$score" } } },
    { $sort: { score: -1, _id: 1 } },
    { $limit: EVENT_PRIZE_WEIGHTS_PCT.length },
  ]);

  if (aggregated.length === 0) {
    // No catches in the window — nothing to award. Persist empty array so
    // the admin dashboard distinguishes "computed: zero winners" from
    // "not yet computed" (null).
    await FishingEvent.updateOne({ _id: event._id }, { $set: { finalRanks: [] } });
    return { eventId: String(event._id), ranks: [], alreadyComputed: false };
  }

  // Resolve playerIds → wallet + display name in one round-trip.
  const playerIds = aggregated.map((row) => row._id);
  const playerDocs = await Player.find(
    { _id: { $in: playerIds } },
    { walletAddress: 1, nickname: 1 },
  ).lean();
  const playerById = new Map(
    playerDocs.map((p) => [
      String(p._id),
      {
        walletAddress: p.walletAddress,
        displayName: p.nickname ?? "Anonymous",
      },
    ]),
  );

  const ranks: FishingEventFinalRank[] = aggregated.map((row, i) => {
    const player = playerById.get(String(row._id));
    const weightPct = EVENT_PRIZE_WEIGHTS_PCT[i] ?? 0;
    const prizeSol =
      Math.round(((event.prizePoolSol * weightPct) / 100) * 1e9) / 1e9;
    return {
      rank: i + 1,
      walletAddress: player?.walletAddress ?? "",
      displayName: player?.displayName ?? "Anonymous",
      score: row.score,
      prizeSol,
      paid: false,
      signature: null,
      paidAt: null,
      attempts: 0,
      lastError: null,
    };
  });

  await FishingEvent.updateOne(
    { _id: event._id },
    { $set: { finalRanks: ranks } },
  );

  return {
    eventId: String(event._id),
    ranks,
    alreadyComputed: false,
  };
}
