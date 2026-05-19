/** Non-interactive overlay; taps pass through to the global listener in use-fishing-ws. */
export function TapToHook() {
  return (
    <div className="tap-to-hook-overlay" aria-hidden>
      <div className="tap-to-hook-prompt">TAP TO HOOK!</div>
    </div>
  );
}
