import type { ReactElement } from "react";
import { MARKETPLACES, MARKETPLACE_BY_CODE, MARKETPLACE_CODES } from "../../shared/markets";
import type { ExtensionSettings, Marketplace, SourceContext } from "../../shared/types";
import { currencyChoices, resolveDisplayCurrency } from "../view-model";

const CURRENCY_TITLE_ID = "b-cur-title";

interface SettingsViewProps {
  settings: ExtensionSettings;
  source?: SourceContext;
  onChange: (settings: ExtensionSettings) => void;
}

export function SettingsView({ settings, source, onChange }: SettingsViewProps): ReactElement {
  const selectedCurrency = resolveDisplayCurrency(settings.comparisonCurrency, source);
  const sourceCurrency = source ? MARKETPLACE_BY_CODE[source.marketplace].currency : undefined;
  const markets = MARKETPLACES.filter((market) => market.code !== source?.marketplace);

  const toggleMarket = (code: Marketplace, enabled: boolean): void => {
    onChange({
      ...settings,
      enabledMarketplaces: MARKETPLACE_CODES.filter((candidate) =>
        candidate === code ? enabled : settings.enabledMarketplaces.includes(candidate)
      )
    });
  };

  return (
    <div className="dB-scroll" tabIndex={-1}>
      <div className="dB-set">
        <div>
          <h4 id={CURRENCY_TITLE_ID}>Show prices in</h4>
          <div className="dB-seg" id="b-seg" role="group" aria-labelledby={CURRENCY_TITLE_ID}>
            {currencyChoices(source, settings.comparisonCurrency).map((currency) => (
              <button
                key={currency}
                type="button"
                aria-pressed={currency === selectedCurrency}
                onClick={() =>
                  onChange({ ...settings, comparisonCurrency: currency === sourceCurrency ? "SOURCE" : currency })
                }
              >
                {currency}
              </button>
            ))}
          </div>
          <p className="dB-hint is-left">
            Converted daily from European Central Bank rates. Amazon charges you in the local currency.
          </p>
        </div>
        <div>
          <h4>Marketplaces to check</h4>
          <div className="dB-mkts" id="b-mkts">
            {markets.map((market) => {
              const enabled = settings.enabledMarketplaces.includes(market.code);
              return (
                <label key={market.code} className={`dB-mkt${enabled ? "" : " off"}`}>
                  <input
                    type="checkbox"
                    checked={enabled}
                    onChange={(event) => toggleMarket(market.code, event.target.checked)}
                  />{" "}
                  {market.flag} {market.label}
                </label>
              );
            })}
          </div>
          <p className="dB-hint is-left">
            Fewer marketplaces means a faster check. Each one opens briefly in a background tab.
          </p>
        </div>
      </div>
    </div>
  );
}
