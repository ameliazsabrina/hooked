import { useEffect } from "react";

interface WarningStateProps {
  rarity: "monster" | "legendary" | "apex";
  onComplete: () => void;
}

const DURATIONS = {
  monster: 600,
  legendary: 800,
  apex: 1500,
};

const LABELS = {
  monster: "A monster!",
  legendary: "Something big!",
  apex: "APEX ENCOUNTER",
};

export function WarningState({ rarity, onComplete }: WarningStateProps) {
  useEffect(() => {
    const timer = setTimeout(onComplete, DURATIONS[rarity]);
    return () => clearTimeout(timer);
  }, [rarity, onComplete]);

  return (
    <div className={`warning-overlay warning-overlay-${rarity}`}>
      <div className={`warning-text warning-text-${rarity}`}>
        {LABELS[rarity]}
      </div>
    </div>
  );
}
