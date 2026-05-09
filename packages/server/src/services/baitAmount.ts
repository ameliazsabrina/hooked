import { baitsPerSession } from "@hooked/shared";

export function baitAmountForDeposit(depositSol: number): number {
  const amount = baitsPerSession(depositSol);
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 255) {
    throw new Error(`Invalid bait amount for ${depositSol} SOL deposit`);
  }
  return amount;
}
