import { deliveredTotalIn } from "./money";
import type { ComparisonResult, FxTable, Money, OfferQuote } from "./types";

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

function cheapestOffer(offers: OfferQuote[], currency: string, fxTable: FxTable): OfferQuote | undefined {
  let cheapest: { offer: OfferQuote; total: Money } | undefined;
  for (const offer of offers) {
    const total = deliveredTotalIn({ item: offer.item, shipping: offer.shipping }, currency, fxTable);
    if (total && (!cheapest || total.amount < cheapest.total.amount)) {
      cheapest = { offer, total };
    }
  }
  return cheapest?.offer ?? offers[0];
}

export function withCheapestOtherOffer(result: ComparisonResult, currency: string, fxTable: FxTable): ComparisonResult {
  const { otherOffers, ...quote } = result;
  const offer = otherOffers && cheapestOffer(otherOffers, currency, fxTable);
  if (!offer || !quote.breakdown || !quote.otherSeller) {
    return quote;
  }

  return {
    ...quote,
    breakdown: { ...quote.breakdown, item: offer.item, shipping: offer.shipping },
    otherSeller: { ...quote.otherSeller, seller: offer.seller, dispatcher: offer.dispatcher, fulfilledByAmazon: offer.fulfilledByAmazon }
  };
}
