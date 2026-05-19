import { useEffect, useMemo, useRef, useState } from "react";
import {
  BAR_MAX_Y,
  BAR_MIN_Y,
  INPUT_DELAY_S,
  PHYSICS_FIXED_DT,
  PHYSICS_MAX_STEP_ACCUM,
  initialFishingGameState,
  isFishInGreenBar,
  lookupActiveInput,
  resolveGreenBarHeight,
  stepAll,
  type FishSpecies,
  type FishingGameState,
  type TimedInput,
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
  /** Second arg carries the same Date.now() used for local simTimeS so the
   *  hook's sample t_ms matches bit-for-bit. */
  onHoldChange: (held: boolean, tNow?: number) => void;
  /** Fires once when client prediction hits terminal state. */
  onResolve?: (outcome: "caught" | "escaped") => void;
  /** Routine snapshot — only `progress` is used (as a soft cap); bar/fish are
   *  NOT visually snapped to this to avoid jitter. */
  serverState?: {
    barY: number;
    fishY: number;
    progress: number;
  } | null;
  /** Bumped on `desync_correction` only; on change, local state is overwritten
   *  from serverState since server's view is canonical. */
  reconcileVersion?: number;
}

// Physics step rate MUST match server constants in @hooked/shared — the RNG
// sequence is consumed once per step, so any divergence desyncs the fish.
const FIXED_DT = PHYSICS_FIXED_DT;
const MAX_STEP_ACCUM = PHYSICS_MAX_STEP_ACCUM;
// Must match server's CLIENT_FINAL_FLOOR so the catch fires when visual fills.
const NEAR_WIN_THRESHOLD = 0.65;
const LOCAL_FULL_TRIGGER = 0.95;
const RESOLVE_RETRY_MS = 250;
// Mirrors server SAFETY_TIMEOUT_MS — cast force-resolved as escaped after this.
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
  reconcileVersion = 0,
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
  const lastHapticSecondRef = useRef<number | null>(null);
  const resolvedRef = useRef(false);
  const lastResolveSentAtRef = useRef(0);
  const [, force] = useState(0);

  // Lag-comp: origin = wallclock ms of first held=true; server picks the same
  // anchor. Physics paused until origin is set.
  const inputHistoryRef = useRef<TimedInput[]>([]);
  const clientOriginMsRef = useRef<number | null>(null);
  const simTimeSRef = useRef(0);
  const inputCursorRef = useRef(-1);

  // Client runs full physics locally via shared RNG; server progress is kept
  // only as a soft cap to bridge any determinism drift.
  const serverProgressRef = useRef<number | null>(null);
  useEffect(() => {
    if (!serverState) return;
    serverProgressRef.current = serverState.progress;
  }, [serverState]);

  // Desync reconcile: overwrite local state from server snapshot when bumped.
  // RNG isn't reset (mid-cast RNG recovery isn't feasible); goal is to align
  // the catch/escape predicate, not to perfectly resume.
  useEffect(() => {
    if (reconcileVersion === 0) return;
    if (!serverState) return;
    stateRef.current.barY = serverState.barY;
    stateRef.current.fishY = serverState.fishY;
    stateRef.current.fishYDisplay = serverState.fishY;
    stateRef.current.progress = serverState.progress;
    stateRef.current.barVelocity = 0;
    stateRef.current.fishVelocity = 0;
    lastResolveSentAtRef.current = 0;
    // Clear latch so the countdown timer doesn't stay hidden through the snap.
    resolvedRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reconcileVersion]);

  useEffect(() => {
    const tick = (now: number) => {
      // Mirror server's advancePhysics: same fixed dt, same input history,
      // default-false pre-origin.
      const originMs = clientOriginMsRef.current;
      if (originMs !== null) {
        const wallSinceOriginS = (Date.now() - originMs) / 1000;
        const targetSimTimeS = wallSinceOriginS - INPUT_DELAY_S;
        const maxAdvance = simTimeSRef.current + MAX_STEP_ACCUM;
        const stepUpTo = Math.min(targetSimTimeS, maxAdvance);
        while (simTimeSRef.current + FIXED_DT <= stepUpTo) {
          const lookup = lookupActiveInput(
            inputHistoryRef.current,
            simTimeSRef.current,
            inputCursorRef.current,
            false,
          );
          inputCursorRef.current = lookup.cursor;
          stepAll(
            stateRef.current,
            profile,
            greenBarHeight,
            lookup.held,
            FIXED_DT,
          );
          simTimeSRef.current += FIXED_DT;
        }
      }

      // Local fills to 0.99 freely; only crosses 1.0 once server hits the
      // near-win threshold, so visual fullness always coincides with a catch.
      const serverP = serverProgressRef.current;
      if (serverP !== null) {
        const cap = serverP >= NEAR_WIN_THRESHOLD ? 1.0 : 0.99;
        if (stateRef.current.progress > cap) {
          stateRef.current.progress = cap;
        }
      }

      // Retry resolve while visibly full so the server can land it once it
      // crosses CLIENT_FINAL_FLOOR; catch_resolved unmounts and stops retries.
      if (stateRef.current.progress >= LOCAL_FULL_TRIGGER) {
        if (now - lastResolveSentAtRef.current >= RESOLVE_RETRY_MS) {
          lastResolveSentAtRef.current = now;
          resolvedRef.current = true;
          onResolve?.("caught");
        }
      } else {
        lastResolveSentAtRef.current = 0;
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
    // One timestamp drives both local simTimeS and the wire t_ms; separate
    // Date.now() captures can drift by 1ms and desync the input history.
    const tNow = Date.now();
    // Origin set on first held=true so client and server origins coincide.
    if (clientOriginMsRef.current === null) {
      if (!held) {
        onHoldChange(held, tNow);
        return;
      }
      clientOriginMsRef.current = tNow;
    }
    const simTimeS = (tNow - clientOriginMsRef.current) / 1000;
    inputHistoryRef.current.push({ simTimeS, held });
    onHoldChange(held, tNow);
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
      setHeld(true);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      e.preventDefault();
      setHeld(false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
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
