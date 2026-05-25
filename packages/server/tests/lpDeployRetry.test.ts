import { describe, it, expect } from "vitest";
import {
  classifyDeployError,
  nextStatusOnFailure,
  shouldAttemptDeploy,
} from "../src/services/lpDeployRetry.js";

describe("classifyDeployError", () => {
  it("classifies the confirmed AddLiquidity insufficient-funds revert as terminal", () => {
    expect(
      classifyDeployError(
        "Transaction simulation failed: custom program error: 0x1 ... Program log: Error: insufficient funds",
      ),
    ).toBe("terminal");
  });

  it("classifies on-chain window/guard reverts as terminal", () => {
    expect(classifyDeployError("Error: LpDeployWindowNotOpen")).toBe("terminal");
    expect(classifyDeployError("custom: LpAlreadyDeployed")).toBe("terminal");
    expect(classifyDeployError("Invalid public key input")).toBe("terminal");
  });

  it("classifies RPC/network hiccups as transient", () => {
    expect(classifyDeployError("Blockhash not found")).toBe("transient");
    expect(classifyDeployError("block height exceeded")).toBe("transient");
    expect(classifyDeployError("ETIMEDOUT")).toBe("transient");
    expect(classifyDeployError("503 Service Unavailable")).toBe("transient");
    expect(classifyDeployError("429 Too Many Requests")).toBe("transient");
  });

  it("defaults unknown errors to transient", () => {
    expect(classifyDeployError("some weird unseen error")).toBe("transient");
  });

  it("is case-insensitive", () => {
    expect(classifyDeployError("INSUFFICIENT FUNDS")).toBe("terminal");
    expect(classifyDeployError("BlockHash Not Found")).toBe("transient");
  });
});

describe("nextStatusOnFailure", () => {
  it("terminal error → failed_permanent immediately, regardless of attempts", () => {
    expect(
      nextStatusOnFailure({ message: "insufficient funds", attempts: 1, maxAttempts: 3 }),
    ).toBe("failed_permanent");
  });

  it("transient error under the cap → failed (retryable)", () => {
    expect(
      nextStatusOnFailure({ message: "blockhash not found", attempts: 1, maxAttempts: 3 }),
    ).toBe("failed");
  });

  it("transient error at the cap → failed_permanent", () => {
    expect(
      nextStatusOnFailure({ message: "blockhash not found", attempts: 3, maxAttempts: 3 }),
    ).toBe("failed_permanent");
  });
});

describe("shouldAttemptDeploy", () => {
  it("picks up pending and failed rooms under the cap", () => {
    expect(shouldAttemptDeploy({ status: "pending", attempts: 0, maxAttempts: 3 })).toBe(true);
    expect(shouldAttemptDeploy({ status: "failed", attempts: 2, maxAttempts: 3 })).toBe(true);
  });

  it("never picks up terminal/final states", () => {
    expect(shouldAttemptDeploy({ status: "failed_permanent", attempts: 1, maxAttempts: 3 })).toBe(false);
    expect(shouldAttemptDeploy({ status: "deployed", attempts: 1, maxAttempts: 3 })).toBe(false);
    expect(shouldAttemptDeploy({ status: "exited", attempts: 1, maxAttempts: 3 })).toBe(false);
    expect(shouldAttemptDeploy({ status: "skipped", attempts: 1, maxAttempts: 3 })).toBe(false);
  });

  it("stops once attempts hit the cap", () => {
    expect(shouldAttemptDeploy({ status: "failed", attempts: 3, maxAttempts: 3 })).toBe(false);
  });
});
