import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { MARKETPLACE_BY_CODE, marketDisplayDomain, marketLabel } from "../../shared/markets";
import { formatMoney } from "../../shared/money";
import type { ComparisonResult, Money, SourceContext } from "../../shared/types";
import { deliveredLocalTotal, formatLocal, formatVariantTokens, needsMatchCheck, trustSentence } from "../view-model";
import type { RankedRow } from "../view-model";
import { OpenButton } from "./OpenButton";

const SHEET_TITLE_ID = "b-sheet-title";
const CLOSE_FALLBACK_MS = 400;
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface DetailSheetProps {
  row?: RankedRow;
  source?: SourceContext;
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

function sourceSubtitle(source?: SourceContext): string {
  if (!source) {
    return "";
  }
  return source.variationTokens.length > 0
    ? `${source.title} — ${formatVariantTokens(source.variationTokens)}`
    : source.title;
}

function cycleFocus(sheet: HTMLElement, backwards: boolean): void {
  const stops = [sheet, ...sheet.querySelectorAll<HTMLElement>(FOCUSABLE)];
  const current = stops.findIndex((stop) => stop === document.activeElement);
  const step = backwards ? -1 : 1;
  const next = current === -1 ? (backwards ? stops.length - 1 : 0) : (current + step + stops.length) % stops.length;
  stops[next].focus();
}

function SheetLine({ label, value, variant }: SheetLineProps): ReactElement {
  return (
    <div className={`dB-line${variant ? ` ${variant}` : ""}`}>
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}

function SheetContent({ row, source, destination, onClose, onOpen }: SheetContentProps): ReactElement {
  const { result } = row;
  const breakdown = result.breakdown;
  const local = (value?: Money): string => (value ? formatLocal(value, result.marketplace) : "—");

  return (
    <>
      <div className="dB-grab" />
      <h4 id={SHEET_TITLE_ID}>
        {MARKETPLACE_BY_CODE[result.marketplace].flag} {marketLabel(result.marketplace)}
      </h4>
      <p className="sub">{row.isSource ? sourceSubtitle(source) : marketDisplayDomain(result.marketplace)}</p>
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
        <span>{trustSentence(result, row.isSource)}</span>
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
  const [retained, setRetained] = useState<RankedRow | undefined>(row);
  if (row && row !== retained) {
    setRetained(row);
  }
  const content = row ?? retained;

  useEffect(() => {
    if (open || !retained) {
      return undefined;
    }
    const sheet = sheetRef.current;
    const release = (): void => setRetained(undefined);
    const onTransitionEnd = (event: TransitionEvent): void => {
      if (event.target === sheet && event.propertyName === "transform") {
        release();
      }
    };
    const timer = setTimeout(release, CLOSE_FALLBACK_MS);
    sheet?.addEventListener("transitionend", onTransitionEnd);
    return () => {
      clearTimeout(timer);
      sheet?.removeEventListener("transitionend", onTransitionEnd);
    };
  }, [open, retained]);

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
        event.preventDefault();
        event.stopPropagation();
        onClose();
      } else if (event.key === "Tab" && sheetRef.current) {
        event.preventDefault();
        cycleFocus(sheetRef.current, event.shiftKey);
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
        aria-hidden={open ? undefined : true}
        tabIndex={open ? -1 : undefined}
      >
        {content ? <SheetContent {...props} row={content} /> : null}
      </div>
    </>
  );
}
