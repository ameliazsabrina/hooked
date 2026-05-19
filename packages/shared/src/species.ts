import { FishRarity, FishingZone } from "./fish.js";

export interface FishSpecies {
  name: string;
  rarity: FishRarity;
  zone: FishingZone;
  weightMin: number;
  weightMax: number;
  asset: string;
}

export const FISH_SPECIES: FishSpecies[] = [
  { name: "Catfish", rarity: FishRarity.Basic, zone: FishingZone.Shore, weightMin: 1.0, weightMax: 3.0, asset: "FishCatfish.png" },
  { name: "Tilapia", rarity: FishRarity.Basic, zone: FishingZone.Shore, weightMin: 2.0, weightMax: 5.0, asset: "FishTilapia.png" },
  { name: "Carp", rarity: FishRarity.Basic, zone: FishingZone.Shore, weightMin: 3.0, weightMax: 6.0, asset: "FishCarp.png" },
  { name: "Sardine", rarity: FishRarity.Basic, zone: FishingZone.Coastal, weightMin: 1.0, weightMax: 4.0, asset: "FishSardine.png" },
  { name: "Mackerel", rarity: FishRarity.Basic, zone: FishingZone.Coastal, weightMin: 5.0, weightMax: 10.0, asset: "FishMackarel.png" },

  { name: "Giant Gourami", rarity: FishRarity.Rare, zone: FishingZone.Shore, weightMin: 5.0, weightMax: 10.0, asset: "FishGourami.png" },
  { name: "Red Snapper", rarity: FishRarity.Rare, zone: FishingZone.Coastal, weightMin: 7.0, weightMax: 13.0, asset: "FishRed-Snapper.png" },
  { name: "Barracuda", rarity: FishRarity.Rare, zone: FishingZone.Coastal, weightMin: 8.0, weightMax: 15.0, asset: "FishBarracuda.png" },
  { name: "Tuna", rarity: FishRarity.Rare, zone: FishingZone.OpenSea, weightMin: 12.0, weightMax: 20.0, asset: "FishTuna.png" },
  { name: "Mahi-Mahi", rarity: FishRarity.Rare, zone: FishingZone.OpenSea, weightMin: 10.0, weightMax: 18.0, asset: "FishMahi-mahi.png" },

  { name: "Bluefin Tuna", rarity: FishRarity.Monster, zone: FishingZone.OpenSea, weightMin: 20.0, weightMax: 30.0, asset: "FishBluefin-Tuna.png" },
  { name: "Arapaima", rarity: FishRarity.Monster, zone: FishingZone.Shore, weightMin: 15.0, weightMax: 25.0, asset: "FishArapaima.png" },
  { name: "Giant Trevally", rarity: FishRarity.Monster, zone: FishingZone.Coastal, weightMin: 10.0, weightMax: 20.0, asset: "FishGiant-Trevally.png" },
  { name: "Napoleon Wrasse", rarity: FishRarity.Monster, zone: FishingZone.Coastal, weightMin: 12.0, weightMax: 22.0, asset: "FishNapoleon-Wrasse.png" },
  { name: "Swordfish", rarity: FishRarity.Monster, zone: FishingZone.OpenSea, weightMin: 22.0, weightMax: 30.0, asset: "FishSwordfish.png" },

  { name: "Megalodon", rarity: FishRarity.Legendary, zone: FishingZone.Abyss, weightMin: 40.0, weightMax: 50.0, asset: "FishMegalodon.png" },
  { name: "Orca", rarity: FishRarity.Legendary, zone: FishingZone.OpenSea, weightMin: 30.0, weightMax: 45.0, asset: "FishOrca.png" },
  { name: "Dunkleosteus", rarity: FishRarity.Legendary, zone: FishingZone.Abyss, weightMin: 25.0, weightMax: 40.0, asset: "FishDunkleosteus.png" },
  { name: "Mosasaurus", rarity: FishRarity.Legendary, zone: FishingZone.Abyss, weightMin: 35.0, weightMax: 50.0, asset: "FishMosasaurus.png" },
  { name: "Colossal Squid", rarity: FishRarity.Legendary, zone: FishingZone.Abyss, weightMin: 20.0, weightMax: 35.0, asset: "FishGiant-Octopus.png" },

  // Apex tier — gated server-side by the EventConfig PDA.
  { name: "Anh Lucerna", rarity: FishRarity.Apex, zone: FishingZone.Abyss, weightMin: 30.0, weightMax: 50.0, asset: "apex/Anh-Lucerna.png" },
  { name: "Mattus Aureus", rarity: FishRarity.Apex, zone: FishingZone.Abyss, weightMin: 50.0, weightMax: 80.0, asset: "apex/Mattus-Aureus.png" },
  { name: "Maximus Tridens", rarity: FishRarity.Apex, zone: FishingZone.Abyss, weightMin: 70.0, weightMax: 100.0, asset: "apex/Maximus-Tridens.png" },
];

