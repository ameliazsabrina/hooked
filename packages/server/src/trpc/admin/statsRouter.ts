import { adminSessionProcedure, router } from "../trpc.js";
import {
  AdminAuditLog,
  Catch,
  FishingSession,
  ReactionLog,
  Room,
} from "../../db/schema.js";
import {
  getRoomsConnection,
  loadLpManagerKeypair,
  loadTreasuryKeypair,
} from "../../solana/roomsProgram.js";

const SUSPICIOUS_REACTION_MS = 100;

export const adminStatsRouter = router({
  summary: adminSessionProcedure.query(async () => {
    const since24h = new Date(Date.now() - 24 * 3600_000);
    const [
      activeRooms,
      entryRooms,
      settlingRooms,
      closedRooms,
      lpFailures,
      stuckReturns,
      depositedAgg,
      recentAudit,
      recentRooms,
      activeSessions,
      sessions24h,
      catches24h,
      apexCatches24h,
      reactionsSuspicious24h,
      pendingScoreBridge,
    ] = await Promise.all([
      Room.countDocuments({ phase: "active" }),
      Room.countDocuments({ phase: "entry" }),
      Room.countDocuments({ phase: "settling" }),
      Room.countDocuments({ phase: "closed" }),
      Room.countDocuments({ "lp.status": "failed" }),
      Room.countDocuments({
        phase: "closed",
        "players.returned": false,
      }),
      Room.aggregate<{ _id: null; totalSol: number }>([
        { $match: { phase: { $in: ["entry", "active", "settling"] } } },
        { $group: { _id: null, totalSol: { $sum: "$depositedSol" } } },
      ]),
      AdminAuditLog.find()
        .sort({ timestamp: -1 })
        .limit(5)
        .lean(),
      Room.find()
        .sort({ createdAt: -1 })
        .limit(5)
        .select({
          roomId: 1,
          phase: 1,
          createdAt: 1,
          depositedSol: 1,
          capacitySol: 1,
          realPlayerCount: 1,
          maxPlayers: 1,
          createdByAdmin: 1,
        })
        .lean(),
      // Fishing telemetry — added after hooked_fishing was retired and sessions moved to MongoDB.
      FishingSession.countDocuments({ status: "active" }),
      FishingSession.countDocuments({ startedAt: { $gte: since24h } }),
      Catch.countDocuments({ caughtAt: { $gte: since24h } }),
      Catch.countDocuments({
        caughtAt: { $gte: since24h },
        rarity: "apex",
      }),
      ReactionLog.countDocuments({
        createdAt: { $gte: since24h },
        reactionTimeMs: { $gt: 0, $lt: SUSPICIOUS_REACTION_MS },
      }),
      // Committed but not yet score-bridged — keeper job stuck or RPC down.
      FishingSession.countDocuments({
        status: "committed",
        chainScoreTxSignature: null,
      }),
    ]);

    const conn = getRoomsConnection();
    const lpManager = loadLpManagerKeypair();
    const treasury = loadTreasuryKeypair();
    const [lpBalance, treasuryBalance] = await Promise.all([
      lpManager
        ? conn.getBalance(lpManager.publicKey).catch(() => null)
        : Promise.resolve(null),
      treasury
        ? conn.getBalance(treasury.publicKey).catch(() => null)
        : Promise.resolve(null),
    ]);

    return {
      counts: {
        entry: entryRooms,
        active: activeRooms,
        settling: settlingRooms,
        closed: closedRooms,
        lpFailures,
        stuckReturns,
      },
      totalLiveDepositedSol: depositedAgg[0]?.totalSol ?? 0,
      lpManagerLamports: lpBalance,
      treasuryLamports: treasuryBalance,
      lpManagerAddress: lpManager?.publicKey.toBase58() ?? null,
      treasuryAddress: treasury?.publicKey.toBase58() ?? null,
      recentAudit,
      recentRooms,
      fishing: {
        activeSessions,
        sessions24h,
        catches24h,
        apexCatches24h,
        reactionsSuspicious24h,
        pendingScoreBridge,
        suspiciousThresholdMs: SUSPICIOUS_REACTION_MS,
      },
    };
  }),
});
