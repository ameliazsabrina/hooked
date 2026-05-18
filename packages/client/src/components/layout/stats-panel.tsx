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

/**
 * Window-timer label. Driven by the server-derived `windowState` (B4 fix
 * post-2026-05-18 incident) so the badge reflects the actual settlement
 * state of the room, not just clock math.
 *
 * Previously this returned "Closed" the millisecond `expiresAt - now` went
 * negative, even though the settlement keeper might not have actually paid
 * the player yet — that mismatch was the most visible symptom of the
 * incident. Now:
 *   - "active":   show days/hours remaining (uses expiresAt for the
 *                 countdown, which is still accurate while phase is active).
 *   - "closing":  window timer hit 0 but lifecycle tick hasn't fired —
 *                 "Closing" so the user knows the round is wrapping up.
 *   - "settling": close_room ran, return_principal in progress — "Returning…"
 *   - "closed":   keeper finished, but the next player.me poll hasn't
 *                 cleared the deposit row yet — "Closed".
 *   - "missing":  deposit references a non-existent room (defensive).
 *   - "deposit":  no active deposit; the panel as a whole renders "—".
 */
function getWindowTimerLabel(
  windowState: WindowState,
  expiresAt: string | null | undefined,
): string {
  if (!windowState || windowState === "deposit") return "—";
  if (windowState === "settling") return "Returning…";
  if (windowState === "closed") return "Closed";
  if (windowState === "closing") return "Closing";
  if (windowState === "missing") return "—";

  // "active" — render countdown from expiresAt.
  if (!expiresAt) return "Active";
  const remaining = new Date(expiresAt).getTime() - Date.now();
  if (remaining <= 0) return "Closing"; // belt-and-suspenders for clock skew
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
