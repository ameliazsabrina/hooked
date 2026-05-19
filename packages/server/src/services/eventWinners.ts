import type { Types } from "mongoose";

import { Catch, FishingEvent, Player, type FishingEventFinalRank } from "../db/schema.js";

/** Top-N by score. Weights sum to 100 = full prizePoolSol. */
export const EVENT_PRIZE_WEIGHTS_PCT: readonly number[] = [
  40, 20, 15, 10, 5, 3, 2, 2, 2, 1,
];

export interface ComputeEventWinnersOptions {
  now?: Date;
  /** Recompute even when finalRanks is already populated. */
  force?: boolean;
}

export interface ComputeEventWinnersResult {
  eventId: string;
  ranks: FishingEventFinalRank[];
  /** True if a previously-computed finalRanks was already present. */
  alreadyComputed: boolean;
}

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

  // Tie-break on _id (stable).
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
    // Persist [] so "computed: zero winners" is distinguishable from null.
    await FishingEvent.updateOne({ _id: event._id }, { $set: { finalRanks: [] } });
    return { eventId: String(event._id), ranks: [], alreadyComputed: false };
  }

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
