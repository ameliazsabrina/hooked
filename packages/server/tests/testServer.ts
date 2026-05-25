import { randomUUID } from "node:crypto";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { fastifyTRPCPlugin } from "@trpc/server/adapters/fastify";
import { TRPCError } from "@trpc/server";
import { appRouter } from "../src/trpc/router.js";
import { createContext } from "../src/trpc/context.js";
import healthRoutes from "../src/routes/health.js";
import gatewayPlugin from "../src/ws/gateway.js";

export interface BuildTestServerOptions {
  redis: any;
  skipRateLimit?: boolean;
  extraRoutes?: (server: FastifyInstance) => Promise<void> | void;
  requestTimeoutMs?: number;
  connectionTimeoutMs?: number;
}

export async function buildTestServer({
  redis,
  skipRateLimit,
  extraRoutes,
  requestTimeoutMs,
  connectionTimeoutMs,
}: BuildTestServerOptions): Promise<FastifyInstance> {
  const server = Fastify({
    logger: false,
    genReqId: (req) =>
      (req.headers["x-request-id"] as string | undefined) ?? randomUUID(),
    requestTimeout: requestTimeoutMs ?? 30_000,
    connectionTimeout: connectionTimeoutMs ?? 60_000,
  });

  (server as any).decorate("redis", redis);

  await server.register(cors, { origin: true, credentials: true });

  if (!skipRateLimit) {
    await server.register(rateLimit, {
      global: true,
      max: 600,
      timeWindow: "1 minute",
      allowList: (req) =>
        req.url === "/health" || req.url === "/healthz/keeper",
      redis,
      nameSpace: "hooked-rl-test:",
      addHeaders: {
        "x-ratelimit-limit": true,
        "x-ratelimit-remaining": true,
        "x-ratelimit-reset": true,
        "retry-after": true,
      },
    });
  }

  await server.register(healthRoutes);
  await server.register(gatewayPlugin);
  await server.register(fastifyTRPCPlugin, {
    prefix: "/trpc",
    trpcOptions: { router: appRouter, createContext } as any,
  });

  if (extraRoutes) {
    await extraRoutes(server);
  }

  server.setErrorHandler((err: FastifyError, req, reply) => {
    if (err instanceof TRPCError) {
      reply.code(400).send({ error: err.message, requestId: req.id });
      return;
    }
    const status = err.statusCode ?? 500;
    const payload = {
      error: status >= 500 ? "Internal server error" : err.message,
      requestId: req.id,
    };
    reply.code(status).send(payload);
  });

  await server.ready();
  return server;
}
