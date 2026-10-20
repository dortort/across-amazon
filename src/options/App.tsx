import { useEffect, useMemo, useState } from "react";
import type { ReactElement } from "react";
import { MARKETPLACES } from "../shared/markets";
import { loadSettings, saveSettings } from "../shared/storage";
import type { ExtensionSettings, Marketplace } from "../shared/types";

const CURRENCIES = ["SOURCE", "USD", "CAD", "MXN", "GBP", "EUR", "JPY", "AUD"] as const;

export function App(): ReactElement {
  const [settings, setSettings] = useState<ExtensionSettings>();
  const [savedAt, setSavedAt] = useState<string>();

  useEffect(() => {
    void loadSettings().then((value) => {
      setSettings(value);
    });
  }, []);

  const allEnabled = useMemo(() => {
    if (!settings) {
      return false;
    }

    return settings.enabledMarketplaces.length === MARKETPLACES.length;
  }, [settings]);

  const onToggleMarketplace = (marketplace: Marketplace): void => {
    if (!settings) {
      return;
    }

    const nextEnabled = settings.enabledMarketplaces.includes(marketplace)
      ? settings.enabledMarketplaces.filter((code) => code !== marketplace)
      : [...settings.enabledMarketplaces, marketplace];

    setSettings({
      ...settings,
      enabledMarketplaces: nextEnabled
    });
  };

  const onToggleAll = (): void => {
    if (!settings) {
      return;
    }

    setSettings({
      ...settings,
      enabledMarketplaces: allEnabled ? [] : MARKETPLACES.map((market) => market.code)
    });
  };

  const onSave = async (): Promise<void> => {
    if (!settings) {
      return;
    }

    await saveSettings(settings);
    setSavedAt(new Date().toLocaleString());
  };

  if (!settings) {
    return <main className="options">Loading settings...</main>;
  }

  return (
    <main className="options">
      <header>
        <h1>Across Amazon Settings</h1>
        <p>Control marketplaces and currency normalization.</p>
      </header>

      <section>
        <h2>Marketplaces</h2>
        <div className="inline-toggle">
          <label>
            <input type="checkbox" checked={allEnabled} onChange={onToggleAll} /> Enable all marketplaces
          </label>
        </div>
        <div className="grid">
          {MARKETPLACES.map((market) => (
            <label key={market.code} className="checkbox-row">
              <input
                type="checkbox"
                checked={settings.enabledMarketplaces.includes(market.code)}
                onChange={() => onToggleMarketplace(market.code)}
              />
              <span>
                {market.label} ({market.code})
              </span>
            </label>
          ))}
        </div>
      </section>

      <section>
        <h2>Comparison Currency</h2>
        <select
          value={settings.comparisonCurrency}
          onChange={(event) => {
            setSettings({
              ...settings,
              comparisonCurrency: event.target.value
            });
          }}
        >
          {CURRENCIES.map((currency) => (
            <option key={currency} value={currency}>
              {currency === "SOURCE" ? "Source marketplace currency" : currency}
            </option>
          ))}
        </select>
      </section>

      <section>
        <h2>Disclosure</h2>
        <p>Across Amazon is not affiliated with or endorsed by Amazon.</p>
      </section>

      <footer>
        <button onClick={() => void onSave()}>Save settings</button>
        {savedAt ? <p>Saved at {savedAt}</p> : null}
      </footer>
    </main>
  );
}
