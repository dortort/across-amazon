import type { CSSProperties, ReactElement } from "react";
import { MARKETPLACE_BY_CODE, marketDisplayDomain, marketLabel } from "../../shared/markets";
import { formatMoney } from "../../shared/money";
import type { ComparisonResult, FxTable, Marketplace, RunComparisonProgressPayload } from "../../shared/types";
import { displayTotal, inCheckOrder, phaseLabel, progressPercent } from "../view-model";

interface RunningViewProps {
  progress?: RunComparisonProgressPayload;
  runTargets: Marketplace[];
  currency: string;
  fxTable?: FxTable;
  onCancel: () => void;
}

interface CheckChipProps {
  result: ComparisonResult;
  currency: string;
  fxTable?: FxTable;
}

function CheckChip({ result, currency, fxTable }: CheckChipProps): ReactElement {
  const total = result.status === "OK" ? displayTotal(result, currency, fxTable) : undefined;
  return (
    <span className={`dB-chk ${result.status === "OK" ? "ok" : "bad"}`}>
      {MARKETPLACE_BY_CODE[result.marketplace].flag} {result.marketplace} {total ? formatMoney(total) : "—"}
    </span>
  );
}

export function RunningView({ progress, runTargets, currency, fxTable, onCancel }: RunningViewProps): ReactElement {
  const total = progress?.total ?? runTargets.length;
  const completed = progress?.completed ?? 0;
  const current = progress ? progress.currentMarketplace : runTargets[0];
  const checked = inCheckOrder(progress?.results ?? [], runTargets);
  const dialStyle = { "--p": `${progressPercent(completed, total)}%` } as CSSProperties;

  return (
    <div className="dB-scroll" tabIndex={-1}>
      <div className="dB-run">
        <div className="dB-ring">
          <div className="dB-dial-wrap">
            <div className="dB-dial" style={dialStyle} />
            <span className="dB-dial-num">
              {completed}/{total}
            </span>
          </div>
        </div>
        <div>
          <p className="dB-nowline" aria-live="polite">
            {current ? (
              <>
                {phaseLabel(progress?.phase)} <b>{marketLabel(current)}</b>
              </>
            ) : null}
          </p>
          <p className="dB-nowsub">{current ? marketDisplayDomain(current) : null}</p>
        </div>
        <div className="dB-checks">
          {checked.map((result) => (
            <CheckChip key={result.marketplace} result={result} currency={currency} fxTable={fxTable} />
          ))}
          {current ? (
            <span className="dB-chk now">
              {MARKETPLACE_BY_CODE[current].flag} {current} …
            </span>
          ) : null}
        </div>
        <button type="button" className="dB-cta secondary" id="b-cancel" onClick={onCancel}>
          Stop checking
        </button>
      </div>
    </div>
  );
}
