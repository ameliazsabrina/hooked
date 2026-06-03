import { describe, it, expect } from "vitest";
import { TerminalGuard } from "@hooked/shared";

describe("TerminalGuard", () => {
  it("applies a catch_resolved once and drops replays", () => {
    const g = new TerminalGuard();
    expect(g.acceptResolved("castA")).toBe(true);
    expect(g.acceptResolved("castA")).toBe(false);
    expect(g.acceptResolved("castA")).toBe(false);
  });

  it("no-tap miss: fish_escaped AND catch_resolved both apply for one cast", () => {
    // Regression guard: a shared dedup set used to drop the bait-debiting
    // catch_resolved that the server sends right after fish_escaped.
    const g = new TerminalGuard();
    expect(g.acceptEscape("castA", "castA")).toBe(true);
    expect(g.acceptResolved("castA")).toBe(true);
  });

  it("gates fish_escaped to the active or recovering cast", () => {
    const g = new TerminalGuard();
    expect(g.acceptEscape("castA", "castA")).toBe(true); // active
    expect(g.acceptEscape("castB", "castA")).toBe(false); // stale, not active
    expect(g.acceptEscape("castC", null)).toBe(false); // none active, no recovery
  });

  it("recovers a resolved cast on reconnect, then drops the replay", () => {
    const g = new TerminalGuard();
    g.stashRecovery("castR");
    expect(g.recoverCastId()).toBe("castR");
    expect(g.acceptResolved("castR")).toBe(true);
    expect(g.acceptResolved("castR")).toBe(false);
  });

  it("recovers an escaped cast once (replay after recovery is dropped)", () => {
    const g = new TerminalGuard();
    g.stashRecovery("castE");
    expect(g.acceptEscape("castE", null)).toBe(true); // recovery
    expect(g.acceptEscape("castE", null)).toBe(false); // replay dropped
  });

  it("recoverCastId is undefined when nothing was in flight", () => {
    const g = new TerminalGuard();
    g.stashRecovery(null);
    expect(g.recoverCastId()).toBeUndefined();
  });

  it("evicts oldest beyond the cap but keeps recent dedup", () => {
    const g = new TerminalGuard(2);
    expect(g.acceptResolved("a")).toBe(true);
    expect(g.acceptResolved("b")).toBe(true);
    expect(g.acceptResolved("c")).toBe(true); // evicts "a"
    expect(g.acceptResolved("a")).toBe(true); // "a" forgotten → applies again
    expect(g.acceptResolved("c")).toBe(false); // "c" still remembered
  });
});
