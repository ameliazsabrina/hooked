import { useEffect } from "react";
import { RARITY_COLORS, type FishRarity } from "@hooked/shared";
import type { CaughtFish } from "~/hooks/use-fishing-ws";

interface CatchPopupProps {
  fish: CaughtFish;
  onDismiss: () => void;
}

export function CatchPopup({ fish, onDismiss }: CatchPopupProps) {
  const rarityColor = RARITY_COLORS[fish.rarity];
  const rarityLabel = fish.rarity.charAt(0).toUpperCase() + fish.rarity.slice(1);

  useEffect(() => {
    const delays: Record<FishRarity, number> = {
      basic: 2000,
      rare: 2500,
      monster: 3000,
      legendary: 3500,
      apex: 4000,
    };
    const timer = setTimeout(onDismiss, delays[fish.rarity] ?? 2500);
    return () => clearTimeout(timer);
  }, [fish.rarity, onDismiss]);

  return (
    <div className="catch-popup-overlay" onClick={onDismiss}>
      <div
        className="catch-popup"
        style={{ borderColor: rarityColor }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="catch-popup-rarity-badge"
          style={{ background: rarityColor }}
        >
          {rarityLabel}
        </div>

        <div className="catch-popup-image-wrap">
          <img
            src={`/assets/Fish/${fish.asset}`}
            alt={fish.species}
            className="catch-popup-image"
          />
        </div>

        <div className="catch-popup-name">{fish.species}</div>

        <div className="catch-popup-stats">
          <span>{fish.weightKg} kg</span>
          <span className="catch-popup-score">+{fish.score} pts</span>
        </div>

        <button className="catch-popup-dismiss" onClick={onDismiss}>
          Continue
        </button>
      </div>
    </div>
  );
}

interface MissPopupProps {
  onDismiss: () => void;
}

export function MissPopup({ onDismiss }: MissPopupProps) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, 1500);
    return () => clearTimeout(timer);
  }, [onDismiss]);

  return (
    <div className="catch-popup-overlay miss-overlay" onClick={onDismiss}>
      <div className="miss-popup">
        <div className="miss-text">It got away!</div>
      </div>
    </div>
  );
}
