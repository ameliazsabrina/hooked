import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
} from "vitest";
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
import { buildTestServer } from "./testServer.js";
import { makeRedis } from "./setup.js";

describe("WebSocket — frame size cap", () => {
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
      const onOpen = () => {
        ws.off("error", onError);
        resolve(ws);
      };
      const onError = (err: Error) => {
        ws.off("open", onOpen);
        reject(err);
      };
      ws.once("open", onOpen);
      ws.once("error", onError);
    });
  }

  function waitForClose(ws: WebSocket): Promise<{
    code: number;
    reason: string;
  }> {
    return new Promise((resolve) => {
      ws.once("close", (code, reasonBuf) => {
        resolve({ code, reason: Buffer.from(reasonBuf).toString("utf8") });
      });
    });
  }

  it("accepts frames comfortably under the 64KB cap", async () => {
    const ws = await openSocket();
    const payload = JSON.stringify({
      type: "ping",
      data: "x".repeat(1000),
    });
    ws.send(payload);
    const closedEarly = await Promise.race([
      waitForClose(ws).then((v) => ({ closed: true as const, ...v })),
      new Promise<{ closed: false }>((r) =>
        setTimeout(() => r({ closed: false }), 200),
      ),
    ]);
    expect(closedEarly.closed).toBe(false);
    ws.close();
    await waitForClose(ws);
  });

  it("closes the connection with 1009 (message too big) when a frame exceeds 64KB", async () => {
    const ws = await openSocket();
    const closePromise = waitForClose(ws);
    const oversized = "x".repeat(128 * 1024);
    ws.send(oversized);
    const { code } = await closePromise;
    expect([1006, 1009]).toContain(code);
  });
});
