import { useWallet } from "@solana/wallet-adapter-react";
import type { FishRarity } from "@hooked/shared";
import { trpc } from "~/utils/trpc";
import { useSessionAuth } from "~/providers/session-auth-provider";
import { FishIndex } from "~/components/collections/fish-index";
import { BountyList } from "./bounty-list";
import type { EventStatus } from "~/components/hud/event-alert";

interface CatchEntry {
  id: string;
  species: string;
  rarity: FishRarity;
  asset: string;
  weightKg?: number;
  score?: number;
  shellValue: number;
}

interface SidebarPopupProps {
  panel: "bounties" | "leaderboard" | "collections" | null;
  onClose: () => void;
  catches?: CatchEntry[];
  discoveredSpecies?: Set<string>;
  onSellFish?: (catchId: string, shellValue: number) => Promise<any>;
  onSellFishBulk?: (catchIds: string[]) => Promise<any>;
  eventStatus?: EventStatus | null;
}

export function SidebarPopup({
  panel,
  onClose,
  catches,
  discoveredSpecies,
  onSellFish,
  onSellFishBulk,
  eventStatus,
}: SidebarPopupProps) {
  if (!panel) return null;

  if (panel === "collections") {
    return (
      <FishIndex
        catches={catches}
        discoveredSpecies={discoveredSpecies}
        onSellFish={onSellFish}
        onSellFishBulk={onSellFishBulk}
        onClose={onClose}
        eventStatus={eventStatus}
      />
    );
  }

  return (
    <div className="sidebar-popup-overlay" onClick={onClose}>
      <div
        className="sidebar-popup"
        onClick={(e) => e.stopPropagation()}
      >
        <button className="sidebar-popup-close" onClick={onClose}>
          ✕
        </button>
        <div className="sidebar-popup-content">
          {panel === "bounties" && <BountiesPanel />}
          {panel === "leaderboard" && <LeaderboardPanel />}
        </div>
      </div>
    </div>
  );
}

function BountiesPanel() {
  return (
    <div className="popup-panel">
      <div className="popup-panel-title">Bounties</div>
      <BountyList variant="popup" />
    </div>
  );
}

function LeaderboardPanel() {
  const { connected } = useWallet();
  const { ready: authReady } = useSessionAuth();
  const playerQuery = trpc.player.me.useQuery(undefined, {
    enabled: connected && authReady,
  });
  const roomId = playerQuery.data?.exists ? playerQuery.data.roomId : null;

  const leaderboardQuery = trpc.room.leaderboard.useQuery(
    { roomId: roomId ?? "" },
    {
      enabled: connected && !!roomId,
      refetchInterval: 15000,
    },
  );
  const entries = leaderboardQuery.data?.entries ?? [];
  const playerRank = leaderboardQuery.data?.playerRank ?? null;

  return (
    <div className="popup-panel">
      <div className="popup-panel-title">Leaderboard</div>
      {!roomId ? (
        <div className="popup-panel-item">Cast in to join a room</div>
      ) : leaderboardQuery.isLoading ? (
        <div className="popup-panel-item">Loading…</div>
      ) : entries.length === 0 ? (
        <div className="popup-panel-item">No entries yet</div>
      ) : (
        <div className="popup-leaderboard">
          {entries.slice(0, 5).map((entry) => {
            const isYou = playerRank === entry.rank;
            return (
              <div
                key={entry.rank}
                className={`leaderboard-entry${isYou ? " leaderboard-entry-you" : ""}`}
              >
                <span className="leaderboard-name">
                  {entry.rank <= 3 ? (
                    <img
                      className="leaderboard-medal"
                      src={`/assets/ui/${entry.rank}.png`}
                      alt={`Rank ${entry.rank}`}
                    />
                  ) : (
                    <span className="leaderboard-rank-num">
                      {entry.rank}.
                    </span>
                  )}
                  <span className="leaderboard-name-text">
                    {isYou ? "You" : entry.displayName}
                  </span>
                </span>
                <span>{entry.dailyScore.toLocaleString()}</span>
              </div>
            );
          })}
          {(playerRank === null || playerRank > 5) && (
            <div className="leaderboard-entry leaderboard-entry-you">
              <span className="leaderboard-name">
                <span className="leaderboard-rank-num">
                  {playerRank ? `${playerRank}.` : "—"}
                </span>
                <span className="leaderboard-name-text">You</span>
              </span>
              <span>
                {playerRank
                  ? entries
                      .find((e) => e.rank === playerRank)
                      ?.dailyScore.toLocaleString() ?? "—"
                  : "—"}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
