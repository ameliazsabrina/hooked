/**
 * DB-backed event-config reader. Backs the WS `event_status` broadcast and
 * the cast-flow snapshot at session start. Source of truth: the
 * `FishingEvent` collection, written by the admin event router and the
 * event-lifecycle worker. One active event at a time (enforced by partial
 * unique index on `active: true`).
 *
 * `getEventStatus`/`getActiveEvent` self-heal expired events: if a row has
 * `active: true` but `endsAt < now`, this layer treats it as inactive even
 * before the lifecycle worker flips the flag. Mirrors the original on-chain
 * `initiate_cast` semantics.
 */
import { ApexFish, FishingEvent } from "../db/schema.js";
import { env } from "../config/env.js";

export interface ApexFishStatusEntry {
  /** ApexFish ObjectId, 24-char hex. */
  id: string;
  name: string;
  weightMinKg: number;
  weightMaxKg: number;
  /** Public asset URL for the dashboard / player client to render. */
  assetUrl: string;
}

export interface EventStatus {
  /** Admin-typed event display name (e.g. "Colosseum"). */
  name: string;
  /** Unix seconds. */
  startsAt: number;
  /** Unix seconds. */
  endsAt: number;
  /** Basis points (0..5000) redirected from Basic to Apex during the event. */
  apexBp: number;
  /**
   * Apex fish the cast roll picks from when Apex rolls during this event.
   * Includes assetUrl + name so HUD banners can show fish art without an
   * extra round-trip.
   */
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
  if (a.apexFishes.length !== b.apexFishes.length) return false;
  for (let i = 0; i < a.apexFishes.length; i++) {
    if (a.apexFishes[i].id !== b.apexFishes[i].id) return false;
  }
  return true;
}

async function fetchFromDb(): Promise<EventStatus | null> {
  // Single active event by partial unique index; the time bounds defend
  // against the lifecycle worker lagging behind reality.
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
  // Preserve the order admins selected so deterministic apex picks match
  // (the cast roll uses the snapshot which is built off the same order).
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
    apexFishes,
  };
}

/**
 * Fetch the active event status. Cached for 30s to keep the cast-start hot
 * path off Mongo. `force=true` bypasses the cache (used by the admin route
 * after writes and by the lifecycle worker after promote/demote).
 */
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

/**
 * Synchronous read of the cached event. Returns null if the cache hasn't been
 * warmed yet — call `getEventStatus(true)` once at boot.
 */
export function getActiveEvent(): EventStatus | null {
  const value = cached?.value;
  if (!value) return null;
  if (Date.now() / 1000 >= value.endsAt) return null;
  return value;
}

export function getActiveApexBp(): number {
  return getActiveEvent()?.apexBp ?? 0;
}

/**
 * Subscribe to event-status transitions. The poller fires the callback only
 * when the cached value differs from the previous fetch.
 */
export function onEventChange(fn: (status: EventStatus | null) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Start the periodic poller. Idempotent — first call wires the interval, the
 * gateway calls this once at boot via `ensureEventCacheBound`.
 */
export function startEventPolling(intervalMs = CACHE_TTL_MS): void {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    void getEventStatus(true).catch((err) => {
      console.error("[eventConfig] poll failed:", err);
    });
  }, intervalMs);
}

/** Stop the poller. Used by tests and graceful shutdown. */
export function stopEventPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

/** Test-only: clear the cache so a fresh DB read fires on next call. */
export function _resetEventCache(): void {
  cached = null;
  inflight = null;
}
