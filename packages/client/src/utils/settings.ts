import { useSyncExternalStore } from "react";

export type Settings = {
  musicVolume: number;
  sfxVolume: number;
  brightness: number;
  muted: boolean;
  confirmApexSell: boolean;
};

export const DEFAULT_SETTINGS: Settings = {
  musicVolume: 0.15,
  sfxVolume: 1.0,
  brightness: 1.0,
  muted: false,
  confirmApexSell: true,
};

const STORAGE_KEY = "hooked:settings";

function clamp01(n: unknown, fallback: number): number {
  return typeof n === "number" && Number.isFinite(n)
    ? Math.max(0, Math.min(1, n))
    : fallback;
}

export function loadSettings(): Settings {
  if (typeof window === "undefined") return { ...DEFAULT_SETTINGS };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      musicVolume: clamp01(parsed.musicVolume, DEFAULT_SETTINGS.musicVolume),
      sfxVolume: clamp01(parsed.sfxVolume, DEFAULT_SETTINGS.sfxVolume),
      brightness: clamp01(parsed.brightness, DEFAULT_SETTINGS.brightness),
      muted:
        typeof parsed.muted === "boolean"
          ? parsed.muted
          : DEFAULT_SETTINGS.muted,
      confirmApexSell:
        typeof parsed.confirmApexSell === "boolean"
          ? parsed.confirmApexSell
          : DEFAULT_SETTINGS.confirmApexSell,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

let cached: Settings = loadSettings();
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function getSettings(): Settings {
  return cached;
}

export function saveSettings(partial: Partial<Settings>): Settings {
  const next: Settings = {
    musicVolume: clamp01(
      partial.musicVolume ?? cached.musicVolume,
      cached.musicVolume,
    ),
    sfxVolume: clamp01(
      partial.sfxVolume ?? cached.sfxVolume,
      cached.sfxVolume,
    ),
    brightness: clamp01(
      partial.brightness ?? cached.brightness,
      cached.brightness,
    ),
    muted:
      typeof partial.muted === "boolean" ? partial.muted : cached.muted,
    confirmApexSell:
      typeof partial.confirmApexSell === "boolean"
        ? partial.confirmApexSell
        : cached.confirmApexSell,
  };
  cached = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {}
  emit();
  return next;
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useSettings(): [
  Settings,
  (partial: Partial<Settings>) => void,
] {
  const settings = useSyncExternalStore(subscribe, getSettings, getSettings);
  return [settings, saveSettings];
}
