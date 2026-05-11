import { ApexFish } from "../../db/schema.js";

/**
 * One catalog entry. `id` is the ApexFish ObjectId as a 24-char hex string.
 * `assetUrl` points at the public `GET /admin/apex-fish/:id/image` route.
 *
 * Weight ranges are returned in kilograms (matches the admin UX and the
 * legacy filesystem-driven shape). Cast-roll snapshots convert to hectograms
 * (×10) on the way into the session — see `sessionEngine.startSession`.
 *
 * `assetUrl` is built from the request's own origin at call time (see
 * `readApexCatalog(baseUrl)`) so it works regardless of `SERVER_PUBLIC_URL`
 * env config — every client sees URLs pointing back at the server it just
 * talked to.
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

interface CachedRow {
  id: string;
  name: string;
  weightMin: number;
  weightMax: number;
  imageMimeType: string;
}

const CATALOG_TTL_MS = 60_000;
let cached: { rows: CachedRow[]; loadedAt: number } | null = null;
let inflight: Promise<CachedRow[]> | null = null;

async function loadFromDb(): Promise<CachedRow[]> {
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
  return docs.map((d) => ({
    id: String(d._id),
    name: d.name,
    weightMin: d.weightMinKg,
    weightMax: d.weightMaxKg,
    imageMimeType: d.imageMimeType,
  }));
}

/**
 * Read the apex catalog from MongoDB. Cached for 60s so repeated picker
 * queries (the admin events/new page polls on render) don't re-hit Mongo on
 * every keystroke. The catalog is the source of truth for "which apex fish
 * the admin can pick during event creation".
 *
 * `baseUrl` is the origin (scheme + host) used to build `assetUrl` for each
 * entry — typically `ctx.requestOrigin` for tRPC procedures. Passed in
 * rather than read from env so the URL always matches the server the client
 * is actually hitting.
 *
 * `force=true` bypasses the cache (used in tests). Mutations on the
 * `apexFish` admin router call `invalidateApexCatalog()` so writes are
 * visible on the next read without waiting for the TTL.
 */
export async function readApexCatalog(
  baseUrl: string,
  force = false,
): Promise<ApexCatalogEntry[]> {
  const rows = await readApexCatalogRows(force);
  return rows.map((r) => ({
    ...r,
    assetUrl: `${baseUrl}/admin/apex-fish/${r.id}/image`,
  }));
}

async function readApexCatalogRows(force: boolean): Promise<CachedRow[]> {
  const now = Date.now();
  if (!force && cached && now - cached.loadedAt < CATALOG_TTL_MS) {
    return cached.rows;
  }
  if (!force && inflight) return inflight;
  inflight = (async () => {
    try {
      const rows = await loadFromDb();
      cached = { rows, loadedAt: Date.now() };
      return rows;
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
