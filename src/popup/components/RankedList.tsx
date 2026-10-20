import type { ReactElement } from "react";
import { MARKETPLACE_BY_CODE, marketLabel } from "../../shared/markets";
import { formatMoney } from "../../shared/money";
import type { FxTable, Marketplace } from "../../shared/types";
import { costLine, deliveredLocalTotal, formatDelta, formatLocal, needsMatchCheck } from "../view-model";
import type { RankedRow } from "../view-model";

interface RankedListProps {
  rows: RankedRow[];
  currency: string;
  fxTable?: FxTable;
  onSelect: (marketplace: Marketplace) => void;
}

interface RowButtonProps {
  row: RankedRow;
  fxTable?: FxTable;
  onSelect: (marketplace: Marketplace) => void;
}

function RowButton({ row, fxTable, onSelect }: RowButtonProps): ReactElement {
  const { marketplace } = row.result;
  const local = deliveredLocalTotal(row.result, fxTable);
  const delta = formatDelta(row.delta, row.isSource);

  return (
    <button
      type="button"
      className={`dB-row${row.isBest ? " best" : ""}`}
      aria-haspopup="dialog"
      onClick={() => onSelect(marketplace)}
    >
      <span className="flag">{MARKETPLACE_BY_CODE[marketplace].flag}</span>
      <span className="who">
        <strong>
          {marketLabel(marketplace)}
          {needsMatchCheck(row.result) ? <span className="dB-flag-pill">Check match</span> : null}
        </strong>
        {local ? (
          <span>
            {formatLocal(local, marketplace)} {costLine(row)}
          </span>
        ) : null}
      </span>
      <span className="amt">
        <strong>{formatMoney(row.total)}</strong>
        <span className={delta.cls}>{delta.text}</span>
      </span>
    </button>
  );
}

export function RankedList({ rows, currency, fxTable, onSelect }: RankedListProps): ReactElement {
  return (
    <>
      <div className="dB-sectitle">
        <span>Every marketplace</span>
        <span>{currency} delivered</span>
      </div>
      <div className="dB-list">
        {rows.map((row) => (
          <RowButton key={row.result.marketplace} row={row} fxTable={fxTable} onSelect={onSelect} />
        ))}
      </div>
    </>
  );
}
