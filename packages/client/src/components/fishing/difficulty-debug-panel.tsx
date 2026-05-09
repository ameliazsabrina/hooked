import { useState } from "react";
import type { DifficultyProfile, FishRarity } from "@hooked/shared";

interface DifficultyDebugPanelProps {
  profile: DifficultyProfile | null;
  seed: number | null;
  onForceRarity?: (rarity: FishRarity) => void;
  onReseed?: () => void;
  onPatchProfile?: (patch: Partial<DifficultyProfile>) => void;
}

export function DifficultyDebugPanel({ profile, seed }: DifficultyDebugPanelProps) {
  const [open, setOpen] = useState(false);
  if (!import.meta.env.DEV) return null;
  return (
    <div className="difficulty-debug-panel" data-open={open}>
      <button type="button" onClick={() => setOpen((v) => !v)}>
        difficulty
      </button>
      {open && (
        <pre style={{ fontSize: 11, maxWidth: 320 }}>
          {JSON.stringify({ seed, profile }, null, 2)}
        </pre>
      )}
    </div>
  );
}
