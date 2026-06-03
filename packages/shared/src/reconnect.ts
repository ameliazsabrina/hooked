// Client-side guard for terminal cast outcomes across the WS reconnect boundary.
// catch_resolved is money-critical (debits bait, credits score), so it is
// deduped against replays. fish_escaped has no money side effect, so it is only
// gated to the active or recovering cast — and the server may send both for the
// same cast (no-tap miss), so they must NOT share a dedup set.
export class TerminalGuard {
  private readonly resolvedSeen = new Set<string>();
  private pendingRecovery: string | null = null;
  private readonly cap: number;

  constructor(cap = 64) {
    this.cap = cap;
  }

  // Remember the in-flight cast when the socket drops, to recover on reconnect.
  stashRecovery(activeCastId: string | null): void {
    if (activeCastId) this.pendingRecovery = activeCastId;
  }

  recoverCastId(): string | undefined {
    return this.pendingRecovery ?? undefined;
  }

  // True the first time a catch_resolved for this cast is seen; replays drop.
  acceptResolved(castId: string): boolean {
    if (this.resolvedSeen.has(castId)) return false;
    this.resolvedSeen.add(castId);
    if (this.resolvedSeen.size > this.cap) {
      const oldest = this.resolvedSeen.values().next().value;
      if (oldest !== undefined) this.resolvedSeen.delete(oldest);
    }
    if (this.pendingRecovery === castId) this.pendingRecovery = null;
    return true;
  }

  // True only for the active or recovering cast; replays after recovery drop.
  acceptEscape(castId: string, activeCastId: string | null): boolean {
    const isActive = activeCastId === castId;
    const isRecovery = this.pendingRecovery === castId;
    if (!isActive && !isRecovery) return false;
    if (isRecovery) this.pendingRecovery = null;
    return true;
  }
}
