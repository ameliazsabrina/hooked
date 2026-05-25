import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import {
  fastifyTRPCPlugin,
  type FastifyTRPCPluginOptions,
} from "@trpc/server/adapters/fastify";
import { TRPCError } from "@trpc/server";
import type { FastifyError } from "fastify";
import { appRouter, type AppRouter } from "./trpc/router.js";
import { createContext } from "./trpc/context.js";
import healthRoutes from "./routes/health.js";
import statsRoutes from "./routes/stats.js";
import adminApexFishImageRoutes from "./routes/adminApexFishImage.js";
import databasePlugin from "./plugins/database.js";
import redisPlugin from "./plugins/redis.js";
import gatewayPlugin from "./ws/gateway.js";
import { env, isAllowedOrigin } from "./config/env.js";
import { registerJobs } from "./jobs/queue.js";
import { runRoomLifecycleTick } from "./jobs/roomLifecycle.js";

const REQUEST_TIMEOUT_MS = 30_000;
const CONNECTION_TIMEOUT_MS = 60_000;

async function buildServer() {
  const server = Fastify({
    logger: {
      level: "info",
      ...(env.APP_ENV === "development"
        ? { transport: { target: "pino-pretty" } }
        : {}),
    },
    genReqId: (req) =>
      (req.headers["x-request-id"] as string | undefined) ?? randomUUID(),
    requestTimeout: REQUEST_TIMEOUT_MS,
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    pluginTimeout: 30_000,
    disableRequestLogging: false,
  });

  await server.register(cors, {
    origin: (origin, cb) => {
      if (isAllowedOrigin(origin ?? undefined)) {
        cb(null, true);
        return;
      }
      cb(new Error("CORS: origin not allowed"), false);
    },
    credentials: true,
  });

  await server.register(databasePlugin);

  await server.register(redisPlugin);

  await server.register(rateLimit, {
    global: true,
    max: 600,
    timeWindow: "1 minute",
    allowList: (req) =>
      req.url === "/health" || req.url === "/healthz/keeper",
    redis: server.redis,
    nameSpace: "hooked-rl:",
    addHeaders: {
      "x-ratelimit-limit": true,
      "x-ratelimit-remaining": true,
      "x-ratelimit-reset": true,
      "retry-after": true,
    },
  });

  await server.register(healthRoutes);
  await server.register(statsRoutes);
  await server.register(adminApexFishImageRoutes);

  await server.register(gatewayPlugin);

  await server.register(fastifyTRPCPlugin, {
    prefix: "/trpc",
    trpcOptions: {
      router: appRouter,
      createContext,
      onError: ({ error, path, ctx }) => {
        if (error.code === "INTERNAL_SERVER_ERROR") {
          server.log.error(
            { err: error, path, walletAddress: ctx?.walletAddress ?? null },
            "tRPC internal error",
          );
        }
      },
    } satisfies FastifyTRPCPluginOptions<AppRouter>["trpcOptions"],
  });

  // Catches non-tRPC errors (webhook, WS nonce, health).
  server.setErrorHandler((err: FastifyError, req, reply) => {
    if (err instanceof TRPCError) {
      reply.code(400).send({ error: err.message, requestId: req.id });
      return;
    }
    const status = err.statusCode ?? 500;
    req.log.error({ err, reqId: req.id }, "request errored");
    const payload = {
      error: status >= 500 ? "Internal server error" : err.message,
      requestId: req.id,
    };
    reply.code(status).send(payload);
  });

  registerJobs(env.REDIS_URL);

  // BullMQ schedulers don't backfill missed runs across a restart — run
  // the watchdog once on boot so deployments crossing 02:00/14:00 UTC heal.
  runRoomLifecycleTick((msg) => server.log.info(`[boot watchdog] ${msg}`)).catch(
    (err) => {
      server.log.error({ err }, "boot room lifecycle tick failed");
    },
  );

  return server;
}

async function main() {
  const server = await buildServer();

  try {
    await server.listen({ port: env.PORT, host: env.HOST });
    server.log.info(`Server ready at http://${env.HOST}:${env.PORT}`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}

process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err);
});

main();
