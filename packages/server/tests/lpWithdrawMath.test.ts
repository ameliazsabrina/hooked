import { describe, it, expect } from "vitest";
import { computeRentSafeWithdrawAmount } from "../src/services/lpWithdrawMath.js";

const RENT_MIN = 890_880n;

describe("computeRentSafeWithdrawAmount", () => {
  it("the production bug case: vault carries sub-rent dust above principal", () => {
    const amount = computeRentSafeWithdrawAmount({
      principal: 1_500_000_000n,
      vaultBalance: 1_500_030_000n,
      rentMin: RENT_MIN,
    });
    expect(amount).toBe(1_500_030_000n - RENT_MIN);
    const remainder = 1_500_030_000n - amount;
    expect(remainder).toBe(RENT_MIN);
    expect(remainder).toBeGreaterThanOrEqual(RENT_MIN);
  });

  it("vault exactly equals principal, withdraw all, vault closes to 0", () => {
    const amount = computeRentSafeWithdrawAmount({
      principal: 1_000_000_000n,
      vaultBalance: 1_000_000_000n,
      rentMin: RENT_MIN,
    });
    expect(amount).toBe(1_000_000_000n);
  });

  it("surplus above principal is already >= rentMin, no shrink", () => {
    const amount = computeRentSafeWithdrawAmount({
      principal: 1_000_000_000n,
      vaultBalance: 1_000_000_000n + RENT_MIN + 1n,
      rentMin: RENT_MIN,
    });
    expect(amount).toBe(1_000_000_000n);
    const remainder = 1_000_000_000n + RENT_MIN + 1n - amount;
    expect(remainder).toBeGreaterThanOrEqual(RENT_MIN);
  });

  it("vault holds less than principal, clamp to vault, closes to 0", () => {
    const amount = computeRentSafeWithdrawAmount({
      principal: 2_000_000_000n,
      vaultBalance: 1_200_000_000n,
      rentMin: RENT_MIN,
    });
    expect(amount).toBe(1_200_000_000n);
  });

  it("vault below principal and below rentMin, withdraw all, closes to 0", () => {
    const amount = computeRentSafeWithdrawAmount({
      principal: 1_000_000_000n,
      vaultBalance: 500_000n,
      rentMin: RENT_MIN,
    });
    expect(amount).toBe(500_000n);
    expect(500_000n - amount).toBe(0n);
  });

  it("vault equals exactly rentMin with tiny principal, refuse (0)", () => {
    const amount = computeRentSafeWithdrawAmount({
      principal: 500n,
      vaultBalance: RENT_MIN,
      rentMin: RENT_MIN,
    });
    expect(amount).toBe(0n);
  });

  it("tiny surplus that can't leave rentMin behind, refuse (0)", () => {
    const amount = computeRentSafeWithdrawAmount({
      principal: 100n,
      vaultBalance: 500n,
      rentMin: RENT_MIN,
    });
    expect(amount).toBe(0n);
  });

  it("empty vault returns 0", () => {
    const amount = computeRentSafeWithdrawAmount({
      principal: 1_000_000_000n,
      vaultBalance: 0n,
      rentMin: RENT_MIN,
    });
    expect(amount).toBe(0n);
  });

  it("invariant: a real withdraw never leaves the vault with sub-rent dust", () => {
    for (let p = 0n; p <= 3_000_000n; p += 250_000n) {
      for (let v = 0n; v <= 3_000_000n; v += 137_000n) {
        const amount = computeRentSafeWithdrawAmount({
          principal: p,
          vaultBalance: v,
          rentMin: RENT_MIN,
        });
        expect(amount).toBeGreaterThanOrEqual(0n);
        expect(amount).toBeLessThanOrEqual(v);
        if (amount > 0n) {
          const remainder = v - amount;
          expect(remainder === 0n || remainder >= RENT_MIN).toBe(true);
        }
      }
    }
  });
});
