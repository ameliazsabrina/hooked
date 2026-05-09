import { useEffect } from "react";
import type { DifficultyProfile } from "@hooked/shared";

interface DifficultyFeedbackProps {
  profile: DifficultyProfile;
  tension: number;
  target?: HTMLElement | null;
}

export function DifficultyFeedback({ profile, tension, target }: DifficultyFeedbackProps) {
  useEffect(() => {
    const el = target ?? document.documentElement;
    const tierFactor = profile.kind === "circular" && profile.phaseEscalation ? 1.4 : 1.0;
    el.style.setProperty("--shake-amp", `${(tension * tierFactor * 6).toFixed(2)}px`);
    el.style.setProperty("--anim-speed", (1 + tension * 0.6).toFixed(2));
    el.style.setProperty("--danger-mix", tension.toFixed(2));
    return () => {
      el.style.removeProperty("--shake-amp");
      el.style.removeProperty("--anim-speed");
      el.style.removeProperty("--danger-mix");
    };
  }, [profile, tension, target]);

  return null;
}
