import { describe, expect, it } from "vitest";
import { findCheapestAvailable, sortComparisonResults, withCheapestOtherOffer } from "../../src/shared/comparison";
import type { ComparisonResult, FxTable, Money, OfferQuote } from "../../src/shared/types";

describe("comparison ordering", () => {
  const fixture: ComparisonResult[] = [
    {
      marketplace: "DE",
      status: "UNAVAILABLE",
      confidence: 0.9
    },
    {
      marketplace: "UK",
      status: "OK",
      confidence: 0.91,
      normalizedTotal: { amount: 45.6, currency: "USD" }
    },
    {
      marketplace: "JP",
      status: "OK",
      confidence: 0.88,
      normalizedTotal: { amount: 41.2, currency: "USD" }
    },
    {
      marketplace: "FR",
      status: "DESTINATION_MISMATCH",
      confidence: 0.8
    }
  ];

  it("sorts available rows by normalized total and pushes unavailable rows last", () => {
    const sorted = sortComparisonResults(fixture);
    expect(sorted[0].marketplace).toBe("JP");
    expect(sorted[1].marketplace).toBe("UK");
    expect(sorted[2].status).not.toBe("OK");
    expect(sorted[3].status).not.toBe("OK");
  });

  it("finds cheapest only among available rows", () => {
    const cheapest = findCheapestAvailable(fixture);
    expect(cheapest?.marketplace).toBe("JP");
  });
});

describe("withCheapestOtherOffer", () => {
  const fxTable: FxTable = { base: "EUR", date: "2026-10-16", rates: { EUR: 1, USD: 1.08, GBP: 0.852, CHF: 0.94 }, source: "ECB" };
  const money = (amount: number, currency: string): Money => ({ amount, currency });

  function offer(item: Money, shipping: Money, seller: string, fulfilledByAmazon = true): OfferQuote {
    return { item, shipping, seller, dispatcher: fulfilledByAmazon ? "Amazon" : seller, fulfilledByAmazon };
  }

  function quotedFirst(otherOffers: OfferQuote[], extra: Partial<ComparisonResult> = {}): ComparisonResult {
    const [first] = otherOffers;
    return {
      marketplace: "UK",
      status: "OK",
      confidence: 0.96,
      breakdown: { item: first.item, shipping: first.shipping },
      otherSeller: {
        seller: first.seller,
        dispatcher: first.dispatcher,
        fulfilledByAmazon: first.fulfilledByAmazon,
        offerCount: 5,
        deliveringNewCount: otherOffers.length
      },
      otherOffers,
      notes: ["Matched by ASIN", "Quoted another seller's offer"],
      ...extra
    };
  }

  const buyMyBricks = offer(money(574.97, "GBP"), money(252.53, "CHF"), "BuyMyBricks");
  const ramanDz = offer(money(699, "GBP"), money(40.86, "CHF"), "RamanDz", false);

  it("quotes the offer with the lowest delivered total in the comparison currency, not Amazon's first", () => {
    expect(withCheapestOtherOffer(quotedFirst([buyMyBricks, ramanDz]), "USD", fxTable)).toEqual({
      marketplace: "UK",
      status: "OK",
      confidence: 0.96,
      breakdown: { item: money(699, "GBP"), shipping: money(40.86, "CHF") },
      otherSeller: { seller: "RamanDz", dispatcher: "RamanDz", fulfilledByAmazon: false, offerCount: 5, deliveringNewCount: 2 },
      notes: ["Matched by ASIN", "Quoted another seller's offer"]
    });
  });

  it("compares offers in the comparison currency itself without any exchange rate", () => {
    const noRates: FxTable = { base: "USD", date: "2026-10-16", rates: {}, source: "ECB" };
    const offers = [
      offer(money(651.25, "EUR"), money(55.26, "EUR"), "Star Brick City"),
      offer(money(600, "EUR"), money(55.26, "EUR"), "BricksBoutique"),
      offer(money(973.41, "EUR"), money(19, "EUR"), "RamanDz", false)
    ];

    const chosen = withCheapestOtherOffer(quotedFirst(offers), "EUR", noRates);

    expect(chosen.breakdown).toEqual({ item: money(600, "EUR"), shipping: money(55.26, "EUR") });
    expect(chosen.otherSeller?.seller).toBe("BricksBoutique");
  });

  it("chooses among the offers it can convert when some cannot be converted", () => {
    const unconvertible = offer(money(10, "SEK"), money(1, "SEK"), "Cheap but unconvertible");
    const chosen = withCheapestOtherOffer(quotedFirst([unconvertible, buyMyBricks, ramanDz]), "USD", fxTable);

    expect(chosen.otherSeller?.seller).toBe("RamanDz");
  });

  it("keeps Amazon's first offer when no offer converts into the comparison currency", () => {
    const first = offer(money(10, "SEK"), money(1, "SEK"), "First");
    const second = offer(money(5, "NOK"), money(1, "NOK"), "Second");

    const chosen = withCheapestOtherOffer(quotedFirst([first, second]), "USD", fxTable);

    expect(chosen.breakdown).toEqual({ item: money(10, "SEK"), shipping: money(1, "SEK") });
    expect(chosen.otherSeller?.seller).toBe("First");
    expect(chosen).not.toHaveProperty("otherOffers");
  });

  it("keeps Amazon's order between offers that cost the same delivered", () => {
    const first = offer(money(100, "EUR"), money(10, "EUR"), "First");
    const second = offer(money(105, "EUR"), money(5, "EUR"), "Second");

    expect(withCheapestOtherOffer(quotedFirst([first, second]), "EUR", fxTable).otherSeller?.seller).toBe("First");
  });

  it("keeps the rest of the breakdown, such as a baseline's zero import fees", () => {
    const baseline = quotedFirst([buyMyBricks, ramanDz]);
    baseline.breakdown = { ...baseline.breakdown!, importFees: money(0, "GBP") };

    expect(withCheapestOtherOffer(baseline, "GBP", fxTable).breakdown).toEqual({
      item: money(699, "GBP"),
      shipping: money(40.86, "CHF"),
      importFees: money(0, "GBP")
    });
  });

  it("leaves a result without other offers as it is", () => {
    const own: ComparisonResult = {
      marketplace: "DE",
      status: "OK",
      confidence: 0.92,
      breakdown: { item: money(37.2, "EUR"), shipping: money(4.5, "EUR") },
      notes: ["Matched by search"]
    };

    expect(withCheapestOtherOffer(own, "USD", fxTable)).toEqual(own);
  });
});
