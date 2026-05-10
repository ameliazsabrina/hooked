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

  // Global HTTP flood protection. Per-IP by default; webhook and tRPC auth
  // paths get tighter limits via route-level config below.
  await server.register(rateLimit, {
    global: true,
    max: 600,
    timeWindow: "1 minute",
    allowList: (req) => req.url === "/health",
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
  await server.register(adminApexFishImageRoutes);

  await server.register(gatewayPlugin);

  await server.register(fastifyTRPCPlugin, {
    prefix: "/trpc",
    trpcOptions: {
      router: appRouter,
      createContext,
      onError: ({ error, path, ctx }) => {
        // Log server-side with enough detail to debug; the client only sees the
        // sanitized TRPCError shape.
        if (error.code === "INTERNAL_SERVER_ERROR") {
          server.log.error(
            { err: error, path, walletAddress: ctx?.walletAddress ?? null },
            "tRPC internal error",
          );
        }
      },
    } satisfies FastifyTRPCPluginOptions<AppRouter>["trpcOptions"],
  });

  // Central error handler — tRPC's plugin handles its own errors, so this
  // mainly catches thrown errors from plain HTTP routes (webhook, WS nonce,
  // health). Clients receive { error, requestId }; server logs hold the detail.
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

  // BullMQ's `every` schedulers and the `0 2,14 * * *` cron only fire at
  // their next future boundary — they don't backfill missed runs. So a
  // server restart that crosses 02:00 or 14:00 UTC, or a fresh deploy,
  // would otherwise leave players staring at "no room for entry" until
  // the next boundary. Run the watchdog once on boot so it self-heals
  // immediately if no joinable room exists.
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
