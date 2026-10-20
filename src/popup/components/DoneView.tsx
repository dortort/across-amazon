import type { ReactElement } from "react";
import type { ComparisonResult, FxTable, Marketplace } from "../../shared/types";
import type { RankedRow, Verdict } from "../view-model";
import { IssuesAccordion } from "./IssuesAccordion";
import { RankedList } from "./RankedList";
import { VerdictCard } from "./VerdictCard";

interface DoneViewProps {
  verdict: Verdict;
  error?: string;
  rows: RankedRow[];
  issues: ComparisonResult[];
  currency: string;
  fxTable?: FxTable;
  destination: string;
  destinationCountryCode?: string;
  sourceDomain: string;
  issuesOpen: boolean;
  onToggleIssues: () => void;
  onSelectRow: (marketplace: Marketplace) => void;
  onOpen: (result: ComparisonResult) => void;
  onRun: () => void;
}

export function DoneView({
  verdict,
  error,
  rows,
  issues,
  currency,
  fxTable,
  destination,
  destinationCountryCode,
  sourceDomain,
  issuesOpen,
  onToggleIssues,
  onSelectRow,
  onOpen,
  onRun
}: DoneViewProps): ReactElement {
  return (
    <div className="dB-scroll" tabIndex={-1}>
      <VerdictCard
        verdict={verdict}
        error={error}
        destination={destination}
        sourceDomain={sourceDomain}
        onOpen={onOpen}
      />
      {rows.length > 0 ? <RankedList rows={rows} currency={currency} fxTable={fxTable} onSelect={onSelectRow} /> : null}
      {issues.length > 0 ? (
        <IssuesAccordion
          issues={issues}
          open={issuesOpen}
          destinationCountryCode={destinationCountryCode}
          onToggle={onToggleIssues}
        />
      ) : null}
      <button type="button" className="dB-cta secondary" id="b-run" onClick={onRun}>
        Check again
      </button>
    </div>
  );
}