// Mirror of on-chain weights — source of truth is packages/programs/crates/hooked-common/src/constants.rs.
// Apex baseline 0; when event active, `eventApexBp` is taken from Basic (see `applyEventApexBp`).
const DAY_RARITY_WEIGHTS: [FishRarity, number][] = [
  [FishRarity.Basic, 0.7604],
  [FishRarity.Rare, 0.1980],
  [FishRarity.Monster, 0.0380],
  [FishRarity.Legendary, 0.0036],
  [FishRarity.Apex, 0],
];

const NIGHT_RARITY_WEIGHTS: [FishRarity, number][] = [
  [FishRarity.Basic, 0.7516],
  [FishRarity.Rare, 0.2020],
  [FishRarity.Monster, 0.0420],
  [FishRarity.Legendary, 0.0044],
  [FishRarity.Apex, 0],
];

function weightedRandom<T>(items: [T, number][], rand: () => number = Math.random): T {
  const roll = rand();
  let cumulative = 0;
  for (const [item, weight] of items) {
    cumulative += weight;
    if (roll < cumulative) return item;
  }
  return items[items.length - 1][0];
}

// Mirrors `effective_rarity_weights` in initiate_cast.rs. apex_bp in basis points (0..5000).
function applyEventApexBp(
  base: [FishRarity, number][],
  apexBp: number,
): [FishRarity, number][] {
  if (apexBp <= 0) return base;
  const apex = Math.min(apexBp, 5000) / 10_000;
  return base.map(([r, w]) => {
    if (r === FishRarity.Basic) return [r, Math.max(0, w - apex)] as [FishRarity, number];
    if (r === FishRarity.Apex) return [r, apex] as [FishRarity, number];
    return [r, w] as [FishRarity, number];
  });
}

export function rollRarity(
  window: "day" | "night" = "day",
  rand: () => number = Math.random,
  eventApexBp = 0,
): FishRarity {
  const base = window === "night" ? NIGHT_RARITY_WEIGHTS : DAY_RARITY_WEIGHTS;
  return weightedRandom(applyEventApexBp(base, eventApexBp), rand);
}

// Lucky Lure: takes from Basic, distributes 70/30 to Monster/Legendary.
function shiftWeights(
  base: [FishRarity, number][],
  rarityBonus: number,
): [FishRarity, number][] {
  if (rarityBonus <= 0) return base;
  const take = Math.min(rarityBonus, base.find(([r]) => r === FishRarity.Basic)?.[1] ?? 0);
  return base.map(([r, w]) => {
    if (r === FishRarity.Basic) return [r, w - take] as [FishRarity, number];
    if (r === FishRarity.Monster) return [r, w + take * 0.7] as [FishRarity, number];
    if (r === FishRarity.Legendary) return [r, w + take * 0.3] as [FishRarity, number];
    return [r, w] as [FishRarity, number];
  });
}

export interface RollOptions {
  zone?: FishingZone;
  rarityBonus?: number;
  eventApexBp?: number;
}

export function getSpeciesByRarity(rarity: FishRarity, zone?: FishingZone): FishSpecies[] {
  return FISH_SPECIES.filter(
    (s) => s.rarity === rarity && (zone == null || s.zone === zone)
  );
}

function rollWeight(species: FishSpecies, rand: () => number = Math.random): number {
  const w = species.weightMin + rand() * (species.weightMax - species.weightMin);
  return Math.round(w * 10) / 10;
}

export interface RolledFish {
  species: FishSpecies;
  weightKg: number;
}

export function rollFish(
  window: "day" | "night" = "day",
  opts: RollOptions = {},
  rand: () => number = Math.random,
): RolledFish {
  const base = window === "night" ? NIGHT_RARITY_WEIGHTS : DAY_RARITY_WEIGHTS;
  const eventAdjusted = applyEventApexBp(base, opts.eventApexBp ?? 0);
  const weights = shiftWeights(eventAdjusted, opts.rarityBonus ?? 0);
  const rarity = weightedRandom(weights, rand);
  let candidates = getSpeciesByRarity(rarity, opts.zone);
  if (candidates.length === 0) {
    candidates = getSpeciesByRarity(rarity);
  }
  const species = candidates[Math.floor(rand() * candidates.length)];
  return { species, weightKg: rollWeight(species, rand) };
}
