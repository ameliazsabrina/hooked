import { PublicKey } from "@solana/web3.js";

// On-chain split (BPS, must match
// packages/programs/crates/hooked-common/src/constants.rs):
//   protocol 30%, first 40%, second 20%, third 10%.
// close_room extracts the protocol share; return_principal pays per-player
// shares. Non-top-3 entries get 0 yield.
export const YIELD_BPS_FIRST = 4000;
export const YIELD_BPS_SECOND = 2000;
export const YIELD_BPS_THIRD = 1000;
export const BPS_SCALE = 10_000;

export type TopThree = {
  first: PublicKey;
  second: PublicKey;
  third: PublicKey;
};

export function yieldShareLamports(
  totalYieldLamports: bigint,
  bps: number,
): bigint {
  return (totalYieldLamports * BigInt(bps)) / BigInt(BPS_SCALE);
}

export function shareForRecipient(
  recipient: PublicKey,
  totalYieldLamports: bigint,
  topThree: TopThree,
): bigint {
  if (totalYieldLamports === 0n) return 0n;
  if (recipient.equals(topThree.first))
    return yieldShareLamports(totalYieldLamports, YIELD_BPS_FIRST);
  if (recipient.equals(topThree.second))
    return yieldShareLamports(totalYieldLamports, YIELD_BPS_SECOND);
  if (recipient.equals(topThree.third))
    return yieldShareLamports(totalYieldLamports, YIELD_BPS_THIRD);
  return 0n;
}
