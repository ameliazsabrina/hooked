import { useWallet } from "@solana/wallet-adapter-react";
import { usePlayer } from "~/hooks/use-player";
import { useSessionAuth } from "~/providers/session-auth-provider";
import { GameLayout } from "~/components/layout/game-layout";
import { NicknameScreen } from "./nickname-screen";
import { DepositScreen } from "./deposit-screen";
import "./onboarding.css";

export function OnboardingGate() {
  const { connected } = useWallet();
  const {
    ready: authReady,
    state: authState,
    error: authError,
  } = useSessionAuth();

  const playerQuery = usePlayer({
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

  const showLoader = connected && (!authReady || playerQuery.isLoading);

  if (import.meta.env.DEV) {
    console.log("[onboarding-gate]", {
      connected,
      authState,
      authReady,
      authError,
      playerLoading: playerQuery.isLoading,
      playerFetching: playerQuery.isFetching,
      playerError: playerQuery.error?.message,
      playerExists: data?.exists,
      showLoader,
      needsNickname,
      needsDeposit,
      ready,
    });
  }
  const loaderMessage =
    authState === "signing"
      ? "Hold on, Captain! Signing your papers"
      : authState === "verifying"
        ? "Your ship is being verified"
        : "Your ship is arriving";

  return (
    <>
      <GameLayout nickname={nickname} ready={ready} />
      {showLoader && (
        <div className="onboarding-loading">
          <span className="onboarding-loading__ship" aria-hidden>
            <img src="/assets/Ship/Ship1.png" alt="" />
            <img src="/assets/Ship/Ship2.png" alt="" />
          </span>
          <span className="onboarding-loading__text">{loaderMessage}</span>
          <span className="onboarding-loading__wave" aria-hidden>
            <span>
              ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~
              ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~
              ~ ~ ~ ~&nbsp;
            </span>
          </span>
        </div>
      )}
      {needsNickname && <NicknameScreen />}
      {needsDeposit && <DepositScreen />}
    </>
  );
}
