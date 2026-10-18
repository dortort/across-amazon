import type { ReactElement } from "react";
import { MARKETPLACE_BY_CODE, marketLabel } from "../../shared/markets";
import type { ComparisonResult } from "../../shared/types";
import { issueNote, issuesLabel, statusText } from "../view-model";

interface IssuesAccordionProps {
  issues: ComparisonResult[];
  open: boolean;
  destinationCountryCode?: string;
  onToggle: () => void;
}

export function IssuesAccordion({
  issues,
  open,
  destinationCountryCode,
  onToggle
}: IssuesAccordionProps): ReactElement {
  return (
    <div className="dB-acc">
      <button
        type="button"
        className="dB-acc-btn"
        id="b-issues"
        aria-expanded={open}
        aria-controls="b-issues-body"
        onClick={onToggle}
      >
        <span>{issuesLabel(issues.length)}</span>
        <span aria-hidden="true">{open ? "⌃" : "⌄"}</span>
      </button>
      <div className="dB-acc-body" id="b-issues-body" hidden={!open}>
        {issues.map((result) => (
          <div className="dB-issue" key={result.marketplace}>
            <span className="flag">{MARKETPLACE_BY_CODE[result.marketplace].flag}</span>
            <div>
              <strong>
                {marketLabel(result.marketplace)} — {statusText(result.status)}
              </strong>
              <p>{issueNote(result, destinationCountryCode)}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
