import { useWallet } from "@solana/wallet-adapter-react";
import { trpc } from "~/utils/trpc";
import { useSessionAuth } from "~/providers/session-auth-provider";
import { GameLayout } from "~/components/layout/game-layout";
import { NicknameScreen } from "./nickname-screen";
import { DepositScreen } from "./deposit-screen";
import "./onboarding.css";

export function OnboardingGate() {
  const { connected } = useWallet();
  const { ready: authReady } = useSessionAuth();

  const playerQuery = trpc.player.me.useQuery(undefined, {
    enabled: connected && authReady,
    retry: 1,
    staleTime: 0,
  });

  const data = playerQuery.data;
  const nickname = data?.exists ? data.nickname : undefined;
  const needsNickname =
    connected && authReady && !playerQuery.isLoading && !data?.exists;
  const needsDeposit = data?.exists && !data.depositAmount;
  const ready = connected && authReady && data?.exists && !!data.depositAmount;

  return (
    <>
      <GameLayout nickname={nickname} ready={ready} />
      {needsNickname && <NicknameScreen />}
      {needsDeposit && <DepositScreen />}
    </>
  );
}
