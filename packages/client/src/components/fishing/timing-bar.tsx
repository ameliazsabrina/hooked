import { useEffect, useMemo, useRef, useState } from "react";
import {
  BAR_MAX_Y,
  BAR_MIN_Y,
  initialFishingGameState,
  isFishInGreenBar,
  resolveGreenBarHeight,
  stepAll,
  terminalState,
  type FishSpecies,
  type FishingGameState,
  type VerticalProfile,
} from "@hooked/shared";
import { vibrate } from "~/utils/haptics";

interface TimingBarProps {
  profile: VerticalProfile;
  seed?: number;
  rodTier?: number;
  baitSlug?: string;
  species?: FishSpecies | null;
  castStartedAtMs?: number | null;
  onHoldChange: (held: boolean) => void;
  // Fires once when client prediction hits terminal state; lets server trust
  // the client-predicted verdict and bridges physics drift.
  onResolve?: (outcome: "caught" | "escaped") => void;
  // Currently ignored on the visual layer — client owns deterministic
  // prediction so the bar/fish never snap mid-cast. Kept for future
  // soft-reconciliation.
  serverState?: {
    barY: number;
    fishY: number;
    progress: number;
  } | null;
}

const FIXED_DT = 1 / 60;
const MAX_STEP_ACCUM = 0.1;
// Mirrors server `SAFETY_TIMEOUT_MS` in ws/gateway.ts — cast is force-resolved
// as escaped once this elapses.
const CAST_TIMEOUT_S = 30;
const CRITICAL_S = 3;
const JITTER_S = 5;

export function TimingBar({
  profile,
  seed = 1,
  rodTier = 0,
  baitSlug = "fly",
  species,
  castStartedAtMs = null,
  onHoldChange,
  onResolve,
  serverState: _serverState,
}: TimingBarProps) {
  const greenBarHeight = useMemo(
    () => resolveGreenBarHeight(profile, rodTier),
    [profile, rodTier],
  );

  const stateRef = useRef<FishingGameState>(
    initialFishingGameState({
      sessionId: "local",
      verticalProfile: profile,
      greenBarHeight,
      rodTier,
      luckyLureTier: 0,
      baitSlug,
      rngSeed: (seed || 1) >>> 0,
      startingBarY: BAR_MAX_Y * 0.9,
      startingFishY: BAR_MAX_Y * 0.85,
      chestSpawned: false,
      chestY: 0,
      startedAt: Date.now(),
    }),
  );

  const heldRef = useRef(false);
  const rafRef = useRef(0);
  const accumRef = useRef(0);
  const lastFrameRef = useRef(0);
  const lastHapticSecondRef = useRef<number | null>(null);
  const resolvedRef = useRef(false);
  const [, force] = useState(0);

  useEffect(() => {
    const tick = (now: number) => {
      if (!lastFrameRef.current) lastFrameRef.current = now;
      const raw = (now - lastFrameRef.current) / 1000;
      lastFrameRef.current = now;
      accumRef.current = Math.min(accumRef.current + raw, MAX_STEP_ACCUM);
      while (accumRef.current >= FIXED_DT) {
        stepAll(
          stateRef.current,
          profile,
          greenBarHeight,
          heldRef.current,
          FIXED_DT,
        );
        accumRef.current -= FIXED_DT;
      }
      if (!resolvedRef.current) {
        const outcome = terminalState(stateRef.current, greenBarHeight);
        if (outcome !== null) {
          resolvedRef.current = true;
          onResolve?.(outcome);
        }
      }
      force((n) => (n + 1) % 1_000_000);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [profile, greenBarHeight, onResolve]);

  const setHeld = (held: boolean) => {
    if (heldRef.current === held) return;
    heldRef.current = held;
    onHoldChange(held);
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setHeld(true);
  };
  const handlePointerUp = () => setHeld(false);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.repeat) return;
      e.preventDefault();
      heldRef.current = true;
      onHoldChange(true);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      e.preventDefault();
      heldRef.current = false;
      onHoldChange(false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [onHoldChange]);

  const st = stateRef.current;
  const span = BAR_MAX_Y - BAR_MIN_Y;
  const greenTopPct = ((st.barY - greenBarHeight / 2) / span) * 100;
  const greenHeightPct = (greenBarHeight / span) * 100;
  const fishPct = (st.fishY / span) * 100;
  const progressPct = Math.max(0, Math.min(1, st.progress)) * 100;
  const inBar = isFishInGreenBar(st.barY, st.fishY, greenBarHeight);
  const progressColor =
    st.progress > 0.66 ? "#6ad36a" : st.progress > 0.33 ? "#f2c94c" : "#ff5c5c";
  const elapsedSinceCastS =
    castStartedAtMs !== null
      ? Math.max(0, (Date.now() - castStartedAtMs) / 1000)
      : st.totalTime;
  const remainingS = Math.max(0, CAST_TIMEOUT_S - elapsedSinceCastS);
  const countdownNum = Math.max(0, Math.ceil(remainingS));
  const timerIsCritical = countdownNum <= CRITICAL_S;
  const timerIsJittering = remainingS < JITTER_S;

  useEffect(() => {
    if (resolvedRef.current || !timerIsJittering || countdownNum <= 0) {
      lastHapticSecondRef.current = null;
      return;
    }
    if (lastHapticSecondRef.current === countdownNum) return;
    lastHapticSecondRef.current = countdownNum;
    vibrate(timerIsCritical ? [30, 35, 45] : 25);
  }, [countdownNum, timerIsCritical, timerIsJittering]);

  return (
    <div
      className="stardew-tap-zone"
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onPointerLeave={handlePointerUp}
    >
      <div className={`stardew-container${inBar ? " is-tracking" : ""}`}>
        <div className="stardew-hint">
          {inBar ? "TRACKING!" : heldRef.current ? "HOLD" : "TAP & HOLD"}
        </div>
        <div
          className={`stardew-phase-timer${timerIsJittering ? " is-jittering" : ""}${timerIsCritical ? " is-critical" : ""}${resolvedRef.current ? " is-hidden" : ""}`}
          aria-live={timerIsCritical ? "assertive" : "polite"}
          aria-hidden={resolvedRef.current}
        >
          <span className="stardew-phase-timer-label">TIME</span>
          <span className="stardew-phase-timer-value" key={countdownNum}>
            {countdownNum}s
          </span>
        </div>

        <div className="stardew-playfield">
          <div className="stardew-bar-track">
            <div
              className={`stardew-green-bar${inBar ? " is-tracking" : ""}`}
              style={{
                top: `${greenTopPct}%`,
                height: `${greenHeightPct}%`,
              }}
            />
            <div
              className={`stardew-fish${inBar ? " is-tracking" : ""}`}
              style={{ top: `${fishPct}%` }}
            >
              {species ? (
                <img
                  src={`/assets/Fish/${species.asset}`}
                  alt={species.name}
                  draggable={false}
                  style={{ filter: "brightness(0)" }}
                />
              ) : (
                <div className="stardew-fish-dot" />
              )}
            </div>
          </div>

          <div className="stardew-progress-track">
            <div
              className="stardew-progress-fill"
              style={{
                height: `${progressPct}%`,
                background: progressColor,
                boxShadow: `0 0 16px ${progressColor}`,
              }}
            />
            <div
              className="stardew-progress-marker"
              style={{ bottom: `${progressPct}%` }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
