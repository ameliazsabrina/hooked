import { useState } from "react";
import { isValidNickname, sanitizeNickname, NICKNAME_MAX } from "@hooked/shared";
import { trpc } from "~/utils/trpc";
import "./onboarding.css";

export function NicknameScreen() {
  const [nickname, setNickname] = useState("");
  const [error, setError] = useState("");
  const utils = trpc.useUtils();

  const mutation = trpc.player.setNickname.useMutation({
    onSuccess: () => {
      utils.player.me.invalidate();
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onError: (err: any) => {
      if (err.data?.code === "CONFLICT") {
        setError("Name already taken");
      } else {
        setError(err.message);
      }
    },
  });

  const isValid = isValidNickname(nickname);

  function handleChange(value: string) {
    setNickname(sanitizeNickname(value));
    setError("");
  }

  function handleSubmit() {
    if (!isValid || mutation.isPending) return;
    mutation.mutate({ nickname });
  }

  return (
    <div className="onboarding-overlay">
      <div className="onboarding-card">
        <h1 className="onboarding-title">Set Your Captain Name</h1>
        <p className="onboarding-subtitle">3–16 characters, letters and numbers only</p>

        <div className="onboarding-input-wrapper">
          <input
            className={`onboarding-input ${error ? "error" : ""}`}
            type="text"
            placeholder="Enter nickname"
            value={nickname}
            onChange={(e) => handleChange(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
            autoFocus
          />
          <span className="onboarding-char-count">
            {nickname.length} / {NICKNAME_MAX}
          </span>
        </div>

        <div className="onboarding-preview">
          {nickname.length >= 3 ? `Captain ${nickname}` : ""}
        </div>

        <div className="onboarding-error">{error}</div>

        <button
          className="onboarding-submit"
          onClick={handleSubmit}
          disabled={!isValid || mutation.isPending}
        >
          {mutation.isPending ? "Setting sail..." : "Set Sail"}
        </button>
      </div>
    </div>
  );
}
