// Thin wrapper around navigator.vibrate. iOS Safari ignores this API
// silently; Android Chrome supports it. We never want a missing API to
// surface as an error — a UI cue is opportunistic, never load-bearing.
export function vibrate(pattern: number | number[]): void {
  if (typeof navigator === "undefined") return;
  const nav = navigator as Navigator & {
    vibrate?: (pattern: number | number[]) => boolean;
  };
  if (typeof nav.vibrate !== "function") return;
  try {
    nav.vibrate(pattern);
  } catch {
    // Some embeds (in-app browsers) throw on vibrate calls; swallow.
  }
}
