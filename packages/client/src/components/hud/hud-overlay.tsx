interface HudOverlayProps {
  bait: number;
  baitMax: number;
  score: number;
}

export function HudOverlay({ bait, baitMax, score }: HudOverlayProps) {
  const baitLabel = baitMax > 0 ? `${bait} / ${baitMax}` : `${bait}`;

  return (
    <div className="hud-overlay">
      <div className="hud-item hud-bait">Bait: {baitLabel}</div>
      <div className="hud-item hud-score">Score: {score.toLocaleString()}</div>
    </div>
  );
}
