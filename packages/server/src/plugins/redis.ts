import fp from "fastify-plugin";
import Redis from "ioredis";
import { env } from "../config/env.js";

declare module "fastify" {
  interface FastifyInstance {
    redis: Redis;
  }
}

export default fp(async (fastify) => {
  // Heroku Redis (rediss://) terminates TLS with a self-signed cert chain;
  // ioredis rejects it by default. Disable cert verification only on TLS URLs.
  const useTls = env.REDIS_URL.startsWith("rediss://");
  const redis = new Redis(env.REDIS_URL, {
    ...(useTls ? { tls: { rejectUnauthorized: false } } : {}),
    maxRetriesPerRequest: null,
  });

  fastify.decorate("redis", redis);

  fastify.addHook("onClose", async () => {
    await redis.quit();
  });
});
