export type BountyCadence = "weekly";

export type BountyRarity = "basic" | "rare" | "monster" | "legendary" | "apex";

export type BountyGoalType =
  | "catch_rarity_count"
  | "catch_single_trigger"
  | "catch_score_threshold"
  | "leaderboard_rank";

export interface BountyGoalParams {
  rarity?: BountyRarity;
  rankLeq?: number;
}

export type BountyReward =
  | { kind: "shells"; amount: number }
  | { kind: "sol"; lamports: number };

export interface BountyTemplate {
  id: string;
  cadence: BountyCadence;
  label: string;
  goalType: BountyGoalType;
  goalParams: BountyGoalParams;
  target: number;
  reward: BountyReward;
  network?: "devnet" | "mainnet" | "all";
}

export const BOUNTY_TEMPLATES: BountyTemplate[] = [
  {
    id: "weekly_catch_3_rare",
    cadence: "weekly",
    label: "Catch 3 Rare fish",
    goalType: "catch_rarity_count",
    goalParams: { rarity: "rare" },
    target: 3,
    reward: { kind: "shells", amount: 50 },
  },
  {
    id: "weekly_catch_monster",
    cadence: "weekly",
    label: "Land a Monster",
    goalType: "catch_single_trigger",
    goalParams: { rarity: "monster" },
    target: 1,
    reward: { kind: "shells", amount: 120 },
  },
  {
    id: "weekly_catch_legendary",
    cadence: "weekly",
    label: "Land a Legendary",
    goalType: "catch_single_trigger",
    goalParams: { rarity: "legendary" },
    target: 1,
    reward: { kind: "shells", amount: 250 },
  },
  {
    id: "weekly_score_2000",
    cadence: "weekly",
    label: "Score 2,000 this week",
    goalType: "catch_score_threshold",
    goalParams: {},
    target: 2000,
    reward: { kind: "shells", amount: 80 },
  },
  {
    id: "weekly_catch_10_basic",
    cadence: "weekly",
    label: "Catch 10 Basic fish",
    goalType: "catch_rarity_count",
    goalParams: { rarity: "basic" },
    target: 10,
    reward: { kind: "shells", amount: 40 },
  },
  {
    id: "weekly_score_500",
    cadence: "weekly",
    label: "Score 500 this week",
    goalType: "catch_score_threshold",
    goalParams: {},
    target: 500,
    reward: { kind: "shells", amount: 25 },
  },
  {
    id: "weekly_deep_sea_champion_devnet",
    cadence: "weekly",
    label: "Deep-Sea Champion: 5,000 score",
    goalType: "catch_score_threshold",
    goalParams: {},
    target: 5000,
    reward: { kind: "sol", lamports: 200_000_000 },
    network: "devnet",
  },
  {
    id: "weekly_top_3",
    cadence: "weekly",
    label: "Top 3 this week",
    goalType: "leaderboard_rank",
    goalParams: { rankLeq: 3 },
    target: 1,
    reward: { kind: "shells", amount: 200 },
  },
  {
    id: "weekly_top_10",
    cadence: "weekly",
    label: "Top 10 this week",
    goalType: "leaderboard_rank",
    goalParams: { rankLeq: 10 },
    target: 1,
    reward: { kind: "shells", amount: 60 },
  },
];

export const WEEKLY_SLOT_COUNT = 2;

export function getTemplatesForNetwork(isDevnet: boolean): BountyTemplate[] {
  return BOUNTY_TEMPLATES.filter((t) => {
    if (t.reward.kind === "sol" && !isDevnet) return false;
    if (t.network === "devnet" && !isDevnet) return false;
    if (t.network === "mainnet" && isDevnet) return false;
    return true;
  });
}

export function getTemplateById(id: string): BountyTemplate | undefined {
  return BOUNTY_TEMPLATES.find((t) => t.id === id);
}
