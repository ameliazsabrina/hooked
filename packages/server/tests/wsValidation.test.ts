import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
import { buildTestServer } from "./testServer.js";
import { makeRedis } from "./setup.js";

describe("WebSocket — inbound validation", () => {
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

  function nextMessage(ws: WebSocket): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      ws.once("message", (buf) =>
        resolve(JSON.parse(Buffer.from(buf as Buffer).toString("utf8"))),
      );
    });
  }

  it("rejects a structurally invalid message with invalid_message and stays open", async () => {
    const ws = await openSocket();
    const reply = nextMessage(ws);
    // cast_initiate missing required clientCastId
    ws.send(JSON.stringify({ type: "cast_initiate", power: 100 }));
    const msg = await reply;
    expect(msg.type).toBe("error");
    expect(msg.code).toBe("invalid_message");
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it("rejects non-JSON with invalid_json", async () => {
    const ws = await openSocket();
    const reply = nextMessage(ws);
    ws.send("{ not json");
    const msg = await reply;
    expect(msg.type).toBe("error");
    expect(msg.code).toBe("invalid_json");
    ws.close();
  });
});
