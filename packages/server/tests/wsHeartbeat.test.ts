import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
import { buildTestServer } from "./testServer.js";
import { makeRedis } from "./setup.js";

describe("WebSocket — heartbeat & auth timeout", () => {
  let server: FastifyInstance;
  let wsUrl: string;
  const prevHeartbeat = process.env.WS_HEARTBEAT_MS;
  const prevAuth = process.env.WS_AUTH_TIMEOUT_MS;

  beforeAll(async () => {
    server = await buildTestServer({ redis: makeRedis() });
    const address = await server.listen({ port: 0, host: "127.0.0.1" });
    wsUrl = address.replace(/^http/, "ws") + "/ws/gateway";
  });

  afterAll(async () => {
    if (server) await server.close();
    process.env.WS_HEARTBEAT_MS = prevHeartbeat;
    process.env.WS_AUTH_TIMEOUT_MS = prevAuth;
  });

  function waitForClose(ws: WebSocket): Promise<number> {
    return new Promise((resolve) => ws.once("close", (code) => resolve(code)));
  }

  it("closes an unauthenticated socket after the auth timeout (4001)", async () => {
    // Tiny auth timeout; keep heartbeat long so it doesn't interfere.
    process.env.WS_AUTH_TIMEOUT_MS = "60";
    process.env.WS_HEARTBEAT_MS = "100000";

    const ws = new WebSocket(wsUrl);
    await new Promise<void>((r) => ws.once("open", () => r()));
    const code = await Promise.race([
      waitForClose(ws),
      new Promise<number>((_, rej) =>
        setTimeout(() => rej(new Error("no close within 1s")), 1000),
      ),
    ]);
    expect(code).toBe(4001);
  });

  it("terminates a socket that stops answering pings", async () => {
    // Tiny heartbeat; keep auth timeout long so it doesn't interfere.
    process.env.WS_HEARTBEAT_MS = "40";
    process.env.WS_AUTH_TIMEOUT_MS = "100000";

    // autoPong:false → client never answers server pings → missed-pong reaper.
    const ws = new WebSocket(wsUrl, { autoPong: false });
    await new Promise<void>((r) => ws.once("open", () => r()));
    const closed = await Promise.race([
      waitForClose(ws).then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), 1000)),
    ]);
    expect(closed).toBe(true);
    try {
      ws.terminate();
    } catch {
      // already gone
    }
  });
});
