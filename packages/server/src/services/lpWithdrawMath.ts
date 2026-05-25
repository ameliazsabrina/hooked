/**
 * Rent-safe withdraw amount for the on-chain `withdraw_to_lp_manager`
 * instruction.
 *
 * The instruction transfers `amount` lamports out of the room vault PDA via a
 * System-program CPI. Solana rejects any transfer that would leave an account
 * holding a NON-ZERO balance below the rent-exempt minimum ("insufficient
 * funds for rent"). So the vault must end at exactly 0, or at >= rentMin —
 * never in between.
 *
 * Withdrawing the full principal blindly is the bug that stranded rooms: when
 * the vault carries a little dust above the principal (e.g. 1_500_030_000 with
 * principal 1_500_000_000), withdrawing the full 1.5 SOL leaves 30_000 lamports
 * — non-zero but sub-rent — and the tx fails simulation.
 *
 * This mirrors the manual `withdrawToLpManager.ts` CLI: take min(principal,
 * vault); if the remainder would be sub-rent, shrink the withdraw so exactly
 * `rentMin` stays behind (later reaped by `finalize_room`).
 *
 * @returns lamports to withdraw, or 0n when nothing can be safely withdrawn.
 */
export function computeRentSafeWithdrawAmount(opts: {
  principal: bigint;
  vaultBalance: bigint;
  rentMin: bigint;
}): bigint {
  const { principal, vaultBalance, rentMin } = opts;

  // Never request more than the vault actually holds.
  let amount = principal < vaultBalance ? principal : vaultBalance;

  const remainder = vaultBalance - amount;
  if (remainder > 0n && remainder < rentMin) {
    // Leaving sub-rent dust would revert; keep exactly rentMin instead.
    amount = vaultBalance - rentMin;
  }

  return amount > 0n ? amount : 0n;
}
