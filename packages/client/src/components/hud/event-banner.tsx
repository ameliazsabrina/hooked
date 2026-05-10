import { useEffect, useRef, useState } from "react";
import type { EventStatus } from "~/components/hud/event-alert";

const AUTO_DISMISS_MS = 6_000;
const MAX_FISH_THUMBS = 6;

function formatCountdown(secondsLeft: number): string {
  if (secondsLeft <= 0) return "ending";
  const h = Math.floor(secondsLeft / 3600);
  const m = Math.floor((secondsLeft % 3600) / 60);
  const s = Math.floor(secondsLeft % 60);
  if (h > 0) return `${h}h ${m.toString().padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${s.toString().padStart(2, "0")}s`;
  return `${s}s`;
}

function formatPrizeSol(sol: number): string {
  if (!Number.isFinite(sol) || sol <= 0) return "0";
  if (sol >= 100) return sol.toFixed(0);
  if (sol >= 10) return sol.toFixed(1).replace(/\.0$/, "");
  return sol.toFixed(2).replace(/\.?0+$/, "");
}

interface EventBannerProps {
  status: EventStatus | null;
}

export function EventBanner({ status }: EventBannerProps) {
  const [visible, setVisible] = useState(false);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const seenIdRef = useRef<string | null>(null);
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!status?.active) {
      seenIdRef.current = null;
      setVisible(false);
      return;
    }
    const id = `${status.name}|${status.endsAt}`;
    if (seenIdRef.current === id) return;
    seenIdRef.current = id;
    setVisible(true);
    if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
    dismissTimerRef.current = setTimeout(
      () => setVisible(false),
      AUTO_DISMISS_MS,
    );
    return () => {
      if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
    };
  }, [status?.active, status?.name, status?.endsAt]);

  useEffect(() => {
    if (!visible) return;
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, [visible]);

  if (!visible || !status?.active) return null;
  const secondsLeft = status.endsAt - now;
  if (secondsLeft <= 0) return null;

  const fishes = status.apexFishes.slice(0, MAX_FISH_THUMBS);
  const hasPrize = status.prizePoolSol > 0;
  const prizeText = formatPrizeSol(status.prizePoolSol);

  return (
    <div
      className="hud-event-banner"
      role="status"
      aria-live="polite"
      aria-label={`${status.name} event live`}
    >
      <button
        type="button"
        className="hud-event-banner-dismiss"
        onClick={() => setVisible(false)}
        aria-label="Dismiss event banner"
      >
        ×
      </button>
      <div className="hud-event-banner-tag">LIVE NOW</div>
      <div className="hud-event-banner-name">{status.name || "Event"}</div>
      <p className="hud-event-banner-blurb">
        Apex fish are biting across the seas. Reel one in before the bell to
        climb the leaderboard and claim a share of the prize pool.
      </p>
      <div className="hud-event-banner-countdown">
        ends in {formatCountdown(secondsLeft)}
      </div>
      {hasPrize && (
        <div
          className="hud-event-banner-pool"
          aria-label={`${prizeText} SOL prize pool`}
        >
          <span className="hud-event-banner-pool-label">Prize pool</span>
          <span className="hud-event-banner-pool-amount">
            {prizeText}
            <span className="hud-event-banner-pool-unit">SOL</span>
          </span>
        </div>
      )}
      {fishes.length > 0 && (
        <div className="hud-event-banner-prize">
          <div className="hud-event-banner-prize-label">Hunt them!</div>
          <div className="hud-event-banner-fishes">
            {fishes.map((f) => (
              <div key={f.id} className="hud-event-banner-fish" title={f.name}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={f.assetUrl}
                  alt={f.name}
                  className="hud-event-banner-fish-img"
                  onError={(e) => {
                    (e.target as HTMLImageElement).style.visibility = "hidden";
                  }}
                />
                <div className="hud-event-banner-fish-name">{f.name}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
