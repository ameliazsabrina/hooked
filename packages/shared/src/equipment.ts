export type RodSlug = "old" | "branch" | "duck" | "iron" | "steel" | "shark";

export type BaitSlug = "fly" | "hophop" | "poppin" | "poppin2" | "sharkbait";

export interface RodDef {
  slug: RodSlug;
  name: string;
  tier: number;
  shellCost: number;
  greenBarBonusPx: number;
  asset: string;
}

export interface BaitDef {
  slug: BaitSlug;
  name: string;
  tier: number;
  shellCost: number;
  rarityBonus: number;
  chestBonus: number;
  progressDrainReduction: number;
  asset: string;
}

export const RODS: readonly RodDef[] = [
  {
    slug: "old",
    name: "Old Rod",
    tier: 0,
    shellCost: 0,
    greenBarBonusPx: 0,
    asset: "Old-Rod.png",
  },
  {
    slug: "branch",
    name: "Branch Rod",
    tier: 1,
    shellCost: 150,
    greenBarBonusPx: 10,
    asset: "Branch-Rod.png",
  },
  {
    slug: "duck",
    name: "Duck Rod",
    tier: 2,
    shellCost: 300,
    greenBarBonusPx: 20,
    asset: "Duck-Rod.png",
  },
  {
    slug: "iron",
    name: "Iron Rod",
    tier: 3,
    shellCost: 500,
    greenBarBonusPx: 30,
    asset: "Iron-Rod.png",
  },
  {
    slug: "steel",
    name: "Steel Rod",
    tier: 4,
    shellCost: 750,
    greenBarBonusPx: 40,
    asset: "Steel-Rod.png",
  },
  {
    slug: "shark",
    name: "Shark Rod",
    tier: 5,
    shellCost: 1050,
    greenBarBonusPx: 50,
    asset: "Shark-Rod.png",
  },
] as const;

export const BAITS: readonly BaitDef[] = [
  {
    slug: "fly",
    name: "Fly",
    tier: 0,
    shellCost: 0,
    rarityBonus: 0.0,
    chestBonus: 0.0,
    progressDrainReduction: 0.0,
    asset: "Fly.png",
  },
  {
    slug: "hophop",
    name: "HopHop",
    tier: 1,
    shellCost: 300,
    rarityBonus: 0.01,
    chestBonus: 0.02,
    progressDrainReduction: 0.05,
    asset: "HopHop.png",
  },
  {
    slug: "poppin",
    name: "Poppin",
    tier: 2,
    shellCost: 650,
    rarityBonus: 0.02,
    chestBonus: 0.04,
    progressDrainReduction: 0.1,
    asset: "Poppin.png",
  },
  {
    slug: "poppin2",
    name: "Poppin II",
    tier: 3,
    shellCost: 1100,
    rarityBonus: 0.03,
    chestBonus: 0.06,
    progressDrainReduction: 0.15,
    asset: "Poppin2.png",
  },
  {
    slug: "sharkbait",
    name: "Shark Bait",
    tier: 3,
    shellCost: 1700,
    rarityBonus: 0.03,
    chestBonus: 0.06,
    progressDrainReduction: 0.2,
    asset: "Shark-Bait.png",
  },
] as const;

export const STARTER_ROD: RodSlug = "old";
export const STARTER_BAIT: BaitSlug = "fly";

export function getRod(slug: RodSlug | string | undefined | null): RodDef {
  const match = RODS.find((r) => r.slug === slug);
  return match ?? RODS[0];
}

export function getBait(slug: BaitSlug | string | undefined | null): BaitDef {
  const match = BAITS.find((b) => b.slug === slug);
  return match ?? BAITS[0];
}

export function getRodByTier(tier: number): RodDef {
  return RODS.find((r) => r.tier === tier) ?? RODS[0];
}

export function isRodSlug(slug: string): slug is RodSlug {
  return RODS.some((r) => r.slug === slug);
}

export function isBaitSlug(slug: string): slug is BaitSlug {
  return BAITS.some((b) => b.slug === slug);
}
