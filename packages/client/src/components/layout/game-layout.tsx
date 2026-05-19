import { useState, useRef, useCallback, useEffect } from "react";
import Phaser from "phaser";
import { PhaserGame } from "~/game/phaser-game";
import { LeftSidebar } from "./left-sidebar";
import { RightSidebar } from "./right-sidebar";
import { StatsPanel } from "./stats-panel";
import { ControlsPanel } from "./controls-panel";
import { BottomNav } from "./bottom-nav";
import { SidebarPopup } from "./sidebar-popup";
import { ShopScreen } from "~/components/shop/shop-screen";
import { StorageScreen } from "~/components/storage/storage-screen";
import { HudOverlay } from "~/components/hud/hud-overlay";
import { EventAlert } from "~/components/hud/event-alert";
import { EventBanner } from "~/components/hud/event-banner";
import { EquippedGear } from "~/components/hud/equipped-gear";
import { BaitTimer } from "~/components/hud/bait-timer";
import { TimingBar } from "~/components/fishing/timing-bar";
import { CircularTap } from "~/components/fishing/circular-tap";
import { WarningState } from "~/components/fishing/warning-state";
import { CatchPopup, MissPopup } from "~/components/fishing/catch-popup";
import { TapToHook } from "~/components/fishing/tap-to-hook";
import { useFishingWs } from "~/hooks/use-fishing-ws";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { baitsPerSession } from "@hooked/shared";
import { trpc } from "~/utils/trpc";
import { useSessionAuth } from "~/providers/session-auth-provider";
import {
  setMusicVolume,
  setSfxVolumeScale,
  startAmbientMusic,
  stopAmbientMusic,
} from "~/utils/audio";
import { useSettings } from "~/utils/settings";
import { SettingsButton } from "~/components/settings/settings-button";
import { SettingsModal } from "~/components/settings/settings-modal";

const STREAK_CYCLE = 7;
import "~/components/fishing/fishing.css";
import "./game-layout.css";

interface GameLayoutProps {
  nickname?: string;
  ready?: boolean;
}

function getModeForNow(): "day" | "night" {
  // Mirror sessionLifecycle bait-window boundaries (UTC 02:00 / 14:00).
  const hour = new Date().getUTCHours();
  return hour >= 2 && hour < 14 ? "day" : "night";
}

