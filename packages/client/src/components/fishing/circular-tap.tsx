import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import type { TapResult, CircularProfile, RotationPattern } from "@hooked/shared";

interface CircularTapProps {
  targets: number[];
  arcSize: number;
  tapsRequired: number;
  missesAllowed: number;
  speedMultiplier: number;
  onResult: (tapResults: TapResult[]) => void;
  // When present, overrides legacy arcSize/tapsRequired/missesAllowed/speedMultiplier.
  profile?: CircularProfile;
  seed?: number;
  onTensionChange?: (tension: number) => void;
}

const RING_RADIUS = 90;
const RING_CX = 110;
const RING_CY = 110;
const SVG_SIZE = 220;
const BASE_ORBIT_MS = 1200;
const AUTO_MISS_REVOLUTIONS = 2.0;
const PHASE_ESCALATION_STEP = 0.08;

function polarToCart(angle: number, r: number) {
  return {
    x: RING_CX + r * Math.cos(angle - Math.PI / 2),
    y: RING_CY + r * Math.sin(angle - Math.PI / 2),
  };
}

function describeArc(startAngle: number, arcFraction: number): string {
  const endAngle = startAngle + arcFraction * 2 * Math.PI;
  const start = polarToCart(startAngle, RING_RADIUS);
  const end = polarToCart(endAngle, RING_RADIUS);
  const largeArc = arcFraction > 0.5 ? 1 : 0;
  return `M ${start.x} ${start.y} A ${RING_RADIUS} ${RING_RADIUS} 0 ${largeArc} 1 ${end.x} ${end.y}`;
}

function shortestAngularDistance(a: number, b: number): number {
  const diff = Math.abs(a - b) % (2 * Math.PI);
  return diff > Math.PI ? 2 * Math.PI - diff : diff;
}

// All patterns average the same net speed — difficulty comes from
// predictability, not raw pace.
function angleForPattern(
  pattern: RotationPattern,
  speedRadPerSec: number,
  elapsedMs: number,
  tapIndex: number,
): number {
  const t = elapsedMs / 1000;
  switch (pattern) {
    case "linear":
      return (speedRadPerSec * t) % (2 * Math.PI);
    case "reversing": {
      // Flip direction every tap, with a small per-tap angular offset so the
      // first frame of a new tap isn't always at 0.
      const dir = tapIndex % 2 === 0 ? 1 : -1;
      const raw = dir * speedRadPerSec * t + tapIndex * 0.7;
      const mod = raw % (2 * Math.PI);
      return mod < 0 ? mod + 2 * Math.PI : mod;
    }
    case "burst": {
      // Integral of (1 + sin(2πt/period)) = t - (period/2π)·cos(2πt/period)+const
      const period = 0.6;
      const k = (2 * Math.PI) / period;
      const integral = t - Math.cos(k * t) / k + 1 / k;
      const raw = speedRadPerSec * integral;
      return raw % (2 * Math.PI);
    }
  }
}

