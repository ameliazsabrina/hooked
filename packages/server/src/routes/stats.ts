import type { FastifyInstance } from "fastify";
import { FishingSession, Player, Room } from "../db/schema.js";

export default async function statsRoutes(fastify: FastifyInstance) {
  fastify.get("/stats/public", async (_req, reply) => {
    const [roomsOpened, depositedAgg, castsAgg] = await Promise.all([
      // Every room ever created, across all phases.
      Room.countDocuments({}),
      // All SOL ever deposited — sum of every player deposit across the full
      // deposit history (Player.deposits captures both legacy pool deposits and
      // room deposits; Room.players only holds the latter).
      Player.aggregate<{ _id: null; total: number }>([
        { $unwind: "$deposits" },
        { $group: { _id: null, total: { $sum: "$deposits.amount" } } },
      ]),
      // Total casts attempted across every fishing session.
      FishingSession.aggregate<{ _id: null; total: number }>([
        { $group: { _id: null, total: { $sum: "$castCount" } } },
      ]),
    ]);

    reply.header("cache-control", "public, max-age=30");
    return {
      roomsOpened,
      solDeposited: depositedAgg[0]?.total ?? 0,
      castsMade: castsAgg[0]?.total ?? 0,
    };
  });
}
