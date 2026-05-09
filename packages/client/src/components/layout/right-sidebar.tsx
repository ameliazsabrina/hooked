import { useState, useRef, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { RARITY_COLORS, type FishRarity } from "@hooked/shared";
import { trpc } from "~/utils/trpc";
import { useSessionAuth } from "~/providers/session-auth-provider";
import { playSfx } from "~/utils/audio";
import { SettingsButton } from "~/components/settings/settings-button";

interface CatchEntry {
  id: string;
  species: string;
  rarity: FishRarity;
  asset: string;
  weightKg?: number;
  score?: number;
  shellValue: number;
}

interface RightSidebarProps {
  catches?: CatchEntry[];
  onSellFish?: (catchId: string, shellValue: number) => Promise<any>;
  onOpenSettings?: () => void;
}

const PAGE_SIZE = 9;

interface CardState {
  fish: CatchEntry;
  index: number;
  anchorX: number;
  anchorY: number;
  shellValue: number;
  pinned: boolean;
}

function clampToViewport(anchorX: number, anchorY: number, el: HTMLElement) {
  const cw = el.offsetWidth;
  const ch = el.offsetHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const pad = 8;

  let left = anchorX - cw / 2;
  let top = anchorY;

  if (top + ch + pad > vh) {
    top = anchorY - ch - 56;
  }
  if (left + cw + pad > vw) left = vw - cw - pad;
  if (left < pad) left = pad;
  if (top < pad) top = pad;
  if (top + ch + pad > vh) top = vh - ch - pad;

  return { left, top };
}

export function RightSidebar({
  catches = [],
  onSellFish,
  onOpenSettings,
}: RightSidebarProps) {
  const { connected } = useWallet();
  const { ready: authReady } = useSessionAuth();
  const [page, setPage] = useState(0);
  const [card, setCard] = useState<CardState | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [confirmSell, setConfirmSell] = useState<{
    fish: CatchEntry;
    shellValue: number;
  } | null>(null);
  const [selling, setSelling] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

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
  const leaderboardEntries = leaderboardQuery.data?.entries ?? [];
  const playerRank = leaderboardQuery.data?.playerRank ?? null;
  const ordered = [...catches].reverse();
  const totalPages = Math.max(1, Math.ceil(ordered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const start = safePage * PAGE_SIZE;
  const pageItems = ordered.slice(start, start + PAGE_SIZE);

  const handleEnter =
    (fish: CatchEntry, slotIndex: number) =>
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (card?.pinned) return;
      const rect = e.currentTarget.getBoundingClientRect();
      setCard({
        fish,
        index: slotIndex,
        anchorX: rect.left + rect.width / 2,
        anchorY: rect.bottom + 6,
        shellValue: fish.shellValue,
        pinned: false,
      });
      setPos(null);
    };

  const handleLeave = () => {
    if (card && !card.pinned) {
      setCard(null);
      setPos(null);
    }
  };

  const handleClick =
    (fish: CatchEntry, slotIndex: number) =>
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (card?.pinned && card.index === slotIndex) {
        setCard(null);
        setPos(null);
        return;
      }
      const rect = e.currentTarget.getBoundingClientRect();
      setCard({
        fish,
        index: slotIndex,
        anchorX: rect.left + rect.width / 2,
        anchorY: rect.bottom + 6,
        shellValue: fish.shellValue,
        pinned: true,
      });
      setPos(null);
    };

  const dismiss = () => {
    setCard(null);
    setPos(null);
  };

  useLayoutEffect(() => {
    if (!card || !cardRef.current) {
      setPos(null);
      return;
    }
    setPos(clampToViewport(card.anchorX, card.anchorY, cardRef.current));
  }, [card]);

  return (
    <aside className="sidebar sidebar-right">
      <div className="sidebar-wallet">
        <WalletMultiButton />
        {onOpenSettings && (
          <SettingsButton onClick={onOpenSettings} />
        )}
      </div>
      <div className="sidebar-section sidebar-section-collectibles">
        <div className="sidebar-section-title">Collectibles</div>
        <div className="collectible-grid">
          {Array.from({ length: PAGE_SIZE }).map((_, i) => {
            const fish = pageItems[i];
            return (
              <div
                key={i}
                className="collectible-slot"
                style={
                  fish
                    ? {
                        border: `2px solid ${RARITY_COLORS[fish.rarity]}`,
                        borderRadius: 4,
                        cursor: "pointer",
                      }
                    : undefined
                }
                onMouseEnter={fish ? handleEnter(fish, i) : undefined}
                onMouseLeave={fish ? handleLeave : undefined}
                onClick={fish ? handleClick(fish, i) : undefined}
              >
                {fish && (
                  <img src={`/assets/Fish/${fish.asset}`} alt={fish.species} />
                )}
              </div>
            );
          })}
        </div>
        <div className="collectible-pager">
          <button
            type="button"
            className="collectible-pager-btn"
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={safePage === 0}
            aria-label="Previous page"
          >
            ◀
          </button>
          <span className="collectible-pager-label">
            {safePage + 1} / {totalPages}
          </span>
          <button
            type="button"
            className="collectible-pager-btn"
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            disabled={safePage >= totalPages - 1}
            aria-label="Next page"
          >
            ▶
          </button>
        </div>
      </div>
      {card &&
        createPortal(
          <>
            {card.pinned && (
              <div className="collectible-card-backdrop" onClick={dismiss} />
            )}
            <div
              ref={cardRef}
              className={`collectible-card collectible-card-floating${!card.pinned ? " collectible-card-hover" : ""}`}
              style={{
                left: pos ? pos.left : card.anchorX,
                top: pos ? pos.top : card.anchorY,
                transform: pos ? "none" : "translateX(-50%)",
                visibility: pos ? "visible" : "hidden",
                borderColor: RARITY_COLORS[card.fish.rarity],
              }}
            >
              <div
                className="collectible-card-species"
                style={{ color: RARITY_COLORS[card.fish.rarity] }}
              >
                {card.fish.species}
              </div>
              <div className="collectible-card-rarity">{card.fish.rarity}</div>
              {card.fish.weightKg !== undefined && (
                <div className="collectible-card-row">
                  <span>Weight</span>
                  <span>{card.fish.weightKg.toFixed(2)} kg</span>
                </div>
              )}
              {card.fish.score !== undefined && (
                <div className="collectible-card-row">
                  <span>Score</span>
                  <span>{card.fish.score}</span>
                </div>
              )}
              {card.fish.rarity !== "apex" && card.shellValue > 0 && (
                <button
                  type="button"
                  className="collectible-card-sell"
                  onClick={() => {
                    setConfirmSell({
                      fish: card.fish,
                      shellValue: card.shellValue,
                    });
                    dismiss();
                  }}
                >
                  <img
                    src="/assets/ui/shell.png"
                    alt="Shells"
                    className="collectible-card-sell-icon"
                  />
                  Sell {card.shellValue}
                </button>
              )}
            </div>
          </>,
          document.body,
        )}
      {confirmSell &&
        createPortal(
          <div
            className="sell-confirm-backdrop"
            onClick={() => !selling && setConfirmSell(null)}
          >
            <div
              className="sell-confirm-popup"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="sell-confirm-title">Sell Fish?</div>
              <div className="sell-confirm-fish">
                <img
                  src={`/assets/Fish/${confirmSell.fish.asset}`}
                  alt={confirmSell.fish.species}
                  className="sell-confirm-fish-img"
                />
                <div>
                  <div
                    className="sell-confirm-species"
                    style={{ color: RARITY_COLORS[confirmSell.fish.rarity] }}
                  >
                    {confirmSell.fish.species}
                  </div>
                  <div className="sell-confirm-rarity">
                    {confirmSell.fish.rarity}
                  </div>
                </div>
              </div>
              <div className="sell-confirm-value">
                <img
                  src="/assets/ui/shell.png"
                  alt="Shells"
                  className="sell-confirm-shell-icon"
                />
                <span>+{confirmSell.shellValue} Shells</span>
              </div>
              <div className="sell-confirm-actions">
                <button
                  type="button"
                  className="sell-confirm-btn sell-confirm-cancel"
                  onClick={() => setConfirmSell(null)}
                  disabled={selling}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="sell-confirm-btn sell-confirm-yes"
                  disabled={selling}
                  onClick={async () => {
                    if (!onSellFish || !confirmSell) return;
                    setSelling(true);
                    try {
                      await onSellFish(
                        confirmSell.fish.id,
                        confirmSell.shellValue,
                      );
                      playSfx("buySell");
                      setConfirmSell(null);
                    } catch {
                    } finally {
                      setSelling(false);
                    }
                  }}
                >
                  {selling ? "Selling..." : "Sell"}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
      {(
        <div className="sidebar-section sidebar-section-leaderboard">
          <div className="sidebar-section-title">Leaderboard</div>
          {!roomId ? (
            <div className="leaderboard-entry">
              <span>Cast in to join a room</span>
            </div>
          ) : leaderboardQuery.isLoading ? (
            <div className="leaderboard-entry">
              <span>Loading…</span>
            </div>
          ) : leaderboardEntries.length === 0 ? (
            <div className="leaderboard-entry">
              <span>No entries yet</span>
            </div>
          ) : (
            <>
              {leaderboardEntries.slice(0, 3).map((entry) => {
                const isYou = playerRank === entry.rank;
                return (
                  <div
                    key={entry.rank}
                    className={`leaderboard-entry${isYou ? " leaderboard-entry-you" : ""}`}
                  >
                    <span className="leaderboard-name">
                      <img
                        className="leaderboard-medal"
                        src={`/assets/ui/${entry.rank}.png`}
                        alt={`Rank ${entry.rank}`}
                      />
                      <span className="leaderboard-name-text">
                        {isYou ? "You" : entry.displayName}
                      </span>
                    </span>
                    <span>{entry.dailyScore.toLocaleString()}</span>
                  </div>
                );
              })}
              {leaderboardEntries[3] && (
                <div
                  className={`leaderboard-entry${playerRank === 4 ? " leaderboard-entry-you" : ""}`}
                >
                  <span className="leaderboard-name">
                    <span className="leaderboard-rank-num">4.</span>
                    <span className="leaderboard-name-text">
                      {playerRank === 4
                        ? "You"
                        : leaderboardEntries[3].displayName}
                    </span>
                  </span>
                  <span>
                    {leaderboardEntries[3].dailyScore.toLocaleString()}
                  </span>
                </div>
              )}
              {(playerRank === null || playerRank > 4) && (
                <div className="leaderboard-entry leaderboard-entry-you">
                  <span className="leaderboard-name">
                    <span className="leaderboard-rank-num">
                      {playerRank ? `${playerRank}.` : "—"}
                    </span>
                    <span className="leaderboard-name-text">You</span>
                  </span>
                  <span>
                    {playerRank
                      ? (leaderboardEntries
                          .find((e) => e.rank === playerRank)
                          ?.dailyScore.toLocaleString() ?? "—")
                      : "—"}
                  </span>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </aside>
  );
}
