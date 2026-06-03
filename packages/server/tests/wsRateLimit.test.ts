import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
import { buildTestServer } from "./testServer.js";
import { makeRedis } from "./setup.js";

describe("WebSocket — per-event rate limiting", () => {
  let server: FastifyInstance;
  let url: string;

  beforeAll(async () => {
    server = await buildTestServer({ redis: makeRedis() });
    const address = await server.listen({ port: 0, host: "127.0.0.1" });
    url = address.replace(/^http/, "ws") + "/ws/gateway";
  });

  afterAll(async () => {
    if (server) await server.close();
  });

  function openSocket(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.once("open", () => resolve(ws));
      ws.once("error", reject);
    });
  }

  it("throttles a ping flood to roughly the control-class burst", async () => {
    const ws = await openSocket();
    let pongs = 0;
    ws.on("message", (buf) => {
      const msg = JSON.parse(Buffer.from(buf as Buffer).toString("utf8"));
      if (msg.type === "pong") pongs += 1;
    });

    // Control bucket: 5/s, burst 10. 40 synchronous pings should mostly drop.
    for (let i = 0; i < 40; i++) {
      ws.send(JSON.stringify({ type: "ping", t: i }));
    }
    await new Promise((r) => setTimeout(r, 300));

    expect(pongs).toBeGreaterThanOrEqual(8);
    expect(pongs).toBeLessThan(20);
    ws.close();
  });
});
