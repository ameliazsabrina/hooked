import type { FastifyInstance } from "fastify";
import { getKeeperHealth } from "../services/keeperHeartbeat.js";

export default async function healthRoutes(fastify: FastifyInstance) {
  fastify.get("/health", async () => {
    return { status: "ok", timestamp: new Date().toISOString() };
  });

  fastify.get("/healthz/keeper", async (req, reply) => {
    const report = await getKeeperHealth();
    if (!report.healthy) {
      reply.code(500);
    }
    return report;
  });
}
