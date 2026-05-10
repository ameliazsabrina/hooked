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
// Bar is NOT lerped — purely local prediction from heldRef. Fish is NOT
// lerped client-side either — server pushes a SMOOTHED `fishYDisplay`
// (smoothed by FISH_DISPLAY_SMOOTHING_PER_SEC in @hooked/shared) and we
// adopt it directly so the in-bar predicate matches between client and
// server bit-for-bit.
// Server progress threshold above which the visual is allowed to display
// 1.0. Must match the server's CLIENT_FINAL_FLOOR so the catch fires when
// the visual fills.
const NEAR_WIN_THRESHOLD = 0.65;
// Threshold at which we consider local progress "visibly full" and fire
// onResolve. Slightly under 1.0 because the cap pins local at exactly the
// allowed value (0.99 most of the time, 1.0 when server >= NEAR_WIN); the
// >= 0.95 trigger covers both cases without waiting on a fractional
// floating-point rounding.
const LOCAL_FULL_TRIGGER = 0.95;
// Retry interval for the client-final signal while local progress is
// "visibly full". Server may ignore the first attempt if its own progress
// hasn't reached CLIENT_FINAL_FLOOR yet; subsequent retries will land once
// server catches up. catch_resolved unmounts this component, so the retry
// loop stops automatically the moment the server agrees.
const RESOLVE_RETRY_MS = 250;
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
  const lastHapticSecondRef = useRef<number | null>(null);
  const resolvedRef = useRef(false);
  // Last RAF-time at which we fired the resolve callback. Used to throttle
  // the retry loop so we don't spam `final` input_samples at 60Hz when the
  // server takes time to reach CLIENT_FINAL_FLOOR.
  const lastResolveSentAtRef = useRef(0);
  const [, force] = useState(0);

  // Lag-comp state. Origin = wallclock ms when the player FIRST holds; same
  // anchor the server picks (the WS hook's `t_ms` of the first held=true
  // input_sample is captured in the same React event handler as our local
  // setHeld below, so origins coincide within μs). Until origin is set the
  // RAF loop renders only — physics is paused, mirroring the server.
  const inputHistoryRef = useRef<TimedInput[]>([]);
  const clientOriginMsRef = useRef<number | null>(null);
  const simTimeSRef = useRef(0);
  const inputCursorRef = useRef(-1);

  // The client now runs the FULL physics tick locally (`stepAll`) using the
  // shared RNG seed. Because lag-comp aligns the input timeline and the
  // smoothing constant is precomputed, both sides produce bit-equal fish +
  // bar + progress trajectories — so we render fishY at 60Hz from local
  // computation, not from 20Hz server snapshots that aliased into visible
  // jitter. Server progress is kept as a soft cap (NEAR_WIN_THRESHOLD) and
  // server fishY is logged when it drifts noticeably so we'd notice any
  // determinism regression early.
  const serverProgressRef = useRef<number | null>(null);
  useEffect(() => {
    if (!serverState) return;
    serverProgressRef.current = serverState.progress;
    const drift = Math.abs(stateRef.current.fishY - serverState.fishY);
    if (drift > 30) {
      console.warn(
        `[timing-bar] fishY drift=${drift.toFixed(1)} ` +
          `local=${stateRef.current.fishY.toFixed(1)} ` +
          `server=${serverState.fishY.toFixed(1)} — ` +
          `RNG/step alignment may have regressed`,
      );
    }
  }, [serverState]);

  useEffect(() => {
    const tick = (now: number) => {
      // Step physics up to (wallNow - origin)/1000 - INPUT_DELAY_S using
      // the input that was active at each step's simTime. Identical mapping
      // to the server's advancePhysics — same fixed dt, same input history,
      // same default-false pre-origin — so the bar trajectory is a pure
      // function of the input timeline shared by both sides.
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

      // Asymmetric clamp on local progress:
      //   - Local can LAG server freely (positive surprise — you catch
      //     something that looked like a miss).
      //   - Local can fill all the way to 0.99 regardless of server, so
      //     the player gets full responsive feedback (visual nearly
      //     full when their input has done the work).
      //   - Local can only reach 1.0 once server is at NEAR_WIN_THRESHOLD.
      //     This prevents the "bar full, no catch fires" case while
      //     leaving the rest of the bar fully responsive to input.
      const serverP = serverProgressRef.current;
      if (serverP !== null) {
        const cap = serverP >= NEAR_WIN_THRESHOLD ? 1.0 : 0.99;
        if (stateRef.current.progress > cap) {
          stateRef.current.progress = cap;
        }
      }

      // Local progress is visibly full — fire the resolve callback. The hook
      // sends a `final` input_samples; server force-catches if its own
      // progress is past CLIENT_FINAL_FLOOR (0.65), otherwise ignores. We
      // RETRY every RESOLVE_RETRY_MS while local is full so that if the
      // first attempt arrives before server has caught up, subsequent
      // attempts will land once server crosses the floor. catch_resolved
      // (handled in the WS hook) unmounts this component, so retries stop
      // automatically the moment the server agrees.
      if (stateRef.current.progress >= LOCAL_FULL_TRIGGER) {
        if (now - lastResolveSentAtRef.current >= RESOLVE_RETRY_MS) {
          lastResolveSentAtRef.current = now;
          resolvedRef.current = true;
          // Diagnostic so we can compare local vs server progress at the
          // moment the resolve fires. Drop after debugging.
          console.warn(
            `[timing-bar] FIRE onResolve: localProgress=${stateRef.current.progress.toFixed(3)} ` +
              `localBarY=${stateRef.current.barY.toFixed(0)} ` +
              `localFishY=${stateRef.current.fishY.toFixed(0)} ` +
              `serverProgress=${(serverProgressRef.current ?? -1).toFixed(3)} ` +
              `held=${heldRef.current}`,
          );
          onResolve?.("caught");
        }
      } else {
        // Drained back below threshold — reset the retry clock so the next
        // re-fill triggers a fresh attempt.
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
    // Record the input into the local lag-comp history. Origin is set on
    // the first held=true (mirrors the server) so origins coincide.
    if (clientOriginMsRef.current === null) {
      if (!held) {
        onHoldChange(held);
        return;
      }
      clientOriginMsRef.current = Date.now();
    }
    const simTimeS = (Date.now() - clientOriginMsRef.current) / 1000;
    inputHistoryRef.current.push({ simTimeS, held });
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
  // setHeld is recreated on every render but referentially stable in
  // behavior (closes over refs). Re-binding is harmless and avoids a stale
  // closure if the parent ever swaps onHoldChange.
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
