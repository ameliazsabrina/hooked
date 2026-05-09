import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { FishRarity, FISH_SPECIES } from "@hooked/shared";

import { env } from "../../config/env.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Resolve the on-disk apex assets directory. In dev the server lives next to
 * the client package, so we walk up to `packages/client/public/assets/fish/
 * apex`. Override in production via `APEX_FISH_DIR` since the client may be
 * deployed separately from the API server.
 */
function apexAssetsDir(): string {
  if (env.APEX_FISH_DIR) return env.APEX_FISH_DIR;
  return path.resolve(
    __dirname,
    "../../../../client/public/assets/fish/apex",
  );
}

/** Web-relative path mounted by the client's static handler. */
const ASSET_URL_PREFIX = "/assets/fish/apex";

export interface ApexCatalogEntry {
  /** Index into FISH_SPECIES so the cast roll continues to use the same id. */
  id: number;
  /** Display name from FISH_SPECIES (e.g. "Anh Lucerna"). */
  name: string;
  /** Filename only (e.g. "Anh-Lucerna.png"). */
  filename: string;
  /** Web path relative to the client root (e.g. "/assets/fish/apex/Anh-Lucerna.png"). */
  assetPath: string;
  /** Absolute URL so the admin dashboard (different origin) can <img> it. */
  assetUrl: string;
  weightMin: number;
  weightMax: number;
}

const CATALOG_TTL_MS = 60_000;
let cached: { entries: ApexCatalogEntry[]; loadedAt: number } | null = null;

/**
 * Match a filesystem filename against FISH_SPECIES by asset basename. The
 * stored asset paths in FISH_SPECIES use a legacy prefix (e.g.
 * `colo-apex-fish/Anh-Lucerna.png`); we compare just the trailing filename
 * so the move to the new `/assets/fish/apex/` location doesn't require a
 * coordinated FISH_SPECIES rewrite.
 */
function findFishSpeciesId(filename: string): number {
  return FISH_SPECIES.findIndex((s) => {
    if (s.rarity !== FishRarity.Apex) return false;
    const basename = s.asset.split("/").pop();
    return basename === filename;
  });
}

/**
 * Enumerate apex fish PNGs in the configured directory. Source of truth for
 * which apex fish the admin dashboard can pick during event creation.
 *
 * Cached for 60s so a repeated `apexCatalog` query doesn't re-stat the dir
 * on every keystroke. `force=true` bypasses the cache (used in tests).
 *
 * Each filename is matched against FISH_SPECIES by basename; entries without
 * a matching FISH_SPECIES are skipped with a warning since the cast roll
 * needs `SPECIES_TABLE` weight ranges to function. Drop-in workflow for
 * adding new apex fish: drop the PNG in the directory + add a FISH_SPECIES
 * entry in `@hooked/shared/species.ts`.
 */
export function readApexCatalog(force = false): ApexCatalogEntry[] {
  const now = Date.now();
  if (!force && cached && now - cached.loadedAt < CATALOG_TTL_MS) {
    return cached.entries;
  }
  const dir = apexAssetsDir();
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith(".png"))
      .sort();
  } catch (err) {
    console.warn(
      `[apexCatalog] cannot read ${dir}: ${(err as Error).message}`,
    );
    cached = { entries: [], loadedAt: now };
    return [];
  }

  const entries: ApexCatalogEntry[] = [];
  for (const filename of files) {
    const id = findFishSpeciesId(filename);
    if (id === -1) {
      console.warn(
        `[apexCatalog] ${filename} has no FISH_SPECIES entry with rarity Apex; ` +
          `add one in @hooked/shared/species.ts to enable it for events`,
      );
      continue;
    }
    const sp = FISH_SPECIES[id];
    const assetPath = `${ASSET_URL_PREFIX}/${filename}`;
    entries.push({
      id,
      name: sp.name,
      filename,
      assetPath,
      assetUrl: `${env.CLIENT_URL}${assetPath}`,
      weightMin: sp.weightMin,
      weightMax: sp.weightMax,
    });
  }

  cached = { entries, loadedAt: now };
  return entries;
}

/** Test-only cache reset. */
export function _resetApexCatalogCache(): void {
  cached = null;
}
