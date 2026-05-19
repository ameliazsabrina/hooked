import { ApexFish } from "../../db/schema.js";

/** Weights in kg; cast-roll snapshots convert to hg (×10). */
export interface ApexCatalogEntry {
  id: string;
  name: string;
  weightMin: number;
  weightMax: number;
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

/** 60s cache. Admin mutations call invalidateApexCatalog() to bypass TTL. */
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

export function invalidateApexCatalog(): void {
  cached = null;
}

/** Test-only. */
export function _resetApexCatalogCache(): void {
  cached = null;
  inflight = null;
}
