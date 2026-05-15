import { useEffect, useState } from "react";

export interface EventStatusApexFish {
  id: string;
  name: string;
  weightMinKg: number;
  weightMaxKg: number;
  assetUrl: string;
}

export interface EventStatus {
  active: boolean;
  name: string;
  startsAt: number;
  endsAt: number;
  apexBp: number;
  prizePoolSol: number;
  apexFishes: EventStatusApexFish[];
}

function formatCountdown(secondsLeft: number): string {
  if (secondsLeft <= 0) return "ending soon";
  const d = Math.floor(secondsLeft / 86400);
  const h = Math.floor((secondsLeft % 86400) / 3600);
  const m = Math.floor((secondsLeft % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m left`;
  if (h > 0) return `${h}h ${m}m left`;
  if (m > 0) return `${m}m left`;
  return "less than 1m left";
}

interface EventAlertProps {
  status: EventStatus | null;
}

export function EventAlert({ status }: EventAlertProps) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    if (!status?.active) return;
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, [status?.active]);

  if (!status?.active) return null;
  const secondsLeft = status.endsAt - now;
  if (secondsLeft <= 0) return null;

  const name = status.name || "Event";

  return (
    <div className="hud-event-alert" role="status" aria-live="polite">
      <span className="hud-event-alert-label">
        {name} live — catch the apex!
      </span>
      <span className="hud-event-alert-countdown">
        {formatCountdown(secondsLeft)}
      </span>
    </div>
  );
}
