import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import bs58 from "bs58";
import WebSocket from "ws";
import { buildTestServer } from "./testServer.js";
import {
  makeRedis,
  startTestMongo,
  stopTestMongo,
  clearAllCollections,
} from "./setup.js";
import {
  markResolved,
  markEscaped,
  _resetIdempotencyStore,
} from "../src/ws/idempotency.js";
import type { CatchResolvedMessage } from "../src/ws/protocol.js";

function resolvedFrame(castId: string): CatchResolvedMessage {
  return {
    type: "catch_resolved",
    sessionId: "sess",
    clientCastId: castId,
    hit: true,
    speciesId: 3,
    apexFishId: null,
    apexAssetUrl: null,
    speciesName: "Bass",
    rarity: 1,
    weightHg: 42,
    score: 7,
  };
}

describe("WebSocket — resolution replay & reconnect recovery", () => {
  let server: FastifyInstance;
  let httpBase: string;
  let wsUrl: string;

  beforeAll(async () => {
    await startTestMongo();
    server = await buildTestServer({ redis: makeRedis() });
    httpBase = await server.listen({ port: 0, host: "127.0.0.1" });
    wsUrl = httpBase.replace(/^http/, "ws") + "/ws/gateway";
  });

  afterAll(async () => {
    if (server) await server.close();
    await stopTestMongo();
  });

  beforeEach(async () => {
    _resetIdempotencyStore();
    await clearAllCollections();
  });

  function open(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      ws.once("open", () => resolve(ws));
      ws.once("error", reject);
    });
  }

  function waitForType(
    ws: WebSocket,
    type: string,
    timeoutMs = 8000,
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const onMsg = (buf: WebSocket.RawData) => {
        const m = JSON.parse(Buffer.from(buf as Buffer).toString("utf8"));
        if (m.type === type) {
          ws.off("message", onMsg);
          resolve(m);
        }
      };
      ws.on("message", onMsg);
      setTimeout(() => {
        ws.off("message", onMsg);
        reject(new Error(`timeout waiting for ${type}`));
      }, timeoutMs);
    });
  }

  // Use server.inject (not global fetch) so a sibling test's global fetch stub
  // can't leak into this one.
  async function claimNonce(wallet: string): Promise<string> {
    const nonce = randomUUID();
    const res = await server.inject({
      method: "POST",
      url: "/ws/claim-nonce",
      payload: { wallet, nonce },
    });
    if (res.statusCode !== 200) {
      throw new Error(`claim-nonce failed: ${res.statusCode}`);
    }
    return nonce;
  }

  function signNonce(kp: Keypair, nonce: string): string {
    return bs58.encode(
      nacl.sign.detached(
        new TextEncoder().encode(`Hooked Auth Nonce: ${nonce}`),
        kp.secretKey,
      ),
    );
  }

  async function authenticate(
    ws: WebSocket,
    kp: Keypair,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    const wallet = kp.publicKey.toBase58();
    const nonce = await claimNonce(wallet);
    const signature = signNonce(kp, nonce);
    const authedP = waitForType(ws, "authenticated");
    ws.send(JSON.stringify({ type: "authenticate", wallet, nonce, signature, ...extra }));
    await authedP;
  }

  it("replays the cached catch on a retried cast_finalize (no re-resolve)", async () => {
    const kp = Keypair.generate();
    const wallet = kp.publicKey.toBase58();
    const ws = await open();
    await authenticate(ws, kp);

    // Seed a prior resolution; the socket has no active session.
    markResolved(wallet, "castA", resolvedFrame("castA"));

    const replayed = waitForType(ws, "catch_resolved");
    ws.send(
      JSON.stringify({ type: "cast_finalize", sessionId: "sess", clientCastId: "castA" }),
    );
    const msg = await replayed;
    expect(msg.clientCastId).toBe("castA");
    expect(msg.hit).toBe(true);
    expect(msg.score).toBe(7);
    ws.close();
  }, 15000);

  it("replays an escape on a retried finalize for an abandoned cast", async () => {
    const kp = Keypair.generate();
    const wallet = kp.publicKey.toBase58();
    const ws = await open();
    await authenticate(ws, kp);

    markEscaped(wallet, "castB", {
      type: "fish_escaped",
      sessionId: "sess",
      clientCastId: "castB",
      reason: "no_tap",
    });

    const replayed = waitForType(ws, "fish_escaped");
    ws.send(
      JSON.stringify({ type: "cast_finalize", sessionId: "sess", clientCastId: "castB" }),
    );
    const msg = await replayed;
    expect(msg.clientCastId).toBe("castB");
    ws.close();
  }, 15000);

  it("recovers a resolution on reconnect via recoverCastId", async () => {
    const kp = Keypair.generate();
    const wallet = kp.publicKey.toBase58();

    // Cast resolved while the prior socket was down.
    markResolved(wallet, "castC", resolvedFrame("castC"));

    const ws = await open();
    const recovered = waitForType(ws, "catch_resolved");
    await authenticate(ws, kp, { recoverCastId: "castC" });
    const msg = await recovered;
    expect(msg.clientCastId).toBe("castC");
    expect(msg.hit).toBe(true);
    ws.close();
  }, 15000);

  it("closes the oldest socket when a wallet exceeds the 3-connection cap", async () => {
    const kp = Keypair.generate();
    const sockets: WebSocket[] = [];
    for (let i = 0; i < 3; i++) {
      const ws = await open();
      await authenticate(ws, kp);
      sockets.push(ws);
    }

    const oldestClosed = new Promise<number>((resolve) => {
      sockets[0].once("close", (code) => resolve(code));
    });

    const fourth = await open();
    await authenticate(fourth, kp);

    const code = await oldestClosed;
    expect(code).toBe(4002);
    expect(sockets[1].readyState).toBe(WebSocket.OPEN);
    expect(sockets[2].readyState).toBe(WebSocket.OPEN);
    expect(fourth.readyState).toBe(WebSocket.OPEN);

    for (const ws of [sockets[1], sockets[2], fourth]) ws.close();
  }, 15000);
});