export function GameLayout({ nickname, ready }: GameLayoutProps) {
  const [popupOpen, setPopupOpen] = useState<
    "bounties" | "leaderboard" | "collections" | null
  >(null);
  const [shopOpen, setShopOpen] = useState(false);
  const [storageOpen, setStorageOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mode, setMode] = useState<"day" | "night">(() => getModeForNow());
  const gameRef = useRef<Phaser.Game | null>(null);
  const [settings] = useSettings();

  const { connected } = useWallet();
  const { ready: authReady } = useSessionAuth();
  const playerQuery = trpc.player.me.useQuery(undefined, {
    enabled: connected && authReady,
  });
  const streak = playerQuery.data?.exists ? playerQuery.data.loginStreak : 0;
  const rodTier = playerQuery.data?.exists
    ? (playerQuery.data.equipment?.rodTier ?? 0)
    : 0;
  const baitSlug = playerQuery.data?.exists
    ? (playerQuery.data.equipment?.baitEquipped ?? "fly")
    : "fly";
  const baitMax =
    playerQuery.data?.exists && playerQuery.data.depositAmount
      ? baitsPerSession(playerQuery.data.depositAmount)
      : 0;
  const dayInCycle = streak > 0 ? ((streak - 1) % STREAK_CYCLE) + 1 : 0;
  const progressPct = (dayInCycle / STREAK_CYCLE) * 100;

  const applyMode = useCallback((next: "day" | "night") => {
    const game = gameRef.current;
    if (!game) return;
    game.registry.set("mode", next);
    game.events.emit("setMode", next);
  }, []);

  const handleGameReady = useCallback(
    (game: Phaser.Game) => {
      gameRef.current = game;
      game.registry.set("mode", mode);
      game.events.emit("setMode", mode);
    },
    [mode],
  );

  useEffect(() => {
    startAmbientMusic(settings.muted ? 0 : settings.musicVolume);
    setSfxVolumeScale(settings.muted ? 0 : settings.sfxVolume);
    return () => stopAmbientMusic();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setMusicVolume(settings.muted ? 0 : settings.musicVolume);
  }, [settings.musicVolume, settings.muted]);

  useEffect(() => {
    setSfxVolumeScale(settings.muted ? 0 : settings.sfxVolume);
  }, [settings.sfxVolume, settings.muted]);

  useEffect(() => {
    document.documentElement.style.setProperty(
      "--hooked-brightness",
      String(settings.brightness),
    );
  }, [settings.brightness]);

  useEffect(() => {
    const tick = () => {
      const next = getModeForNow();
      setMode((prev) => {
        if (prev !== next) applyMode(next);
        return next;
      });
    };
    const id = window.setInterval(tick, 60_000);
    return () => window.clearInterval(id);
  }, [applyMode]);

  const fishing = useFishingWs(gameRef);

  useEffect(() => {
    if (ready && !fishing.sessionId) {
      fishing.startSession("day");
    }
  }, [ready]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (fishing.sessionId && fishing.bait <= 0 && fishing.state === "idle") {
      fishing.endSession();
    }
  }, [fishing.bait, fishing.state, fishing.sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="game-layout">
      <PhaserGame onGameReady={handleGameReady} />

      <div className="mobile-header">
        <div className="mobile-wallet-group">
          <div className="mobile-wallet">
            <WalletMultiButton />
          </div>
          <SettingsButton
            className="mobile-settings-btn"
            onClick={() => setSettingsOpen(true)}
          />
        </div>
        <div className="mobile-streak">
          <span className="mobile-streak-label">
            Day {dayInCycle}/{STREAK_CYCLE}
          </span>
          <div className="mobile-streak-bar">
            <div
              className="mobile-streak-fill"
              style={{ width: `${progressPct}%` }}
            />
            <img
              src="/assets/ui/streak-chest.png"
              alt=""
              className="streak-prize-marker streak-prize-marker--mobile"
              title="Mystery reward on Day 7"
            />
          </div>
        </div>
      </div>

      <div className="main-row">
        <LeftSidebar nickname={nickname} />

        <div className="center-column">
          <div className="game-viewport">
            <HudOverlay
              bait={fishing.bait}
              baitMax={baitMax}
              score={fishing.score}
            />
            <EventAlert status={fishing.eventStatus} />
            {ready && <EventBanner status={fishing.eventStatus} />}
            <BaitTimer />
            <EquippedGear />

            {fishing.state === "nibble_window" && <TapToHook />}

            {fishing.state === "biting" && (
              <div className="bite-indicator">BITE!</div>
            )}

            {fishing.state === "warning" && fishing.fishRarity && (
              <WarningState
                rarity={fishing.fishRarity as "monster" | "legendary" | "apex"}
                onComplete={fishing.advanceFromWarning}
              />
            )}

            {fishing.state === "reeling" &&
              fishing.difficulty?.profile.kind === "vertical" && (
                <TimingBar
                  profile={fishing.difficulty.profile}
                  seed={fishing.difficulty.seed}
                  rodTier={rodTier}
                  baitSlug={baitSlug}
                  species={fishing.species}
                  castStartedAtMs={fishing.castStartedAtMs}
                  onHoldChange={fishing.setHeld}
                  onResolve={fishing.onTimingBarResolve}
                  serverState={fishing.serverSnapshot}
                  reconcileVersion={fishing.reconcileVersion}
                />
              )}

            {fishing.state === "circular_tap" && fishing.circularTapConfig && (
              <CircularTap
                targets={fishing.circularTapConfig.targets}
                arcSize={fishing.circularTapConfig.arcSize}
                tapsRequired={fishing.circularTapConfig.tapsRequired}
                missesAllowed={fishing.circularTapConfig.missesAllowed}
                speedMultiplier={fishing.circularTapConfig.speedMultiplier}
                onResult={fishing.onCircularTapResult}
                profile={
                  fishing.difficulty?.profile.kind === "circular"
                    ? fishing.difficulty.profile
                    : undefined
                }
                seed={fishing.difficulty?.seed}
              />
            )}

            {fishing.state === "caught" && fishing.lastCatch && (
              <CatchPopup
                fish={fishing.lastCatch}
                onDismiss={fishing.dismiss}
              />
            )}

            {fishing.state === "missed" && (
              <MissPopup onDismiss={fishing.dismiss} />
            )}
          </div>

          <div className="cast-row">
            <button
              className="mobile-tab-btn"
              onClick={() => setPopupOpen("bounties")}
              aria-label="Bounties"
            >
              <img src="/assets/ui/mobile-bounties.svg" alt="" />
            </button>

            <button
              className="cast-button"
              onClick={fishing.cast}
              disabled={
                fishing.state !== "idle" ||
                fishing.bait <= 0 ||
                !fishing.sessionId ||
                !fishing.authed
              }
              style={
                fishing.state !== "idle" ||
                fishing.bait <= 0 ||
                !fishing.sessionId ||
                !fishing.authed
                  ? { opacity: 0.5, cursor: "not-allowed" }
                  : undefined
              }
            >
              Cast
            </button>

            <button
              className="mobile-tab-btn"
              onClick={() => setPopupOpen("leaderboard")}
              aria-label="Leaderboard"
            >
              <img src="/assets/ui/mobile-leaderboard.svg" alt="" />
            </button>
          </div>

          <div className="bottom-panels">
            <StatsPanel />
            <ControlsPanel />
          </div>
        </div>

        <RightSidebar
          catches={fishing.catches}
          onSellFish={fishing.sellFish}
          onOpenSettings={() => setSettingsOpen(true)}
          roomLeaderboard={fishing.roomLeaderboard}
        />
      </div>

      <BottomNav
        onOpenShop={() => setShopOpen(true)}
        onOpenCollection={() => setPopupOpen("collections")}
        onOpenStorage={() => setStorageOpen(true)}
      />

      <SidebarPopup
        panel={popupOpen}
        onClose={() => setPopupOpen(null)}
        catches={fishing.catches}
        discoveredSpecies={fishing.discoveredSpecies}
        discoveredApexFish={fishing.discoveredApexFish}
        onSellFish={fishing.sellFish}
        onSellFishBulk={fishing.sellFishBulk}
        eventStatus={fishing.eventStatus}
        roomLeaderboard={fishing.roomLeaderboard}
      />

      {shopOpen && (
        <ShopScreen onClose={() => setShopOpen(false)} ready={ready} />
      )}

      {storageOpen && (
        <StorageScreen
          catches={fishing.catches}
          shellBalance={
            playerQuery.data?.exists ? playerQuery.data.shellBalance : 0
          }
          onSellFishBulk={fishing.sellFishBulk}
          onClose={() => setStorageOpen(false)}
        />
      )}

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />
    </div>
  );
}
