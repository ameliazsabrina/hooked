import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
} from "vitest";
import type { FastifyInstance } from "fastify";
import { buildTestServer } from "./testServer.js";
import { makeRedis } from "./setup.js";


describe("Fastify requestTimeout — config propagation", () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    server = await buildTestServer({
      redis: makeRedis(),
      requestTimeoutMs: 500,
      connectionTimeoutMs: 10_000,
      extraRoutes: async (s) => {
        s.get("/_fast", async () => ({ ok: true }));
      },
    });
    await server.ready();
  });

  afterAll(async () => {
    if (server) await server.close();
  });

  it("propagates requestTimeout to Fastify's initial config", () => {
    expect(server.initialConfig.requestTimeout).toBe(500);
  });

  it("propagates requestTimeout to the underlying Node HTTP server", () => {
    expect((server.server as any).requestTimeout).toBe(500);
  });

  it("propagates connectionTimeout to the raw socket-idle timeout", () => {
    expect(server.initialConfig.connectionTimeout).toBe(10_000);
  });

  it("normal requests are unaffected", async () => {
    const res = await server.inject({ method: "GET", url: "/_fast" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});
