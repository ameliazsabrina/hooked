import { useWallet } from "@solana/wallet-adapter-react";
import { useBounties } from "~/hooks/use-bounties";
import { useSessionAuth } from "~/providers/session-auth-provider";

interface BountyListProps {
  variant?: "sidebar" | "popup";
}

type ActiveBounty = {
  periodId: string;
  cadence: "weekly";
  slot: number;
  templateId: string;
  label: string;
  reward:
    | { kind: "shells"; amount: number }
    | { kind: "sol"; lamports: number };
  target: number;
  progress: number;
  completed: boolean;
  completedAt: string | Date | null;
  endsAt: string | Date;
  rewardTxSignature: string | null;
  rewardSolPayoutStatus: "pending" | "sent" | "failed" | null;
};

function formatSol(lamports: number): string {
  const sol = lamports / 1_000_000_000;
  return sol >= 1 ? `${sol} SOL` : `${sol.toFixed(2).replace(/\.?0+$/, "")} SOL`;
}

function BountyRow({ bounty, itemClass }: { bounty: ActiveBounty; itemClass: string }) {
  const pct =
    bounty.target > 0
      ? Math.min(100, Math.round((bounty.progress / bounty.target) * 100))
      : 0;
  const done = bounty.completed;

  return (
    <div className={`${itemClass} bounty-item${done ? " bounty-item-done" : ""}`}>
      <div className="bounty-row">
        <span className="bounty-label">
          {done ? "✓ " : ""}
          {bounty.label}
        </span>
        <span className="bounty-reward">
          {bounty.reward.kind === "shells" ? (
            <>
              {bounty.reward.amount}{" "}
              <img
                src="/assets/ui/shell.png"
                alt="Shells"
                className="bounty-shell-icon"
              />
            </>
          ) : (
            <span className="bounty-sol-reward">
              {formatSol(bounty.reward.lamports)}
            </span>
          )}
        </span>
      </div>
      <div className="bounty-progress-line">
        <div className="sidebar-progress bounty-progress">
          <div
            className="sidebar-progress-fill"
            style={{ width: `${pct}%` }}
          />
        </div>
        <span className="bounty-progress-text">
          {Math.min(bounty.progress, bounty.target)}/{bounty.target}
        </span>
      </div>
    </div>
  );
}

export function BountyList({ variant = "sidebar" }: BountyListProps) {
  const { connected } = useWallet();
  const { ready: authReady } = useSessionAuth();

  const bountiesQuery = useBounties({
    enabled: connected && authReady,
    refetchInterval: 30_000,
  });

  const all = (bountiesQuery.data?.bounties ?? []) as ActiveBounty[];
  const itemClass =
    variant === "popup" ? "popup-panel-item" : "sidebar-item";

  if (!connected) {
    return (
      <div className={itemClass}>Connect wallet to see bounties</div>
    );
  }
  if (bountiesQuery.isLoading) {
    return <div className={itemClass}>Loading bounties…</div>;
  }
  if (all.length === 0) {
    return <div className={itemClass}>No active bounties</div>;
  }

  const bounties = all.slice(0, 2);

  return (
    <>
      {bounties.map((b) => (
        <BountyRow
          key={`${b.periodId}:${b.slot}`}
          bounty={b}
          itemClass={itemClass}
        />
      ))}
    </>
  );
}
