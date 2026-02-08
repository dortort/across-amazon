import type { ComparisonResult } from "./types";

function statusRank(status: ComparisonResult["status"]): number {
  return status === "OK" ? 0 : 1;
}

export function sortComparisonResults(results: ComparisonResult[]): ComparisonResult[] {
  return [...results].sort((left, right) => {
    const statusDiff = statusRank(left.status) - statusRank(right.status);
    if (statusDiff !== 0) {
      return statusDiff;
    }

    if (left.status === "OK" && right.status === "OK") {
      const leftTotal = left.normalizedTotal?.amount ?? Number.POSITIVE_INFINITY;
      const rightTotal = right.normalizedTotal?.amount ?? Number.POSITIVE_INFINITY;
      return leftTotal - rightTotal;
    }

    return left.marketplace.localeCompare(right.marketplace);
  });
}

export function findCheapestAvailable(results: ComparisonResult[]): ComparisonResult | undefined {
  return sortComparisonResults(results).find(
    (result) => result.status === "OK" && typeof result.normalizedTotal?.amount === "number"
  );
}