export function CircularTap({
  targets,
  arcSize,
  tapsRequired,
  missesAllowed,
  speedMultiplier,
  onResult,
  profile,
  onTensionChange,
}: CircularTapProps) {
  const [escalationStep, setEscalationStep] = useState(0);

  const effective = useMemo(() => {
    if (profile) {
      const escFactor = profile.phaseEscalation
        ? 1 + escalationStep * PHASE_ESCALATION_STEP
        : 1;
      const shrinkFactor = profile.phaseEscalation
        ? Math.max(0.5, 1 - escalationStep * PHASE_ESCALATION_STEP)
        : 1;
      const speedRadPerSec = profile.indicatorSpeed * escFactor;
      return {
        speedRadPerSec,
        arcSize: Math.max(0.05, profile.arcSize * shrinkFactor),
        tapsRequired: profile.tapsRequired,
        missesAllowed: profile.missesAllowed,
        timingWindowMs: profile.timingWindowMs,
        rotationPattern: profile.rotationPattern,
        tensionPerMiss: profile.tensionPerMiss,
        recoveryPerHit: profile.recoveryPerHit,
        missPenalty: profile.missPenalty,
        autoMissMs:
          (AUTO_MISS_REVOLUTIONS * 2 * Math.PI) / speedRadPerSec * 1000,
      };
    }
    const orbitMs = BASE_ORBIT_MS / speedMultiplier;
    const speedRadPerSec = (2 * Math.PI) / (orbitMs / 1000);
    return {
      speedRadPerSec,
      arcSize,
      tapsRequired,
      missesAllowed,
      timingWindowMs: 0,
      rotationPattern: "linear" as RotationPattern,
      tensionPerMiss: 0,
      recoveryPerHit: 0,
      missPenalty: 0,
      autoMissMs: orbitMs * AUTO_MISS_REVOLUTIONS,
    };
  }, [profile, arcSize, tapsRequired, missesAllowed, speedMultiplier, escalationStep]);

  const [currentTap, setCurrentTap] = useState(0);
  const [misses, setMisses] = useState(0);
  const [indicatorAngle, setIndicatorAngle] = useState(0);
  const [results, setResults] = useState<TapResult[]>([]);
  const [feedback, setFeedback] = useState<"hit" | "miss" | null>(null);
  const [done, setDone] = useState(false);
  const [tension, setTension] = useState(0);

  const tapStartTime = useRef(0);
  const indicatorAngleRef = useRef(0);
  const rafId = useRef(0);
  const handleTapRef = useRef<(autoMiss?: boolean) => void>(() => {});

  useEffect(() => {
    if (done) return;
    tapStartTime.current = performance.now();

    const animate = (now: number) => {
      const elapsed = now - tapStartTime.current;
      const a = angleForPattern(
        effective.rotationPattern,
        effective.speedRadPerSec,
        elapsed,
        currentTap,
      );
      indicatorAngleRef.current = a;
      setIndicatorAngle(a);

      if (elapsed >= effective.autoMissMs) {
        handleTapRef.current(true);
        return;
      }
      rafId.current = requestAnimationFrame(animate);
    };

    rafId.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(rafId.current);
  }, [currentTap, done, effective.rotationPattern, effective.speedRadPerSec, effective.autoMissMs]);

  useEffect(() => {
    onTensionChange?.(tension);
  }, [tension, onTensionChange]);

  const handleTap = useCallback(
    (autoMiss = false) => {
      if (done) return;
      cancelAnimationFrame(rafId.current);

      const target = targets[currentTap];
      const arcHalf = effective.arcSize * Math.PI;
      const timingSlack =
        (effective.timingWindowMs / 1000) * effective.speedRadPerSec * 0.5;
      const effectiveArcHalf = arcHalf + timingSlack;

      const angularDist = shortestAngularDistance(indicatorAngleRef.current, target);
      const isHit = !autoMiss && angularDist <= effectiveArcHalf;
      // Per-tap-local elapsed time at the moment of tap. The server replay
      // (`validateCircularTapTaps`) needs this to recompute the indicator
      // angle and decide the hit independently — without it, server-side
      // resolution is impossible. -1 marks the auto-miss path so the server
      // short-circuits to `reason: "auto_miss"` rather than potentially
      // computing the indicator at an exact-revolution boundary and falsely
      // crediting a hit (the renderer triggers autoMiss precisely when the
      // indicator has completed AUTO_MISS_REVOLUTIONS full turns, which for
      // linear patterns wraps back to angle 0 — and target[0] is at 0 too
      // for castCount=0).
      const msSinceTapStart = autoMiss
        ? -1
        : performance.now() - tapStartTime.current;

      const tapResult: TapResult = {
        targetAngle: target,
        tapAngle: autoMiss ? -1 : indicatorAngleRef.current,
        hit: isHit,
        msSinceTapStart,
      };
      const newResults = [...results, tapResult];
      setResults(newResults);

      setFeedback(isHit ? "hit" : "miss");
      window.setTimeout(() => setFeedback(null), 300);

      setTension((t) =>
        Math.max(
          0,
          Math.min(
            1,
            isHit
              ? t - effective.recoveryPerHit
              : t + effective.tensionPerMiss + effective.missPenalty,
          ),
        ),
      );

      if (isHit && profile?.phaseEscalation) {
        setEscalationStep((s) => s + 1);
      }

      const newMisses = isHit ? misses : misses + 1;
      if (!isHit) setMisses(newMisses);

      const nextTap = currentTap + 1;
      if (newMisses > effective.missesAllowed) {
        setDone(true);
        onResult(newResults);
        return;
      }
      if (nextTap >= effective.tapsRequired) {
        setDone(true);
        onResult(newResults);
        return;
      }
      window.setTimeout(() => {
        setCurrentTap(nextTap);
        tapStartTime.current = performance.now();
      }, 350);
    },
    [done, currentTap, targets, effective, results, misses, onResult, profile],
  );

  useEffect(() => { handleTapRef.current = handleTap; }, [handleTap]);

  const handlePointerDown = useCallback(() => handleTap(false), [handleTap]);

  useEffect(() => {
    if (done) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.repeat) return;
      e.preventDefault();
      handleTap(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [done, handleTap]);

  const targetAngle = targets[currentTap] ?? 0;
  const arcStartAngle = targetAngle - effective.arcSize * Math.PI;
  const indicatorPos = polarToCart(indicatorAngle, RING_RADIUS);

  const feedbackClass =
    feedback === "hit"
      ? "circular-tap-feedback-hit"
      : feedback === "miss"
      ? "circular-tap-feedback-miss"
      : "";

  return (
    <div className="circular-tap-tap-zone" onPointerDown={handlePointerDown}>
    <div className={`circular-tap-container ${feedbackClass}`}>
      <svg
        width={SVG_SIZE}
        height={SVG_SIZE}
        viewBox={`0 0 ${SVG_SIZE} ${SVG_SIZE}`}
        className="circular-tap-svg"
      >
        <circle
          cx={RING_CX}
          cy={RING_CY}
          r={RING_RADIUS + 6}
          fill="none"
          stroke="rgba(76, 175, 80, 0.12)"
          strokeWidth={20}
        />
        <circle
          cx={RING_CX}
          cy={RING_CY}
          r={RING_RADIUS}
          fill="none"
          stroke="rgba(255,255,255,0.12)"
          strokeWidth={12}
        />
        <path
          d={describeArc(arcStartAngle, effective.arcSize)}
          fill="none"
          stroke={feedback === "hit" ? "#66ff88" : feedback === "miss" ? "#ff4444" : "#4caf50"}
          strokeWidth={16}
          strokeLinecap="round"
          opacity={feedback ? 1 : 0.8}
          className="circular-tap-arc"
        />
        <circle
          cx={indicatorPos.x}
          cy={indicatorPos.y}
          r={10}
          fill={feedback === "miss" ? "#ff4444" : "#ff6644"}
          className="circular-tap-indicator"
        />
        <circle
          cx={indicatorPos.x}
          cy={indicatorPos.y}
          r={16}
          fill="none"
          stroke="rgba(255, 100, 68, 0.3)"
          strokeWidth={3}
        />
      </svg>
      <div className="circular-tap-hint">TAP ANYWHERE!</div>
    </div>
    </div>
  );
}
