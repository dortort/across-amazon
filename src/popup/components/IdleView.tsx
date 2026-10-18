import type { ReactElement } from "react";
import { marketDisplayDomain } from "../../shared/markets";
import type { ComparisonResult, SourceContext } from "../../shared/types";
import { checkLabel, estimatedSeconds, formatLocal, formatVariantTokens } from "../view-model";

export type SourceStatus = "loading" | "ready" | "failed";

interface IdleViewProps {
  source?: SourceContext;
  baseline?: ComparisonResult;
  status: SourceStatus;
  targetCount: number;
  destination: string;
  onRun: () => void;
}

function productLine(source: SourceContext, baseline?: ComparisonResult): string {
  const variant = source.variationTokens.length > 0 ? formatVariantTokens(source.variationTokens) : source.brand;
  const item = baseline?.breakdown?.item;
  const domain = marketDisplayDomain(source.marketplace);
  const where = item ? `${formatLocal(item, source.marketplace)} on ${domain}` : domain;
  return [variant, where].filter(Boolean).join(" · ");
}

function ProductCard({ source, baseline }: { source: SourceContext; baseline?: ComparisonResult }): ReactElement {
  return (
    <div className="dB-prod">
      <div className={`dB-thumb${source.imageUrl ? "" : " is-placeholder"}`}>
        {source.imageUrl ? <img src={source.imageUrl} alt="" /> : null}
      </div>
      <div>
        <h3>{source.title}</h3>
        <p>{productLine(source, baseline)}</p>
      </div>
    </div>
  );
}

function NotOnAmazonNotice(): ReactElement {
  return (
    <div className="dB-notice">
      <b>Open an Amazon product page</b>
      <p>
        Across Amazon compares the delivered price of the product you are looking at across other Amazon marketplaces.
      </p>
    </div>
  );
}

export function IdleView({ source, baseline, status, targetCount, destination, onRun }: IdleViewProps): ReactElement {
  if (!source && status === "loading") {
    return <div className="dB-scroll" />;
  }

  return (
    <div className="dB-scroll">
      {source ? <ProductCard source={source} baseline={baseline} /> : <NotOnAmazonNotice />}
      <button type="button" className="dB-cta" id="b-run" disabled={!source} onClick={onRun}>
        {checkLabel(targetCount)}
      </button>
      {source ? (
        <p className="dB-hint">
          Takes about {estimatedSeconds(targetCount)} seconds. Each Amazon opens briefly in a background tab so we can
          read its real delivered price to {destination}.
        </p>
      ) : null}
    </div>
  );
}
