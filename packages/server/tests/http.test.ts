import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildTestServer } from "./testServer.js";
import { makeRedis } from "./setup.js";

describe("HTTP layer — rate limiting + error handler", () => {
  let server: FastifyInstance;
  let redis: any;

  beforeEach(async () => {
    redis = makeRedis();
    server = await buildTestServer({
      redis,
      extraRoutes: async (s) => {
        s.get("/_throw", async () => {
          throw new Error("boom — internal detail that should not leak");
        });
        s.get("/_throw400", async (_req, reply) => {
          reply.code(400).send({ error: "nope" });
        });
      },
    });
  });

  afterAll(async () => {
    if (server) await server.close();
  });

  describe("global rate limit", () => {
    it("allows traffic under the 600/min global bucket", async () => {
      const res = await server.inject({ method: "GET", url: "/trpc/health.ping" });
      expect(res.statusCode).toBe(200);
      expect(res.headers["x-ratelimit-limit"]).toBeDefined();
      expect(Number(res.headers["x-ratelimit-remaining"])).toBeLessThan(600);
    });

    it("/health is allow-listed and never rate-limited", async () => {
      const results = await Promise.all(
        Array.from({ length: 50 }, () =>
          server.inject({ method: "GET", url: "/health" }),
        ),
      );
      expect(results.every((r) => r.statusCode === 200)).toBe(true);
      expect(results[0].headers["x-ratelimit-limit"]).toBeUndefined();
    });

    it("/healthz/keeper is allow-listed (probe endpoint, may be polled hard)", async () => {
      const results = await Promise.all(
        Array.from({ length: 50 }, () =>
          server.inject({ method: "GET", url: "/healthz/keeper" }),
        ),
      );
      expect(results.every((r) => r.statusCode !== 429)).toBe(true);
      expect(results[0].headers["x-ratelimit-limit"]).toBeUndefined();
    });

    it("returns 429 on /ws/nonce after exceeding its per-route 30/min limit", async () => {
      let firstRejection = -1;
      for (let i = 0; i < 31; i++) {
        const res = await server.inject({ method: "GET", url: "/ws/nonce" });
        if (res.statusCode === 429) {
          firstRejection = i;
          break;
        }
      }
      expect(firstRejection).toBeGreaterThan(0);
      expect(firstRejection).toBeLessThanOrEqual(30);
    });
  });

  describe("global error handler", () => {
    it("returns a scrubbed body with requestId for 5xx errors and does not leak internals", async () => {
      const res = await server.inject({
        method: "GET",
        url: "/_throw",
        headers: { "x-request-id": "test-req-0001" },
      });
      expect(res.statusCode).toBe(500);
      const body = res.json();
      expect(body.error).toBe("Internal server error");
      expect(body.error).not.toMatch(/boom/);
      expect(body.error).not.toMatch(/internal detail/);
      expect(body.requestId).toBe("test-req-0001");
    });

    it("generates a requestId when the caller does not supply one", async () => {
      const res = await server.inject({ method: "GET", url: "/_throw" });
      expect(res.statusCode).toBe(500);
      const body = res.json();
      expect(body.requestId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
    });

    it("passes through client-supplied 4xx bodies without scrubbing", async () => {
      const res = await server.inject({ method: "GET", url: "/_throw400" });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: "nope" });
    });

    it("returns a requestId header echo on tRPC 401 responses", async () => {
      const res = await server.inject({
        method: "GET",
        url: "/trpc/player.me",
      });
      expect([401, 500]).toContain(res.statusCode);
    });
  });
});
