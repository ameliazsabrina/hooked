import { useWallet } from "@solana/wallet-adapter-react";
import { trpc } from "~/utils/trpc";
import { useSessionAuth } from "~/providers/session-auth-provider";

export function ControlsPanel() {
  const { connected } = useWallet();
  const { ready: authReady } = useSessionAuth();
  const playerQuery = trpc.player.me.useQuery(undefined, {
    enabled: connected && authReady,
  });

  const shellBalance = playerQuery.data?.exists
    ? playerQuery.data.shellBalance
    : 0;

  return (
    <div className="controls-panel">
      <div className="panel-title">Currency</div>
      <div className="shell-balance">
        <img
          src="/assets/ui/shell.png"
          alt="Shells"
          className="shell-balance-icon"
        />
        <span className="shell-balance-amount">{shellBalance}</span>
      </div>
    </div>
  );
}
