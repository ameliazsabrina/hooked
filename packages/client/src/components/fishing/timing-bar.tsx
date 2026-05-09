import { useEffect, useMemo, useRef, useState } from "react";
import {
  BAR_MAX_Y,
  BAR_MIN_Y,
  PHYSICS_FIXED_DT,
  PHYSICS_MAX_STEP_ACCUM,
  initialFishingGameState,
  isFishInGreenBar,
  resolveGreenBarHeight,
  stepPhysics,
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

// Physics step rate is shared with the server (`PHYSICS_FIXED_DT` /
// `PHYSICS_MAX_STEP_ACCUM` in @hooked/shared). They MUST match: the
// fish-position RNG sequence is consumed once per step, so any rate
// divergence makes the fish swim down different trajectories on the two
// sides and every cast resolves as escaped. Local aliases kept for terseness
// in the existing tick loop.
const FIXED_DT = PHYSICS_FIXED_DT;
const MAX_STEP_ACCUM = PHYSICS_MAX_STEP_ACCUM;
// Exponential rate at which the local-predicted bar position is corrected
// toward the server's authoritative bar position. High because the bar is
// player-driven and the player needs the input to feel responsive — the
// correction is mostly invisible because local prediction matches server
// prediction closely (same heldRef → same stepPhysics).
const BAR_CORRECTION_PER_SEC = 18;
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
  serverState,
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

  // Snapshot interpolation buffer for fish position + progress. The server
  // pushes `fishing_state` ~20Hz; we render at 60Hz, interpolating linearly
  // between the two most recent snapshots with a one-frame display delay.
  // This is much smoother than chasing a moving target with an exponential
  // lerp because (a) we never run local stepFishPosition (so there's no
  // local-vs-server tug-of-war), and (b) the visual fishY/progress are
  // exact intermediate points between known-good server samples.
  const prevSnapRef = useRef<{
    fishY: number;
    progress: number;
    recvAt: number;
  } | null>(null);
  const lastSnapRef = useRef<{
    fishY: number;
    progress: number;
    recvAt: number;
  } | null>(null);
  // Bar (player-controlled): kept locally predicted for input responsiveness.
  // Lerped toward server snapshots much faster than fish to keep the
  // catchable area honest without lagging player input.
  const serverBarTargetRef = useRef<number | null>(null);
  useEffect(() => {
    if (!serverState) return;
    const recvAt =
      typeof performance !== "undefined" ? performance.now() : Date.now();
    prevSnapRef.current = lastSnapRef.current;
    lastSnapRef.current = {
      fishY: serverState.fishY,
      progress: serverState.progress,
      recvAt,
    };
    serverBarTargetRef.current = serverState.barY;
  }, [serverState]);

  useEffect(() => {
    const tick = (now: number) => {
      if (!lastFrameRef.current) lastFrameRef.current = now;
      const raw = (now - lastFrameRef.current) / 1000;
      lastFrameRef.current = now;

      // Bar: local prediction at fixed-dt for input feel. Fish is NOT
      // stepped locally — pure server interpolation below — so the shared
      // RNG state on the client never advances and there's no local-vs-
      // server divergence to fight against.
      accumRef.current = Math.min(accumRef.current + raw, MAX_STEP_ACCUM);
      while (accumRef.current >= FIXED_DT) {
        stepPhysics(stateRef.current, heldRef.current, FIXED_DT);
        accumRef.current -= FIXED_DT;
      }
      // Soft-correct the bar toward server's view — much faster than fish
      // because the player is actively driving it. This bounds local-bar
      // drift without lagging the input feel.
      const barTarget = serverBarTargetRef.current;
      if (barTarget !== null) {
        const k = 1 - Math.exp(-BAR_CORRECTION_PER_SEC * raw);
        stateRef.current.barY += (barTarget - stateRef.current.barY) * k;
      }

      // Fish + progress: snapshot interpolation. With two snapshots, we
      // render at `last.recvAt` (one server frame behind real-time) and
      // linearly interpolate to `this.recvAt` as wall time advances. The
      // 50ms display delay is invisible against typical RAF jitter and
      // gives perfectly smooth fish motion regardless of when snapshots
      // happen to land.
      const last = lastSnapRef.current;
      const prev = prevSnapRef.current;
      if (last && prev) {
        const interval = Math.max(1, last.recvAt - prev.recvAt);
        const elapsed = now - last.recvAt;
        const t = Math.max(0, Math.min(1, elapsed / interval));
        stateRef.current.fishY = prev.fishY + (last.fishY - prev.fishY) * t;
        stateRef.current.progress =
          prev.progress + (last.progress - prev.progress) * t;
      } else if (last) {
        stateRef.current.fishY = last.fishY;
        stateRef.current.progress = last.progress;
      }

      // Don't fire local terminal-resolve — the server is the authority.
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
