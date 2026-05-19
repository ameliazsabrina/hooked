export const BAIT_CONFIG = {
  // Legacy flat allocation — kept for LP-on mode.
  dayWindow: 15,
  nightWindow: 15,
  maxStreakBonus: 3,
} as const;

// PRD §5.4: baits per session = deposit_SOL × 10 (per day + per night window).
export function baitsPerSession(depositSol: number): number {
  if (!Number.isFinite(depositSol) || depositSol <= 0) return 0;
  return Math.max(1, Math.floor(depositSol * 10));
}

/** @deprecated Use YIELD_SPLIT from scoring.ts */
export const PLATFORM_FEE_RATE = 0.3;
/** @deprecated Use YIELD_SPLIT from scoring.ts */
export const PLAYER_POOL_RATE = 0.7;

// Legacy monthly-pool router only (projected-yield UI); weekly-room flow uses realized LP yield.
export const DEPOSIT_APY_ESTIMATE = 0.064;

// Weekly-room LP targets (Meteora DLMM SOL/USDC). Monitoring SLOs only — realized yield is whatever the cycle nets.
// 5%/wk is a stretch goal; realistic top-pool fee yield is 1–4%. No guaranteed minimum.
export const LP_WEEKLY_YIELD_STRETCH_TARGET = 0.05;
export const LP_WEEKLY_YIELD_REALISTIC_BAND = { min: 0.01, max: 0.04 } as const;

// LP_MANAGER buffer must cover ~10% SOL price move on a ±10-bin Spot position
// against the largest active room's principal, to absorb IL without touching player principal.
export const LP_IL_BUFFER_PCT = 0.05;

export const POOL_DURATION_DAYS = 30;

export const ENTRY_WINDOW_DAYS = 7;

// Single bucket until Phase B rooms.
export const POOL_TIERS = [1] as const;
export type PoolTier = (typeof POOL_TIERS)[number];

// PRD v2.2 §4.2: allowed deposit amounts per player (0.5 SOL steps, 0.5–2 SOL).
export const VALID_DEPOSIT_AMOUNTS = [0.5, 1, 1.5, 2] as const;
export type DepositAmount = (typeof VALID_DEPOSIT_AMOUNTS)[number];
export const MIN_DEPOSIT_SOL = VALID_DEPOSIT_AMOUNTS[0];
export const MAX_DEPOSIT_SOL = VALID_DEPOSIT_AMOUNTS[VALID_DEPOSIT_AMOUNTS.length - 1];

export const isValidDepositAmount = (sol: number): sol is DepositAmount =>
  (VALID_DEPOSIT_AMOUNTS as readonly number[]).includes(sol);
