import { useEffect, useRef } from "react";
import type { ReactElement } from "react";
import { MARKETPLACE_BY_CODE, marketDisplayDomain, marketLabel } from "../../shared/markets";
import { formatMoney } from "../../shared/money";
import type { ComparisonResult, Money } from "../../shared/types";
import { deliveredLocalTotal, formatLocal, needsMatchCheck, trustSentence } from "../view-model";
import type { RankedRow } from "../view-model";
import { OpenButton } from "./OpenButton";

const SHEET_TITLE_ID = "b-sheet-title";

interface DetailSheetProps {
  row?: RankedRow;
  sourceTitle?: string;
  destination: string;
  onClose: () => void;
  onOpen: (result: ComparisonResult) => void;
}

interface SheetContentProps extends DetailSheetProps {
  row: RankedRow;
}

interface SheetLineProps {
  label: string;
  value: string;
  variant?: "total" | "conv";
}

function productHost(result: ComparisonResult): string {
  try {
    return new URL(result.productUrl ?? "").hostname;
  } catch {
    return marketDisplayDomain(result.marketplace);
  }
}

function SheetLine({ label, value, variant }: SheetLineProps): ReactElement {
  return (
    <div className={`dB-line${variant ? ` ${variant}` : ""}`}>
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}

function SheetContent({ row, sourceTitle, destination, onClose, onOpen }: SheetContentProps): ReactElement {
  const { result } = row;
  const breakdown = result.breakdown;
  const local = (value?: Money): string => (value ? formatLocal(value, result.marketplace) : "—");

  return (
    <>
      <div className="dB-grab" />
      <h4 id={SHEET_TITLE_ID}>
        {MARKETPLACE_BY_CODE[result.marketplace].flag} {marketLabel(result.marketplace)}
      </h4>
      <p className="sub">{row.isSource ? sourceTitle : productHost(result)}</p>
      <div className="dB-lines">
        <SheetLine label="Item price" value={local(breakdown?.item)} />
        <SheetLine
          label={`Shipping to ${destination}`}
          value={breakdown?.shipping?.amount ? local(breakdown.shipping) : "Free"}
        />
        <SheetLine
          label="Import fees deposit"
          value={breakdown?.importFees?.amount ? local(breakdown.importFees) : "—"}
        />
        <SheetLine label="Delivered total" value={local(deliveredLocalTotal(result))} variant="total" />
        <SheetLine label="Roughly" value={`${formatMoney(row.total)} at today’s rate`} variant="conv" />
      </div>
      <div className={`dB-trust${needsMatchCheck(result) ? " warn" : ""}`}>
        <span className="dot" />
        <span>{trustSentence(result)}</span>
      </div>
      {row.isSource ? (
        <button type="button" className="dB-cta secondary" id="b-close" onClick={onClose}>
          Close
        </button>
      ) : (
        <OpenButton className="dB-cta" result={result} onOpen={onOpen} />
      )}
    </>
  );
}

export function DetailSheet(props: DetailSheetProps): ReactElement {
  const { row, onClose } = props;
  const open = row !== undefined;
  const sheetRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    sheetRef.current?.focus();
    return () => previous?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  return (
    <>
      <div className={`dB-scrim${open ? " is-on" : ""}`} id="b-scrim" onClick={onClose} />
      <div
        ref={sheetRef}
        className={`dB-sheet${open ? " is-on" : ""}`}
        id="b-sheet"
        role={open ? "dialog" : undefined}
        aria-modal={open ? true : undefined}
        aria-labelledby={open ? SHEET_TITLE_ID : undefined}
        tabIndex={open ? -1 : undefined}
      >
        {row ? <SheetContent {...props} row={row} /> : null}
      </div>
    </>
  );
}
