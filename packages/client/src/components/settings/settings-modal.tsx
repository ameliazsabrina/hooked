import type { Settings } from "~/utils/settings";
import { useSettings } from "~/utils/settings";

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
}

export function SettingsModal({ open, onClose }: SettingsModalProps) {
  const [settings, updateSettings] = useSettings();

  if (!open) return null;

  const muted = settings.muted;

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-popup" onClick={(e) => e.stopPropagation()}>
        <div className="settings-popup-title">Settings</div>
        <button
          type="button"
          className="settings-popup-close"
          onClick={onClose}
          aria-label="Close settings"
        >
          ✕
        </button>
        <div className="settings-popup-inner">
          <SettingsSlider
            label="Music"
            value={settings.musicVolume}
            disabled={muted}
            onChange={(v) => updateSettings({ musicVolume: v })}
          />
          <SettingsSlider
            label="Sound"
            value={settings.sfxVolume}
            disabled={muted}
            onChange={(v) => updateSettings({ sfxVolume: v })}
          />
          <SettingsSlider
            label="Brightness"
            value={settings.brightness}
            onChange={(v) => updateSettings({ brightness: v })}
            min={0.3}
          />
        </div>
      </div>
    </div>
  );
}

interface SettingsSliderProps {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  disabled?: boolean;
}

function SettingsSlider({
  label,
  value,
  onChange,
  min = 0,
  disabled = false,
}: SettingsSliderProps) {
  const percent = Math.round(value * 100);
  const minPercent = Math.round(min * 100);
  return (
    <div className={`settings-row${disabled ? " settings-row-disabled" : ""}`}>
      <div className="settings-row-header">
        <span className="settings-row-label">{label}</span>
        <span className="settings-row-value">{percent}</span>
      </div>
      <input
        type="range"
        min={minPercent}
        max={100}
        value={percent}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value) / 100)}
        className="settings-slider"
      />
    </div>
  );
}

export type { Settings };
