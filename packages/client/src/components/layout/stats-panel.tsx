import { useWallet } from "@solana/wallet-adapter-react";
import { trpc } from "~/utils/trpc";
import { useSessionAuth } from "~/providers/session-auth-provider";

// Time until the room window closes. The keeper auto-returns SOL after the
// window ends — at that point the player is back at DepositScreen for the
// next room, so we surface "Closed" instead of the old "Ready" sentinel
// (which implied a manual unlock step that doesn't exist).
function getWindowTimer(expiresAt: string | null | undefined): string {
  if (!expiresAt) return "—";
  const remaining = new Date(expiresAt).getTime() - Date.now();

  if (remaining <= 0) return "Closed";

  const days = Math.floor(remaining / (24 * 60 * 60 * 1000));
  const hours = Math.floor((remaining % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
  return `${days}d ${hours}h`;
}

export function StatsPanel() {
  const { connected } = useWallet();
  const { ready: authReady } = useSessionAuth();
  const playerQuery = trpc.player.me.useQuery(undefined, {
    enabled: connected && authReady,
  });

  const data = playerQuery.data;
  const depositAmount = data?.exists ? data.depositAmount : null;
  const expiresAt = data?.exists ? data.expiresAt : null;

  return (
    <div className="stats-panel">
      <div className="panel-title">Stats</div>
      <div className="stat-row">
        <span>Cast In</span>
        <span>{depositAmount ? `${depositAmount} SOL` : "—"}</span>
      </div>
      <div className="stat-row">
        <span>Window Timer</span>
        <span>{getWindowTimer(expiresAt as string | null)}</span>
      </div>
      <div className="stat-row">
        <span>Bounty Progress</span>
        <span>0 / 3</span>
      </div>
    </div>
  );
}
