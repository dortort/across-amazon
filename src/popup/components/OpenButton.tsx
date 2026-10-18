import type { ReactElement } from "react";
import { marketDisplayDomain } from "../../shared/markets";
import type { ComparisonResult } from "../../shared/types";

interface OpenButtonProps {
  className: string;
  result: ComparisonResult;
  onOpen: (result: ComparisonResult) => void;
}

export function OpenButton({ className, result, onOpen }: OpenButtonProps): ReactElement {
  return (
    <button type="button" className={className} disabled={!result.productUrl} onClick={() => onOpen(result)}>
      Open on {marketDisplayDomain(result.marketplace)}
    </button>
  );
}
