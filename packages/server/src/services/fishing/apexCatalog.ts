import { ApexFish } from "../../db/schema.js";
import { env } from "../../config/env.js";

/**
 * One catalog entry. `id` is the ApexFish ObjectId as a 24-char hex string.
 * `assetUrl` points at the public `GET /admin/apex-fish/:id/image` route.
 *
 * Weight ranges are returned in kilograms (matches the admin UX and the
 * legacy filesystem-driven shape). Cast-roll snapshots convert to hectograms
 * (×10) on the way into the session — see `sessionEngine.startSession`.
 */
export interface ApexCatalogEntry {
  id: string;
  name: string;
  weightMin: number;
  weightMax: number;
  /** Mime type — useful when the dashboard wants to do format-specific UI. */
  imageMimeType: string;
  assetUrl: string;
}

const CATALOG_TTL_MS = 60_000;
let cached: { entries: ApexCatalogEntry[]; loadedAt: number } | null = null;
let inflight: Promise<ApexCatalogEntry[]> | null = null;

function buildAssetUrl(id: string): string {
  return `${env.SERVER_PUBLIC_URL}/admin/apex-fish/${id}/image`;
}

async function loadFromDb(): Promise<ApexCatalogEntry[]> {
  const docs = await ApexFish.find(
    {},
    {
      name: 1,
      weightMinKg: 1,
      weightMaxKg: 1,
      imageMimeType: 1,
    },
  )
    .sort({ name: 1 })
    .lean();
  return docs.map((d) => {
    const id = String(d._id);
    return {
      id,
      name: d.name,
      weightMin: d.weightMinKg,
      weightMax: d.weightMaxKg,
      imageMimeType: d.imageMimeType,
      assetUrl: buildAssetUrl(id),
    };
  });
}

/**
 * Read the apex catalog from MongoDB. Cached for 60s so repeated picker
 * queries (the admin events/new page polls on render) don't re-hit Mongo on
 * every keystroke. The catalog is the source of truth for "which apex fish
 * the admin can pick during event creation".
 *
 * `force=true` bypasses the cache (used in tests). Mutations on the
 * `apexFish` admin router call `invalidateApexCatalog()` so writes are
 * visible on the next read without waiting for the TTL.
 */
export async function readApexCatalog(force = false): Promise<ApexCatalogEntry[]> {
  const now = Date.now();
  if (!force && cached && now - cached.loadedAt < CATALOG_TTL_MS) {
    return cached.entries;
  }
  if (!force && inflight) return inflight;
  inflight = (async () => {
    try {
      const entries = await loadFromDb();
      cached = { entries, loadedAt: Date.now() };
      return entries;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/**
 * Drop the cached catalog so the next `readApexCatalog()` call re-hits the
 * DB. Called by the admin `apexFish.{create,update,delete}` mutations to
 * keep the picker in sync with writes.
 */
export function invalidateApexCatalog(): void {
  cached = null;
}

/** Test-only cache reset. Same effect as `invalidateApexCatalog`. */
export function _resetApexCatalogCache(): void {
  cached = null;
  inflight = null;
}
