interface SettingsButtonProps {
  className?: string;
  onClick: () => void;
}

export function SettingsButton({ className, onClick }: SettingsButtonProps) {
  return (
    <button
      type="button"
      className={`settings-btn${className ? ` ${className}` : ""}`}
      onClick={onClick}
      aria-label="Settings"
    >
      <img
        src="/assets/ui/settings.svg"
        alt=""
        className="settings-btn-icon"
      />
    </button>
  );
}
