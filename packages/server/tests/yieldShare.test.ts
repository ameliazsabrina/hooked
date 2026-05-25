import { describe, it, expect } from "vitest";
import { Keypair } from "@solana/web3.js";
import { shareForRecipient, yieldShareLamports } from "../src/services/yieldShare.js";

describe("yieldShare — per-player split for return_principal", () => {
  const first = Keypair.generate().publicKey;
  const second = Keypair.generate().publicKey;
  const third = Keypair.generate().publicKey;
  const someoneElse = Keypair.generate().publicKey;
  const top = { first, second, third };

  it("zero yield → zero share for everyone (early-return, no key compare)", () => {
    expect(shareForRecipient(first, 0n, top)).toBe(0n);
    expect(shareForRecipient(second, 0n, top)).toBe(0n);
    expect(shareForRecipient(third, 0n, top)).toBe(0n);
    expect(shareForRecipient(someoneElse, 0n, top)).toBe(0n);
  });

  it("matches the on-chain BPS split — 40 / 20 / 10 of total yield", () => {
    const totalYield = 1_000_000_000n;
    expect(shareForRecipient(first, totalYield, top)).toBe(400_000_000n);
    expect(shareForRecipient(second, totalYield, top)).toBe(200_000_000n);
    expect(shareForRecipient(third, totalYield, top)).toBe(100_000_000n);
  });

  it("non-top-3 recipients get 0", () => {
    expect(shareForRecipient(someoneElse, 1_000_000_000n, top)).toBe(0n);
  });

  it("split sums to 70% — the remaining 30% is the protocol share extracted by close_room", () => {
    const total = 1_000_000_000n;
    const sum =
      shareForRecipient(first, total, top) +
      shareForRecipient(second, total, top) +
      shareForRecipient(third, total, top);
    expect(sum).toBe((total * 7000n) / 10_000n);
  });

  it("BPS math truncates (no rounding) — 7 lamports yield → 2/1/0 to 1st/2nd/3rd", () => {
    expect(shareForRecipient(first, 7n, top)).toBe(2n);
    expect(shareForRecipient(second, 7n, top)).toBe(1n);
    expect(shareForRecipient(third, 7n, top)).toBe(0n);
  });

  it("yieldShareLamports is the underlying BPS multiply-divide", () => {
    expect(yieldShareLamports(10_000n, 4000)).toBe(4000n);
    expect(yieldShareLamports(10_000n, 2000)).toBe(2000n);
    expect(yieldShareLamports(10_000n, 1000)).toBe(1000n);
  });
});
