import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  markInFlight,
  markResolved,
  markEscaped,
  getTerminal,
  _resetIdempotencyStore,
} from "../src/ws/idempotency.js";
import type {
  CatchResolvedMessage,
  FishEscapedMessage,
} from "../src/ws/protocol.js";

const W = "wallet1";
const C = "cast1";

const resolved: CatchResolvedMessage = {
  type: "catch_resolved",
  sessionId: "s",
  clientCastId: C,
  hit: true,
  speciesId: 1,
  apexFishId: null,
  apexAssetUrl: null,
  speciesName: "x",
  rarity: 0,
  weightHg: 10,
  score: 5,
};

const escaped: FishEscapedMessage = {
  type: "fish_escaped",
  sessionId: "s",
  clientCastId: C,
  reason: "no_tap",
};

describe("ws idempotency cache", () => {
  beforeEach(() => _resetIdempotencyStore());

  it("returns null for an unknown cast", () => {
    expect(getTerminal(W, C)).toBeNull();
  });

  it("tracks in-flight then upgrades to resolved", () => {
    markInFlight(W, C);
    expect(getTerminal(W, C)).toEqual({ status: "in-flight" });
    markResolved(W, C, resolved);
    expect(getTerminal(W, C)).toEqual({ status: "resolved", msg: resolved });
  });

  it("tracks an escaped outcome", () => {
    markEscaped(W, C, escaped);
    expect(getTerminal(W, C)).toEqual({ status: "escaped", msg: escaped });
  });

  it("scopes outcomes by wallet", () => {
    markResolved(W, C, resolved);
    expect(getTerminal("otherWallet", C)).toBeNull();
  });

  it("expires entries after the TTL", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      markResolved(W, C, resolved);
      vi.setSystemTime(59_000);
      expect(getTerminal(W, C)).not.toBeNull();
      vi.setSystemTime(61_000);
      expect(getTerminal(W, C)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

afterEach(() => _resetIdempotencyStore());
