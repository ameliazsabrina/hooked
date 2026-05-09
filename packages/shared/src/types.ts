import type { FishRarity, FishingZone } from "./fish.js";
import type { RodSlug, BaitSlug } from "./equipment.js";

export interface Equipment {
  rodTier: number;
  rodEquipped: RodSlug;
  baitEquipped: BaitSlug;
  luckyLureTier: number;
  ownedRods: RodSlug[];
  ownedBaits: BaitSlug[];
}

export interface CatchRecord {
  id: string;
  playerId: string;
  species: string;
  rarity: FishRarity;
  weightKg: number;
  score: number;
  zone: FishingZone;
  caughtAt: Date;
  isBounty: boolean;
  eventTag?: string;
  released: boolean;
}

export interface PlayerProfile {
  walletAddress: string;
  currentPoolId?: string;
  shellBalance: number;
  loginStreak: number;
  totalCatches: number;
  joinedAt: Date;
}

export interface LeaderboardEntry {
  rank: number;
  walletAddress: string;
  displayName?: string;
  dailyScore: number;
  topCatch?: {
    species: string;
    rarity: FishRarity;
    weightKg: number;
  };
}

export type SessionWindow = "day" | "night";

export interface PoolInfo {
  tier: number;
  activeMonth: string;
  realPlayerCount: number;
  totalPlayerCount: number;
  estimatedDailyYield: number;
}

export interface DailyLeaderboardSummary {
  date: string;
  tier: number;
  top3: {
    rank: number;
    displayName: string;
    dailyScore: number;
    prizeSOL: number;
  }[];
  prizePool: number;
  playerRank: number | null;
  playerScore: number | null;
}
