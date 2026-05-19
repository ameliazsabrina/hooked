import { useEffect, useState } from "react";

function msUntilNextReset(now: Date): number {
  // Server refills at UTC 02:00 / 14:00 (sessionLifecycle cron).
  const next = new Date(now);
  const hour = now.getUTCHours();
  if (hour < 2) {
    next.setUTCHours(2, 0, 0, 0);
  } else if (hour < 14) {
    next.setUTCHours(14, 0, 0, 0);
  } else {
    next.setUTCDate(next.getUTCDate() + 1);
    next.setUTCHours(2, 0, 0, 0);
  }
  return next.getTime() - now.getTime();
}

function formatRemaining(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function BaitTimer() {
  const [remaining, setRemaining] = useState(() => msUntilNextReset(new Date()));

  useEffect(() => {
    const id = window.setInterval(() => {
      setRemaining(msUntilNextReset(new Date()));
    }, 1000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div className="bait-timer">
      <div className="bait-timer-label">Bait refills in</div>
      <div className="bait-timer-value">{formatRemaining(remaining)}</div>
    </div>
  );
}
