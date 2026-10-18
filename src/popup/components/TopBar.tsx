import type { ReactElement } from "react";

interface TopBarProps {
  inSettings: boolean;
  onToggleSettings: () => void;
}

export function TopBar({ inSettings, onToggleSettings }: TopBarProps): ReactElement {
  return (
    <div className="dB-top">
      <span className="dB-brand">
        <span className="dB-mark">A</span>Across Amazon
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
