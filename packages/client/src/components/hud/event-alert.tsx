import { useEffect, useState } from "react";

export interface EventStatusApexFish {
  id: string;
  name: string;
  weightMinKg: number;
  weightMaxKg: number;
  /** Public asset URL (admin-uploaded image, served by the API). */
  assetUrl: string;
}

export interface EventStatus {
  active: boolean;
  /** Admin-set display name (e.g. "Colosseum"). Empty when inactive. */
  name: string;
  startsAt: number;
  endsAt: number;
  apexBp: number;
  /**
   * Apex fish the cast roll picks from when Apex rolls during this event.
   * Carries id + name + weight range + assetUrl so HUDs and announcement
   * modals can render thumbnails without a second round-trip.
   */
  apexFishes: EventStatusApexFish[];
}

function formatCountdown(secondsLeft: number): string {
  if (secondsLeft <= 0) return "ending";
  const h = Math.floor(secondsLeft / 3600);
  const m = Math.floor((secondsLeft % 3600) / 60);
  const s = Math.floor(secondsLeft % 60);
  if (h > 0) return `${h}h ${m.toString().padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${s.toString().padStart(2, "0")}s`;
  return `${s}s`;
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

  // Fall back to a generic label if the admin somehow saved an empty name —
  // schema enforces minlength: 1 so this is defensive.
  const name = status.name || "Event";

  return (
    <div className="hud-event-alert" role="status" aria-live="polite">
      <span className="hud-event-alert-label">{name} live</span>
      <span className="hud-event-alert-countdown">
        {formatCountdown(secondsLeft)}
      </span>
    </div>
  );
}
