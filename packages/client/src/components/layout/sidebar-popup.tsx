import { useWallet } from "@solana/wallet-adapter-react";
import type { FishRarity } from "@hooked/shared";
import { usePlayer } from "~/hooks/use-player";
import { useRoomLeaderboard } from "~/hooks/use-room";
import { useSessionAuth } from "~/providers/session-auth-provider";
import { FishIndex } from "~/components/collections/fish-index";
import { BountyList } from "./bounty-list";
import type { EventStatus } from "~/components/hud/event-alert";
import type { RoomLeaderboardSnapshot } from "~/hooks/use-fishing-ws";

const LIVE_LEADERBOARD_MAX_AGE_MS = 60_000;

interface CatchEntry {
  id: string;
  species: string;
  rarity: FishRarity;
  asset: string;
  weightKg?: number;
  score?: number;
  shellValue: number;
}

interface ApexFishEntry {
  id: string;
  name: string;
  weightMinKg: number;
  weightMaxKg: number;
  assetUrl: string;
}

interface SidebarPopupProps {
  panel: "bounties" | "leaderboard" | "collections" | null;
  onClose: () => void;
  catches?: CatchEntry[];
  discoveredSpecies?: Set<string>;
  discoveredApexFish?: ApexFishEntry[];
  onSellFish?: (catchId: string, shellValue: number) => Promise<any>;
  onSellFishBulk?: (catchIds: string[]) => Promise<any>;
  eventStatus?: EventStatus | null;
  roomLeaderboard?: RoomLeaderboardSnapshot | null;
}

export function SidebarPopup({
  panel,
  onClose,
  catches,
  discoveredSpecies,
  discoveredApexFish,
  onSellFish,
  onSellFishBulk,
  eventStatus,
  roomLeaderboard,
}: SidebarPopupProps) {
  if (!panel) return null;

  if (panel === "collections") {
    return (
      <FishIndex
        catches={catches}
        discoveredSpecies={discoveredSpecies}
        discoveredApexFish={discoveredApexFish}
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
          {panel === "leaderboard" && (
            <LeaderboardPanel roomLeaderboard={roomLeaderboard ?? null} />
          )}
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

interface LeaderboardPanelProps {
  roomLeaderboard: RoomLeaderboardSnapshot | null;
}

function LeaderboardPanel({ roomLeaderboard }: LeaderboardPanelProps) {
  const { connected, publicKey } = useWallet();
  const { ready: authReady } = useSessionAuth();
  const playerQuery = usePlayer({
    enabled: connected && authReady,
  });
  const roomId = playerQuery.data?.exists ? playerQuery.data.roomId : null;

  const leaderboardQuery = useRoomLeaderboard(roomId, {
    enabled: connected && !!roomId,
    // WS broadcasts drive freshness; this is the first-paint fallback.
    refetchInterval: 60000,
  });

  const walletStr = publicKey?.toBase58() ?? null;
  const liveFresh =
    roomLeaderboard &&
    roomLeaderboard.roomId === roomId &&
    Date.now() - roomLeaderboard.updatedAt < LIVE_LEADERBOARD_MAX_AGE_MS;

  const entries = liveFresh
    ? roomLeaderboard.entries.map((e, i) => ({
        rank: i + 1,
        displayName: e.displayName ?? "Anonymous",
        dailyScore: e.score,
      }))
    : leaderboardQuery.data?.entries ?? [];

  // Live entries are top-N; tRPC fallback covers ranks outside top-50.
  let playerRank: number | null = leaderboardQuery.data?.playerRank ?? null;
  if (liveFresh && walletStr) {
    const idx = roomLeaderboard.entries.findIndex(
      (e) => e.wallet === walletStr,
    );
    if (idx >= 0) playerRank = idx + 1;
  }

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
