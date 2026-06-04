import { describe, it, expect, vi, beforeEach } from "vitest";
import { TerminalGuard } from "@hooked/shared";
import {
  FishingSocketController,
  type FishingSocketDeps,
  type WebSocketLike,
} from "./fishing-socket-controller";

class MockWebSocket implements WebSocketLike {
  readonly OPEN = 1;
  readyState = 1;
  sent: string[] = [];
  private listeners: Record<string, Array<(ev: { data?: unknown }) => void>> = {};
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.emit("close", {});
  }
  addEventListener(type: string, handler: (ev: { data?: unknown }) => void) {
    (this.listeners[type] ??= []).push(handler);
  }
  emit(type: string, ev: { data?: unknown }) {
    (this.listeners[type] ?? []).forEach((h) => h(ev));
  }
}

const settle = () => new Promise<void>((r) => setTimeout(r, 5));

function makeHarness(overrides: Partial<FishingSocketDeps> = {}) {
  const sockets: MockWebSocket[] = [];
  const guard = new TerminalGuard();
  const cb = {
    onMessage: vi.fn(),
    onAuthChange: vi.fn(),
    onSession: vi.fn(),
    onReset: vi.fn(),
    sessionRetry: vi.fn(),
    getActiveCastId: vi.fn(() => null as string | null),
    clearDelegation: vi.fn(),
  };
  const deps: FishingSocketDeps = {
    wsFactory: () => {
      const s = new MockWebSocket();
      sockets.push(s);
      return s;
    },
    wsUrl: () => "ws://test/ws/gateway",
    httpBase: () => "http://test",
    fetchFn: vi.fn(async (url: unknown) =>
      String(url).endsWith("/ws/nonce")
        ? ({ json: async () => ({ nonce: "n1" }) } as unknown as Response)
        : ({ ok: true } as unknown as Response),
    ),
    loadDelegation: () => ({
      delegation: { d: 1 },
      sessionSecret: new Uint8Array([1, 2, 3]),
    }),
    signNonce: () => "sig1",
    clearDelegation: cb.clearDelegation,
    guard,
    reconnectDelayMs: 10,
    maxReconnectAttempts: 3,
    onMessage: cb.onMessage,
    onAuthChange: cb.onAuthChange,
    onSession: cb.onSession,
    onReset: cb.onReset,
    getActiveCastId: cb.getActiveCastId,
    sessionRetry: cb.sessionRetry,
    ...overrides,
  };
  return { deps, sockets, guard, cb };
}

async function startConnected(h: ReturnType<typeof makeHarness>) {
  const c = new FishingSocketController(h.deps);
  c.configure("WalletA", true);
  c.start();
  await settle();
  h.sockets[0].emit("open", {});
  return c;
}

function send(ws: MockWebSocket, msg: object) {
  ws.emit("message", { data: JSON.stringify(msg) });
}

describe("FishingSocketController", () => {
  beforeEach(() => vi.clearAllMocks());

  it("authenticates on open, including recoverCastId from the guard", async () => {
    const h = makeHarness();
    h.guard.stashRecovery("castX");
    await startConnected(h);
    const auth = JSON.parse(h.sockets[0].sent[0]);
    expect(auth.type).toBe("authenticate");
    expect(auth.wallet).toBe("WalletA");
    expect(auth.recoverCastId).toBe("castX");
  });

  it("on `authenticated`: flips auth + reports the session", async () => {
    const h = makeHarness();
    await startConnected(h);
    send(h.sockets[0], { type: "authenticated", wallet: "WalletA", sessionPda: "PDA1" });
    expect(h.cb.onAuthChange).toHaveBeenCalledWith(true);
    expect(h.cb.onSession).toHaveBeenCalledWith("PDA1");
  });

  it("forwards gameplay messages but not auth messages", async () => {
    const h = makeHarness();
    await startConnected(h);
    send(h.sockets[0], { type: "pong", t: 1 });
    expect(h.cb.onMessage).toHaveBeenCalledWith({ type: "pong", t: 1 });
    send(h.sockets[0], { type: "authenticated", wallet: "WalletA" });
    expect(h.cb.onMessage).toHaveBeenCalledTimes(1); // authenticated not forwarded
  });

  it("reconnects after an unexpected close", async () => {
    const h = makeHarness();
    await startConnected(h);
    h.sockets[0].emit("close", {});
    expect(h.cb.onReset).toHaveBeenCalled();
    expect(h.cb.onAuthChange).toHaveBeenLastCalledWith(false);
    await new Promise((r) => setTimeout(r, 25));
    expect(h.sockets.length).toBe(2);
  });

  it("stashes the in-flight cast on close for recovery", async () => {
    const h = makeHarness();
    h.cb.getActiveCastId.mockReturnValue("castY");
    await startConnected(h);
    h.sockets[0].emit("close", {});
    expect(h.guard.recoverCastId()).toBe("castY");
  });

  it("forces re-auth after exceeding max reconnect attempts", async () => {
    const h = makeHarness({ maxReconnectAttempts: 1 });
    await startConnected(h);
    h.sockets[0].emit("close", {}); // attempts 0->1, schedules reconnect
    await new Promise((r) => setTimeout(r, 25));
    h.sockets[1].emit("close", {}); // attempts 1>=1 -> sessionRetry
    expect(h.cb.sessionRetry).toHaveBeenCalledTimes(1);
  });

  it("auth_failed clears the delegation and forces re-auth", async () => {
    const h = makeHarness();
    await startConnected(h);
    send(h.sockets[0], { type: "auth_failed", reason: "bad sig" });
    expect(h.cb.clearDelegation).toHaveBeenCalledWith("WalletA");
    expect(h.cb.sessionRetry).toHaveBeenCalled();
    expect(h.cb.onAuthChange).toHaveBeenLastCalledWith(false);
  });

  it("send no-ops before open, sends once open", async () => {
    const h = makeHarness();
    const c = new FishingSocketController(h.deps);
    c.send({ type: "ping", t: 1 }); // no socket yet
    c.configure("WalletA", true);
    c.start();
    await settle();
    h.sockets[0].emit("open", {});
    c.send({ type: "ping", t: 2 });
    expect(h.sockets[0].sent.some((s) => s.includes('"t":2'))).toBe(true);
  });

  it("stop() prevents reconnect", async () => {
    const h = makeHarness();
    const c = await startConnected(h);
    c.stop();
    await new Promise((r) => setTimeout(r, 25));
    expect(h.sockets.length).toBe(1); // no reconnect after stop
  });
});
