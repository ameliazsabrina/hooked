import { useWallet } from "@solana/wallet-adapter-react";
import { trpc } from "~/utils/trpc";
import { useSessionAuth } from "~/providers/session-auth-provider";

type WindowState =
  | "deposit"
  | "active"
  | "closing"
  | "settling"
  | "closed"
  | "missing"
  | null
  | undefined;

/** Window-timer label driven by server-derived windowState so the badge
 *  reflects the actual settlement state, not just clock math. */
function getWindowTimerLabel(
  windowState: WindowState,
  expiresAt: string | null | undefined,
): string {
  if (!windowState || windowState === "deposit") return "—";
  if (windowState === "settling") return "Returning…";
  if (windowState === "closed") return "Closed";
  if (windowState === "closing") return "Closing";
  if (windowState === "missing") return "—";

  if (!expiresAt) return "Active";
  const remaining = new Date(expiresAt).getTime() - Date.now();
  if (remaining <= 0) return "Closing";
  const days = Math.floor(remaining / (24 * 60 * 60 * 1000));
  const hours = Math.floor(
    (remaining % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000),
  );
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
  const windowState =
    data?.exists && "windowState" in data
      ? (data.windowState as WindowState)
      : null;

  return (
    <div className="stats-panel">
      <div className="panel-title">Stats</div>
      <div className="stat-row">
        <span>Cast In</span>
        <span>{depositAmount ? `${depositAmount} SOL` : "—"}</span>
      </div>
      <div className="stat-row">
        <span>Window Timer</span>
        <span>{getWindowTimerLabel(windowState, expiresAt as string | null)}</span>
      </div>
      <div className="stat-row">
        <span>Bounty Progress</span>
        <span>0 / 3</span>
      </div>
    </div>
  );
}
