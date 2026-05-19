// Self-heals expired events: `active: true` rows past endsAt read as inactive
// even before the lifecycle worker flips the flag.
import { ApexFish, FishingEvent } from "../db/schema.js";
import { env } from "../config/env.js";

export interface ApexFishStatusEntry {
  id: string;
  name: string;
  weightMinKg: number;
  weightMaxKg: number;
  assetUrl: string;
}

export interface EventStatus {
  name: string;
  /** Unix seconds. */
  startsAt: number;
  /** Unix seconds. */
  endsAt: number;
  /** Basis points (0..5000) redirected from Basic to Apex during the event. */
  apexBp: number;
  prizePoolSol: number;
  apexFishes: ApexFishStatusEntry[];
}

const CACHE_TTL_MS = 30_000;

let cached: { value: EventStatus | null; fetchedAt: number } | null = null;
let inflight: Promise<EventStatus | null> | null = null;
const listeners = new Set<(status: EventStatus | null) => void>();
let pollTimer: ReturnType<typeof setInterval> | null = null;

function statusEqual(a: EventStatus | null, b: EventStatus | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.name !== b.name) return false;
  if (a.startsAt !== b.startsAt) return false;
  if (a.endsAt !== b.endsAt) return false;
  if (a.apexBp !== b.apexBp) return false;
  if (a.prizePoolSol !== b.prizePoolSol) return false;
  if (a.apexFishes.length !== b.apexFishes.length) return false;
  for (let i = 0; i < a.apexFishes.length; i++) {
    if (a.apexFishes[i].id !== b.apexFishes[i].id) return false;
  }
  return true;
}

async function fetchFromDb(): Promise<EventStatus | null> {
  // Time bounds defend against lifecycle worker lag.
  const now = new Date();
  const row = await FishingEvent.findOne({
    active: true,
    startsAt: { $lte: now },
    endsAt: { $gt: now },
  }).lean();
  if (!row) return null;
  const fishes = await ApexFish.find(
    { _id: { $in: row.apexFishIds } },
    { name: 1, weightMinKg: 1, weightMaxKg: 1 },
  ).lean();
  // Preserve admin-selected order — cast roll uses the same snapshot.
  const byId = new Map(fishes.map((f) => [String(f._id), f]));
  const apexFishes: ApexFishStatusEntry[] = [];
  for (const id of row.apexFishIds) {
    const f = byId.get(String(id));
    if (!f) continue;
    apexFishes.push({
      id: String(f._id),
      name: f.name,
      weightMinKg: f.weightMinKg,
      weightMaxKg: f.weightMaxKg,
      assetUrl: `${env.SERVER_PUBLIC_URL}/admin/apex-fish/${String(f._id)}/image`,
    });
  }
  return {
    name: row.name,
    startsAt: Math.floor(row.startsAt.getTime() / 1000),
    endsAt: Math.floor(row.endsAt.getTime() / 1000),
    apexBp: row.apexBp,
    prizePoolSol: row.prizePoolSol,
    apexFishes,
  };
}

/** 30s cache. `force=true` bypasses (admin writes, lifecycle promote/demote). */
export async function getEventStatus(force = false): Promise<EventStatus | null> {
  const now = Date.now();
  if (!force && cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.value;
  }
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const fresh = await fetchFromDb();
      const prev = cached?.value ?? null;
      cached = { value: fresh, fetchedAt: Date.now() };
      if (!statusEqual(prev, fresh)) {
        for (const fn of listeners) {
          try {
            fn(fresh);
          } catch (err) {
            console.error("[eventConfig] listener threw:", err);
          }
        }
      }
      return fresh;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Sync read of the cache — null until getEventStatus(true) warms it at boot. */
export function getActiveEvent(): EventStatus | null {
  const value = cached?.value;
  if (!value) return null;
  if (Date.now() / 1000 >= value.endsAt) return null;
  return value;
}

export function getActiveApexBp(): number {
  return getActiveEvent()?.apexBp ?? 0;
}

/** Fires only on transitions, not on every poll. */
export function onEventChange(fn: (status: EventStatus | null) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Idempotent. */
export function startEventPolling(intervalMs = CACHE_TTL_MS): void {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    void getEventStatus(true).catch((err) => {
      console.error("[eventConfig] poll failed:", err);
    });
  }, intervalMs);
}

export function stopEventPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

/** Test-only. */
export function _resetEventCache(): void {
  cached = null;
  inflight = null;
}
