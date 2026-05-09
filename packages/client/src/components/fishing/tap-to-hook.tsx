// Fullscreen non-interactive prompt rendered during the 2s reaction window.
// Taps go through to the global listener installed by use-fishing-ws.ts so
// the entire screen is the hook target.
export function TapToHook() {
  return (
    <div className="tap-to-hook-overlay" aria-hidden>
      <div className="tap-to-hook-prompt">TAP TO HOOK!</div>
    </div>
  );
}
