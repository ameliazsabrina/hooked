import type { CatchResolvedMessage, FishEscapedMessage } from "./protocol.js";

// Terminal outcome for a (wallet, clientCastId): the single source of truth for
// "what happened to this cast", used for retry replay and reconnect recovery.
export type Terminal =
  | { status: "in-flight" }
  | { status: "resolved"; msg: CatchResolvedMessage }
  | { status: "escaped"; msg: FishEscapedMessage };

interface Entry {
  value: Terminal;
  expiresAt: number;
}

const TTL_MS = 60_000;
const MAX_ENTRIES = 4096;

const store = new Map<string, Entry>();

function key(wallet: string, castId: string): string {
  return `${wallet}:${castId}`;
}

function evictIfNeeded(): void {
  if (store.size <= MAX_ENTRIES) return;
  const overflow = store.size - MAX_ENTRIES;
  let removed = 0;
  for (const k of store.keys()) {
    store.delete(k);
    if (++removed >= overflow) break;
  }
}

function set(wallet: string, castId: string, value: Terminal): void {
  const k = key(wallet, castId);
  store.delete(k); // re-insert so iteration order tracks recency
  store.set(k, { value, expiresAt: Date.now() + TTL_MS });
  evictIfNeeded();
}

export function markInFlight(wallet: string, castId: string): void {
  set(wallet, castId, { status: "in-flight" });
}

export function markResolved(
  wallet: string,
  castId: string,
  msg: CatchResolvedMessage,
): void {
  set(wallet, castId, { status: "resolved", msg });
}

export function markEscaped(
  wallet: string,
  castId: string,
  msg: FishEscapedMessage,
): void {
  set(wallet, castId, { status: "escaped", msg });
}

export function getTerminal(wallet: string, castId: string): Terminal | null {
  const k = key(wallet, castId);
  const entry = store.get(k);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    store.delete(k);
    return null;
  }
  return entry.value;
}

// Test seam.
export function _resetIdempotencyStore(): void {
  store.clear();
}
