import { useEffect, useState } from "react";
import {
  useWallet,
  useAnchorWallet,
  useConnection,
} from "@solana/wallet-adapter-react";
import { BN } from "@coral-xyz/anchor";
import { LAMPORTS_PER_SOL, SystemProgram } from "@solana/web3.js";
import {
  VALID_DEPOSIT_AMOUNTS,
  isValidDepositAmount,
  type DepositAmount,
} from "@hooked/shared";
import {
  getRoomsProgram,
  getRoomPda,
  getRoomVaultPda,
  getRoomEntryPda,
} from "~/utils/anchor";
import { useActiveRoom, useRecoverEntry } from "~/hooks/use-room";
import { useProgramPaused } from "~/hooks/use-program-paused";
import "./onboarding.css";

function collectErrorText(raw: unknown): string {
  // Walk nested error fields — wallet adapters/Anchor/web3.js wrap the real
  // message behind generic outer messages like "Unexpected error".
  const parts: string[] = [];
  const seen = new Set<unknown>();
  const visit = (node: unknown, depth: number) => {
    if (node == null || depth > 4 || seen.has(node)) return;
    if (typeof node === "string") {
      parts.push(node);
      return;
    }
    if (typeof node !== "object") return;
    seen.add(node);
    const obj = node as Record<string, unknown>;
    if (typeof obj.message === "string") parts.push(obj.message);
    if (Array.isArray(obj.logs))
      parts.push(obj.logs.filter((l) => typeof l === "string").join(" "));
    visit(obj.error, depth + 1);
    visit(obj.cause, depth + 1);
    visit((obj as { InstructionError?: unknown }).InstructionError, depth + 1);
  };
  visit(raw, 0);
  try {
    parts.push(JSON.stringify(raw));
  } catch {
  }
  return parts.join(" \n ");
}

function classifyDepositError(raw: unknown): string {
  const text = collectErrorText(raw);
  if (/user rejected/i.test(text)) return "Transaction rejected.";
  if (
    /Attempt to debit an account but found no record of a prior credit/i.test(text) ||
    /insufficient lamports/i.test(text) ||
    /insufficient funds for rent/i.test(text)
  )
    return "Your wallet doesn't have enough SOL to cover this deposit and network fees. Add SOL to your wallet and try again.";
  if (/insufficient/i.test(text)) return "Insufficient SOL balance for this deposit.";
  if (/Paused/.test(text)) return "Deposits are temporarily paused. Please try again shortly.";
  if (/RoomFull/.test(text)) return "This room is full.";
  if (/RoomCapacityExceeded/.test(text)) return "This deposit would exceed the room cap.";
  if (/RoomEntryWindowClosed/.test(text)) return "Entry window for this room has closed.";
  if (/InvalidDepositAmount|DepositBelowMinimum|DepositAboveMaximum/.test(text))
    return "Invalid deposit amount.";
  const top = raw instanceof Error ? raw.message : String(raw);
  return `Deposit failed: ${top}`;
}

export function DepositScreen() {
  const { publicKey } = useWallet();
  const anchorWallet = useAnchorWallet();
  const { connection } = useConnection();
  const [amount, setAmount] = useState<DepositAmount>(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const activeRoom = useActiveRoom({ refetchInterval: 15_000 });
  const recoverEntry = useRecoverEntry();
  const programPaused = useProgramPaused();

  const openRoom =
    activeRoom.data?.status === "open" ? activeRoom.data.room : null;
  const openRoomId = openRoom?.onChainRoomId ?? null;

  // null = config not loaded yet; on-chain check is source of truth.
  const canSubmit =
    isValidDepositAmount(amount) &&
    !loading &&
    !!publicKey &&
    !!anchorWallet &&
    !!openRoomId &&
    programPaused !== true;

  async function handleDeposit() {
    if (!canSubmit || !publicKey || !anchorWallet) return;
    if (!openRoomId) {
      setError("No active room available right now. Please try again shortly.");
      return;
    }

    setError("");
    setLoading(true);
    try {
      const program = getRoomsProgram(connection, anchorWallet);
      const roomPda = getRoomPda(BigInt(openRoomId));
      const roomVaultPda = getRoomVaultPda(roomPda);
      const roomEntryPda = getRoomEntryPda(roomPda, publicKey);
      const depositLamports = new BN(Math.floor(amount * LAMPORTS_PER_SOL));

      let txSignature: string | undefined;
      try {
        txSignature = await program.methods
          .depositRoom(depositLamports)
          .accounts({
            room: roomPda,
            roomVault: roomVaultPda,
            entry: roomEntryPda,
            authority: publicKey,
            systemProgram: SystemProgram.programId,
          } as never)
          .rpc({ commitment: "confirmed", skipPreflight: false });
      } catch (rpcErr) {
        const msg = rpcErr instanceof Error ? rpcErr.message : String(rpcErr);
        // Prior deposit already landed on-chain; server recovers via RoomEntry.
        const recoverable =
          /already in use/i.test(msg) ||
          /already been processed/i.test(msg) ||
          /AlreadyProcessed/i.test(msg);
        if (!recoverable) throw rpcErr;
      }

      await recoverEntry.mutateAsync({
        onChainRoomId: openRoomId,
        txSignature,
      });

      window.location.reload();
    } catch (err) {
      console.error("[DepositScreen] deposit failed", err);
      setError(classifyDepositError(err));
    } finally {
      setLoading(false);
    }
  }

  const nextOpensAt =
    activeRoom.data?.status === "closed" ? activeRoom.data.nextOpensAt : null;

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!nextOpensAt) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [nextOpensAt]);

  const formatCountdown = (targetIso: string, nowMs: number) => {
    const remainingMs = new Date(targetIso).getTime() - nowMs;
    if (remainingMs <= 0) return "any moment now";
    const totalSecs = Math.floor(remainingMs / 1000);
    const h = Math.floor(totalSecs / 3600);
    const m = Math.floor((totalSecs % 3600) / 60);
    const s = totalSecs % 60;
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  };

  const statusMsg = !publicKey
    ? "Connect your wallet to deposit."
    : programPaused === true
      ? "Deposits are temporarily paused for maintenance. Please try again shortly."
      : activeRoom.isLoading
        ? "Loading active room…"
        : nextOpensAt
          ? `No room open for entry right now. Next opens in ${formatCountdown(nextOpensAt, now)}.`
          : null;

  return (
    <div className="onboarding-overlay">
      <div className="onboarding-card">
        <h1 className="onboarding-title">Buy In</h1>
        <p className="onboarding-subtitle">
          Choose your buy-in amount. Your SOL is held in a trustless on-chain
          vault and determines how much bait you get each session.
        </p>

        <div className="pool-grid">
          {VALID_DEPOSIT_AMOUNTS.map((p) => (
            <button
              key={p}
              type="button"
              className={`pool-button${amount === p ? " selected" : ""}`}
              onClick={() => setAmount(p)}
              disabled={loading}
            >
              <span className="pool-amount">{p}</span>
              <span className="pool-label">SOL</span>
            </button>
          ))}
        </div>

        <button
          className="onboarding-submit"
          onClick={handleDeposit}
          disabled={!canSubmit}
        >
          Cast In: {amount} SOL
        </button>

        {statusMsg && <div className="onboarding-hint">{statusMsg}</div>}
        {error && <div className="onboarding-error">{error}</div>}
        {loading && <div className="pool-loading">Processing…</div>}
      </div>
    </div>
  );
}
