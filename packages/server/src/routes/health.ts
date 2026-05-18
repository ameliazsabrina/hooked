import type { FastifyInstance } from "fastify";
import { getKeeperHealth } from "../services/keeperHeartbeat.js";

export default async function healthRoutes(fastify: FastifyInstance) {
  fastify.get("/health", async () => {
    return { status: "ok", timestamp: new Date().toISOString() };
  });

  // Per-keeper liveness check (B6 — post-2026-05-18 incident).
  //
  // Returns 200 with a JSON report when every required keeper has ticked
  // within its staleness budget AND hasn't accumulated too many
  // consecutive errors. 500 with the same shape otherwise.
  //
  // Hook this to whatever uptime monitor you have (Heroku scheduler ping,
  // UptimeRobot, BetterStack, etc.) so a dead keeper pages someone
  // instead of being noticed by a player tweeting at you.
  //
  // The shape is stable: external monitors can rely on `healthy: bool`
  // plus a per-keeper array for drill-down.
  fastify.get("/healthz/keeper", async (req, reply) => {
    const report = await getKeeperHealth();
    if (!report.healthy) {
      reply.code(500);
    }
    return report;
  });
}
