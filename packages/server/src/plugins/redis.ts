import fp from "fastify-plugin";
import type Redis from "ioredis";
import { env } from "../config/env.js";
import { buildRedis } from "./redisFactory.js";

declare module "fastify" {
  interface FastifyInstance {
    redis: Redis;
  }
}

export default fp(async (fastify) => {
  // TLS handling for rediss:// (self-signed cert chain on Heroku Redis)
  // lives in buildRedis() — see redisFactory.ts for the audit story.
  const redis = buildRedis(env.REDIS_URL, { maxRetriesPerRequest: null });

  fastify.decorate("redis", redis);

  fastify.addHook("onClose", async () => {
    await redis.quit();
  });
});
