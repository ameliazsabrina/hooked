import { describe, it, expect } from "vitest";
import { formatSolanaError } from "../src/solana/formatError.js";

describe("formatSolanaError", () => {
  it("handles plain Error", () => {
    const out = formatSolanaError(new Error("boom"));
    expect(out).toBe("boom");
  });

  it("handles null / undefined / non-Error values", () => {
    expect(formatSolanaError(null)).toBe("(no error)");
    expect(formatSolanaError(undefined)).toBe("(no error)");
    expect(formatSolanaError("just a string")).toBe("just a string");
    expect(formatSolanaError(42)).toBe("42");
  });

  it("includes program logs from SendTransactionError-shaped errors", () => {
    const err = Object.assign(new Error("Simulation failed."), {
      logs: [
        "Program ABC invoke [1]",
        "Program log: Instruction: ReturnPrincipal",
        "Program log: AnchorError thrown in return_principal.rs:65",
        "Program log: VaultInsufficientFunds",
      ],
    });
    const out = formatSolanaError(err);
    expect(out).toContain("Simulation failed.");
    expect(out).toContain("programLogs:");
    expect(out).toContain("Program log: VaultInsufficientFunds");
    expect(out).toContain("ReturnPrincipal");
  });

  it("falls back to transactionLogs when .logs is empty", () => {
    const err = Object.assign(new Error("revert"), {
      logs: [],
      transactionLogs: ["Program log: from transactionLogs"],
    });
    const out = formatSolanaError(err);
    expect(out).toContain("Program log: from transactionLogs");
  });

  it("caps long log arrays so a 200-line log doesn't blow up the line", () => {
    const logs = Array.from({ length: 200 }, (_, i) => `Program log: line ${i}`);
    const err = Object.assign(new Error("big"), { logs });
    const out = formatSolanaError(err);
    expect(out).toContain("line 0");
    expect(out).toContain("line 29");
    expect(out).not.toContain("line 30");
    expect(out).toMatch(/\(\+\d+ more\)/);
  });

  it("breaks out anchor error codes", () => {
    const err = Object.assign(new Error("AnchorError thrown"), {
      error: {
        errorCode: { code: "VaultInsufficientFunds", number: 6013 },
        errorMessage: "Insufficient vault balance to return principal.",
        origin: "return_principal",
      },
    });
    const out = formatSolanaError(err);
    expect(out).toContain("anchor: code=VaultInsufficientFunds (6013)");
    expect(out).toContain("origin=return_principal");
    expect(out).toContain("Insufficient vault balance");
  });

  it("walks the cause chain (AnchorError wrapping SendTransactionError)", () => {
    const innerLogs = [
      "Program log: inner reason",
      "Program log: VaultInsufficientFunds",
    ];
    const inner = Object.assign(new Error("Simulation failed."), {
      logs: innerLogs,
    });
    const outer = Object.assign(new Error("AnchorError"), {
      cause: inner,
      error: {
        errorCode: { code: "VaultInsufficientFunds", number: 6013 },
        errorMessage: "Insufficient vault balance",
      },
    });
    const out = formatSolanaError(outer);
    expect(out).toContain("AnchorError");
    expect(out).toContain("anchor: code=VaultInsufficientFunds");
    expect(out).toContain("cause:");
    expect(out).toContain("Program log: inner reason");
  });

  it("surfaces transactionMessage when different from top-line", () => {
    const err = Object.assign(new Error("top-line"), {
      transactionMessage: "more specific tx message",
    });
    const out = formatSolanaError(err);
    expect(out).toContain("transactionMessage: more specific tx message");
  });

  it("does not duplicate transactionMessage when it equals top-line", () => {
    const err = Object.assign(new Error("same"), {
      transactionMessage: "same",
    });
    const out = formatSolanaError(err);
    // Only one occurrence (the top-line, not a second "transactionMessage:" line).
    expect(out.split("transactionMessage:").length).toBe(1);
  });

  it("includes signature when present", () => {
    const err = Object.assign(new Error("revert"), {
      signature:
        "5nNfg6wmbzdrp431piApKwYk8B3GHW5vWVzyVcacPY7zf8PiYwMg43oxnaU6RTLhzqMRj5pRWUEXWfqSubrfgxay",
    });
    const out = formatSolanaError(err);
    expect(out).toContain("signature: 5nNfg6wmbzdrp431");
  });

  it("does not infinite-loop on self-referential cause", () => {
    const err = new Error("loop");
    (err as Error & { cause?: unknown }).cause = err;
    // Should produce one cause: line and stop. (Function checks
    // `cause !== err` to break the immediate self-reference.)
    const out = formatSolanaError(err);
    expect(out).toContain("loop");
    // The cause check prevents recursion when cause === err.
    expect(out.split("cause:").length).toBeLessThanOrEqual(2);
  });
});
