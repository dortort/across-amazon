import type { ReactElement } from "react";

interface TopBarProps {
  inSettings: boolean;
  onToggleSettings: () => void;
}

export function TopBar({ inSettings, onToggleSettings }: TopBarProps): ReactElement {
  return (
    <div className="dB-top">
      <span className="dB-brand">
        <img className="dB-mark" src="/icons/icon-48.png" alt="" />Across Amazon
      </span>
      <button
        type="button"
        className="dB-icon"
        id="b-gear"
        aria-label={inSettings ? "Close settings" : "Settings"}
        onClick={onToggleSettings}
      >
        {inSettings ? "✕" : "⚙"}
      </button>
    </div>
  );
}
