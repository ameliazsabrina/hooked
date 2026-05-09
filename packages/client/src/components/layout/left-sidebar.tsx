import { useWallet } from "@solana/wallet-adapter-react";
import { trpc } from "~/utils/trpc";
import { useSessionAuth } from "~/providers/session-auth-provider";
import { BountyList } from "./bounty-list";

interface LeftSidebarProps {
  nickname?: string;
}

const STREAK_CYCLE = 7;

export function LeftSidebar({ nickname }: LeftSidebarProps) {
  const { connected } = useWallet();
  const { ready: authReady } = useSessionAuth();
  const playerQuery = trpc.player.me.useQuery(undefined, {
    enabled: connected && authReady,
  });
  const streak = playerQuery.data?.exists ? playerQuery.data.loginStreak : 0;
  const dayInCycle = streak > 0 ? ((streak - 1) % STREAK_CYCLE) + 1 : 0;
  const progressPct = (dayInCycle / STREAK_CYCLE) * 100;

  return (
    <aside className="sidebar sidebar-left">
      <div className="sidebar-greeting">
        <div>Bon voyage,</div>
        <div>{nickname ? `Captain ${nickname}` : "Hooked"}!</div>
      </div>
      <div className="sidebar-section sidebar-section-bounties">
        <div className="sidebar-section-title">Bounties</div>
        <BountyList variant="sidebar" />
      </div>
      <div className="sidebar-section sidebar-section-streak">
        <div className="sidebar-section-title">Login Streak</div>
        <div className="sidebar-item">Day {dayInCycle} / {STREAK_CYCLE}</div>
        <div className="sidebar-progress">
          <div className="sidebar-progress-fill" style={{ width: `${progressPct}%` }} />
          <img
            src="/assets/ui/streak-chest.png"
            alt=""
            className="streak-prize-marker"
            title="Mystery reward on Day 7"
          />
        </div>
      </div>
    </aside>
  );
}
