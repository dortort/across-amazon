import type { ReactElement, ReactNode } from "react";
import { marketLabel } from "../../shared/markets";
import { formatMoney } from "../../shared/money";
import type { ComparisonResult } from "../../shared/types";
import { costSentence, needsMatchCheck, percentFormat, sourceCostSentence } from "../view-model";
import type { Verdict } from "../view-model";
import { OpenButton } from "./OpenButton";

interface VerdictCardProps {
  verdict: Verdict;
  baseline?: ComparisonResult;
  error?: string;
  destination: string;
  sourceDomain: string;
  onOpen: (result: ComparisonResult) => void;
}

interface MutedCardProps {
  eyebrow: string;
  headline: string;
  children: ReactNode;
}

const MATCH_CHECK_SENTENCE = " Confirm it is the same product before you buy.";

function MatchPill({ result }: { result: ComparisonResult }): ReactElement | null {
  return needsMatchCheck(result) ? <span className="dB-flag-pill">Check match</span> : null;
}

function matchSentence(result: ComparisonResult): string {
  return needsMatchCheck(result) ? MATCH_CHECK_SENTENCE : "";
}

function MutedCard({ eyebrow, headline, children }: MutedCardProps): ReactElement {
  return (
    <div className="dB-verdict is-muted">
      <p className="eyebrow">{eyebrow}</p>
      <p className="dB-save is-small">{headline}</p>
      <p className="lede">{children}</p>
    </div>
  );
}

export function VerdictCard({ verdict, baseline, error, destination, sourceDomain, onOpen }: VerdictCardProps): ReactElement {
  if (error) {
    return (
      <MutedCard eyebrow="Something went wrong" headline="Couldn't compare">
        {error}
      </MutedCard>
    );
  }

  const sourceNote = sourceCostSentence(baseline, sourceDomain);
  const sourceLine = sourceNote ? ` ${sourceNote}` : "";

  switch (verdict.kind) {
    case "save":
      return (
        <div className="dB-verdict">
          <p className="eyebrow">
            Cheapest delivered to {destination}
            <MatchPill result={verdict.best} />
          </p>
          <p className="dB-save">Save {formatMoney(verdict.saving)}</p>
          <p className="lede">
            Buy from <b>{marketLabel(verdict.best.marketplace)}</b> for <b>{formatMoney(verdict.bestTotal)}</b>{" "}
            delivered — {percentFormat(verdict.percent)}% less than the {formatMoney(verdict.baselineTotal)} you would
            pay here. {costSentence(verdict.best)}
            {sourceLine}
            {matchSentence(verdict.best)}
          </p>
          <OpenButton className="dB-vbtn" result={verdict.best} onOpen={onOpen} />
        </div>
      );
    case "cheapest":
      return (
        <div className="dB-verdict">
          <p className="eyebrow">
            Cheapest delivered to {destination}
            <MatchPill result={verdict.best} />
          </p>
          <p className="dB-save">{formatMoney(verdict.bestTotal)}</p>
          <p className="lede">
            Buy from <b>{marketLabel(verdict.best.marketplace)}</b> for <b>{formatMoney(verdict.bestTotal)}</b>{" "}
            delivered. {costSentence(verdict.best)} We could not read the price on this page to compare.
            {matchSentence(verdict.best)}
          </p>
          <OpenButton className="dB-vbtn" result={verdict.best} onOpen={onOpen} />
        </div>
      );
    case "stay":
      return (
        <MutedCard eyebrow="Result" headline="Stay here">
          Nothing came in under the {formatMoney(verdict.baselineTotal)} you would pay on {sourceDomain}.{sourceLine}
        </MutedCard>
      );
    case "none":
      return (
        <MutedCard eyebrow="Result" headline="No delivered price">
          None of the marketplaces we checked could quote a delivered price to {destination}.
        </MutedCard>
      );
  }
}
