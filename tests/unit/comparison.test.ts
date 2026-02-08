import { describe, expect, it } from "vitest";
import { findCheapestAvailable, sortComparisonResults } from "../../src/shared/comparison";
import type { ComparisonResult } from "../../src/shared/types";

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
