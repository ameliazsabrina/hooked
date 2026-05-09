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
import { trpc } from "~/utils/trpc";
import "./onboarding.css";

export function DepositScreen() {
  const { publicKey } = useWallet();
  const anchorWallet = useAnchorWallet();
  const { connection } = useConnection();
  const [amount, setAmount] = useState<DepositAmount>(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const activeRoom = trpc.room.active.useQuery(undefined, {
    refetchInterval: 15_000,
  });
  const trpcUtils = trpc.useUtils();
  const recoverEntry = trpc.room.recoverEntry.useMutation();

  const openRoom =
    activeRoom.data?.status === "open" ? activeRoom.data.room : null;
  const openRoomId = openRoom?.onChainRoomId ?? null;

  const canSubmit =
    isValidDepositAmount(amount) &&
    !loading &&
    !!publicKey &&
    !!anchorWallet &&
    !!openRoomId;

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

      // PlayerProfile init is no longer needed: the on-chain hooked_fishing
      // program (which owned the PlayerProfile PDA) was decommissioned in
      // Phase 6. Player rows now live in MongoDB and are auto-created on
      // wallet auth — no on-chain pre-instruction required.
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
        // "already in use" / "already been processed" mean the prior deposit
        // already landed on-chain — server recovers state via RoomEntry.
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

      await trpcUtils.room.active.invalidate();
      await trpcUtils.player.me.invalidate();
      await trpcUtils.player.sessionState.invalidate();

      window.location.reload();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(
        /user rejected/i.test(message)
          ? "Transaction rejected."
          : /insufficient/i.test(message)
            ? "Insufficient SOL balance for this deposit."
            : `Deposit failed: ${message}`,
      );
    } finally {
      setLoading(false);
    }
  }

  const nextOpensAt =
    activeRoom.data?.status === "closed" ? activeRoom.data.nextOpensAt : null;

  // Tick once per second only while waiting for the next room window.
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
