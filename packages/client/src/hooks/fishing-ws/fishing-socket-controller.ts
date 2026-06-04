import type { TerminalGuard } from "@hooked/shared";
import type { ServerMessage } from "./protocol";

export interface WebSocketLike {
  readonly OPEN: number;
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(
    type: "open" | "message" | "close" | "error",
    handler: (ev: { data?: unknown }) => void,
  ): void;
}

export interface DelegationBundle {
  delegation: unknown;
  sessionSecret: Uint8Array;
}

export interface FishingSocketDeps {
  wsFactory: (url: string) => WebSocketLike;
  wsUrl: () => string;
  httpBase: () => string;
  fetchFn: typeof fetch;
  loadDelegation: (wallet: string) => DelegationBundle | null;
  signNonce: (sessionSecret: Uint8Array, nonce: string) => string;
  clearDelegation: (wallet: string) => void;
  guard: TerminalGuard;
  reconnectDelayMs: number;
  maxReconnectAttempts: number;
  // Gameplay messages (everything except authenticated/auth_failed).
  onMessage: (msg: ServerMessage) => void;
  onAuthChange: (authed: boolean) => void;
  onSession: (sessionPda: string | null) => void;
  // Gameplay-state cleanup the parent owns, run on disconnect.
  onReset: () => void;
  getActiveCastId: () => string | null;
  sessionRetry: () => void;
}

// Owns the fishing WebSocket: connect, auth handshake, reconnect/backoff, and
// reconnect recovery. Framework-agnostic so the state machine is unit-testable.
export class FishingSocketController {
  private ws: WebSocketLike | null = null;
  private connecting = false;
  private authed = false;
  private attempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private walletStr: string | null = null;
  private authReady = false;
  private stopped = false;

  constructor(private readonly deps: FishingSocketDeps) {}

  configure(walletStr: string | null, authReady: boolean): void {
    this.walletStr = walletStr;
    this.authReady = authReady;
  }

  start(): void {
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.close();
      } catch {
        // already gone
      }
    }
  }

  send(data: object): void {
    const ws = this.ws;
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(data));
  }

  isAuthed(): boolean {
    return this.authed;
  }

  private async connect(): Promise<void> {
    const walletStr = this.walletStr;
    if (
      !walletStr ||
      this.ws ||
      this.connecting ||
      !this.authReady ||
      this.stopped
    ) {
      return;
    }
    this.connecting = true;
    try {
      const bundle = this.deps.loadDelegation(walletStr);
      if (!bundle) {
        console.warn(
          "[ws] no cached delegation; SessionAuthProvider must complete first.",
        );
        return;
      }

      const nonceRes = await this.deps.fetchFn(
        `${this.deps.httpBase()}/ws/nonce`,
      );
      const { nonce } = (await nonceRes.json()) as { nonce: string };
      const signature = this.deps.signNonce(bundle.sessionSecret, nonce);

      const claimRes = await this.deps.fetchFn(
        `${this.deps.httpBase()}/ws/claim-nonce`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ wallet: walletStr, nonce }),
        },
      );
      if (!claimRes.ok) throw new Error("nonce claim failed");

      const ws = this.deps.wsFactory(this.deps.wsUrl());
      this.ws = ws;

      ws.addEventListener("open", () => {
        ws.send(
          JSON.stringify({
            type: "authenticate",
            wallet: walletStr,
            nonce,
            signature,
            delegation: bundle.delegation,
            recoverCastId: this.deps.guard.recoverCastId(),
          }),
        );
      });

      ws.addEventListener("message", (ev) => {
        let msg: ServerMessage;
        try {
          msg = JSON.parse((ev as { data: string }).data) as ServerMessage;
        } catch {
          return;
        }
        this.handleMessage(msg);
      });

      ws.addEventListener("close", () => this.handleClose());
      ws.addEventListener("error", () => {
        try {
          ws.close();
        } catch {
          // already gone
        }
      });
    } catch (err) {
      console.warn("[ws] connect failed:", err);
    } finally {
      this.connecting = false;
    }
  }

  private handleMessage(msg: ServerMessage): void {
    if (msg.type === "authenticated") {
      this.authed = true;
      this.attempts = 0;
      this.deps.onAuthChange(true);
      this.deps.onSession(msg.sessionPda ?? null);
      return;
    }
    if (msg.type === "auth_failed") {
      console.warn("[ws] auth failed:", msg.reason);
      this.authed = false;
      this.deps.onAuthChange(false);
      if (this.walletStr) this.deps.clearDelegation(this.walletStr);
      const ws = this.ws;
      this.ws = null;
      try {
        ws?.close();
      } catch {
        // already gone
      }
      this.deps.sessionRetry();
      return;
    }
    this.deps.onMessage(msg);
  }

  private handleClose(): void {
    const wasAuthed = this.authed;
    this.ws = null;
    this.authed = false;
    this.deps.onAuthChange(false);
    // Stash the in-flight cast before the parent clears it, for recovery.
    this.deps.guard.stashRecovery(this.deps.getActiveCastId());
    this.deps.onReset();
    if (this.stopped) return;
    if (wasAuthed) this.attempts = 0;
    if (this.attempts >= this.deps.maxReconnectAttempts) {
      console.warn("[ws] max reconnect attempts reached — forcing re-auth");
      this.attempts = 0;
      this.deps.sessionRetry();
      return;
    }
    this.attempts++;
    if (!this.reconnectTimer) {
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        void this.connect();
      }, this.deps.reconnectDelayMs);
    }
  }
}
