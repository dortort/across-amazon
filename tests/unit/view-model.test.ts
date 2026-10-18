import { describe, expect, it } from "vitest";
import { MARKETPLACE_BY_CODE, MARKETPLACE_CODES } from "../../src/shared/markets";
import { formatMoney } from "../../src/shared/money";
import type {
  ComparisonResult,
  ComparisonStatus,
  ExtensionSettings,
  FxTable,
  Marketplace,
  Money,
  SourceContext
} from "../../src/shared/types";
import {
  DISPLAY_CURRENCIES,
  checkLabel,
  computeVerdict,
  currencyChoices,
  deliveredLocalTotal,
  displayTotal,
  estimatedSeconds,
  formatDelta,
  formatLocal,
  issueNote,
  issues,
  issuesLabel,
  needsMatchCheck,
  percentFormat,
  formatVariantTokens,
  phaseLabel,
  progressPercent,
  rankAvailable,
  rankedRows,
  resolveDisplayCurrency,
  statusText,
  targetMarkets,
  trustSentence
} from "../../src/popup/view-model";

const NBSP = " ";
const MINUS = "−";

const fxTable: FxTable = {
  base: "EUR",
  date: "2026-07-30",
  rates: { EUR: 1, USD: 1.08, GBP: 0.852, CAD: 1.475, AUD: 1.655, JPY: 155.52, MXN: 19.46 },
  source: "ECB"
};

function money(amount: number, currency: string): Money {
  return { amount, currency };
}

function sourceFor(marketplace: Marketplace): SourceContext {
  return {
    marketplace,
    asin: "B09XS7JWHH",
    title: "Sony WH-1000XM5 Wireless Noise Canceling Headphones",
    brand: "Sony",
    variationTokens: ["Black"],
    destinationCountryCode: marketplace,
    sourceUrl: `https://${MARKETPLACE_BY_CODE[marketplace].domain}/dp/B09XS7JWHH`
  };
}

function okResult(
  marketplace: Marketplace,
  item: number,
  shipping: number,
  importFees: number,
  confidence: number,
  notes?: string[]
): ComparisonResult {
  const currency = MARKETPLACE_BY_CODE[marketplace].currency;
  return {
    marketplace,
    status: "OK",
    confidence,
    productUrl: `https://${MARKETPLACE_BY_CODE[marketplace].domain}/dp/B09XS7JWHH`,
    breakdown: {
      item: money(item, currency),
      shipping: money(shipping, currency),
      importFees: money(importFees, currency)
    },
    notes
  };
}

function failedResult(
  marketplace: Marketplace,
  status: Exclude<ComparisonStatus, "OK">,
  confidence: number,
  notes?: string[]
): ComparisonResult {
  return { marketplace, status, confidence, notes };
}

const source = sourceFor("US");

const baseline: ComparisonResult = {
  ...okResult("US", 399.99, 0, 0, 1),
  productUrl: source.sourceUrl,
  normalizedTotal: money(399.99, "USD")
};

const de = okResult("DE", 279.0, 12.99, 31.2, 0.91, [
  "Match confidence: HIGH",
  "Import fees deposit quoted on the product page. Delivery 6–10 days."
]);
const uk = okResult("UK", 259.0, 9.99, 24.6, 0.94, [
  "Match confidence: HIGH",
  "Import fees deposit quoted. Sold and shipped by Amazon UK."
]);
const it_ = okResult("IT", 289.9, 14.5, 30.2, 0.76, [
  "Match confidence: MEDIUM",
  "Colour is not stated in the listing title — confirm it is the black variant before buying."
]);
const ca = okResult("CA", 479.99, 12.99, 41.62, 0.97, ["Duties collected at checkout. Delivery 4–7 days."]);
const au = okResult("AU", 599.0, 19.95, 53.35, 0.88, ["GST included in the quoted import estimate."]);
const jp = failedResult("JP", "DESTINATION_MISMATCH", 0.93, [
  "Match found, but the seller does not ship to the United States."
]);
const fr = failedResult("FR", "UNAVAILABLE", 0.9, ["Out of stock — no delivery date offered."]);
const es = failedResult("ES", "PARSE_FAILED", 0.89, [
  "Import fees are only revealed at checkout, so the delivered total cannot be quoted."
]);
const mx = failedResult("MX", "NO_CONFIDENT_MATCH", 0.31, [
  "Closest listing scored 31% — below the confidence floor."
]);

const mockupResults: ComparisonResult[] = [ca, mx, uk, de, fr, it_, es, jp, au];

function codes(results: ComparisonResult[]): Marketplace[] {
  return results.map((result) => result.marketplace);
}

describe("DISPLAY_CURRENCIES", () => {
  it("matches the segmented control in the mockup", () => {
    expect([...DISPLAY_CURRENCIES]).toEqual(["USD", "EUR", "GBP", "JPY"]);
  });
});

describe("resolveDisplayCurrency", () => {
  it("uses the source marketplace currency when set to SOURCE", () => {
    expect(resolveDisplayCurrency("SOURCE", sourceFor("US"))).toBe("USD");
    expect(resolveDisplayCurrency("SOURCE", sourceFor("CA"))).toBe("CAD");
    expect(resolveDisplayCurrency("SOURCE", sourceFor("JP"))).toBe("JPY");
    expect(resolveDisplayCurrency("SOURCE", sourceFor("UK"))).toBe("GBP");
  });

  it("falls back to USD for SOURCE when the source is unknown", () => {
    expect(resolveDisplayCurrency("SOURCE")).toBe("USD");
    expect(resolveDisplayCurrency("SOURCE", undefined)).toBe("USD");
  });

  it("returns an explicit currency setting unchanged", () => {
    expect(resolveDisplayCurrency("EUR", sourceFor("US"))).toBe("EUR");
    expect(resolveDisplayCurrency("JPY")).toBe("JPY");
    expect(resolveDisplayCurrency("AUD", sourceFor("CA"))).toBe("AUD");
  });
});

describe("currencyChoices", () => {
  it("returns the four display currencies when there is no source", () => {
    expect(currencyChoices()).toEqual(["USD", "EUR", "GBP", "JPY"]);
  });

  it("returns a fresh array that does not alias DISPLAY_CURRENCIES", () => {
    const choices = currencyChoices();
    choices.push("CAD");
    expect([...DISPLAY_CURRENCIES]).toEqual(["USD", "EUR", "GBP", "JPY"]);
    expect(currencyChoices()).toEqual(["USD", "EUR", "GBP", "JPY"]);
  });

  it("keeps four choices when the source currency is already offered", () => {
    expect(currencyChoices(sourceFor("US"))).toEqual(["USD", "EUR", "GBP", "JPY"]);
  });

  it("moves an offered source currency to the front without duplicating it", () => {
    expect(currencyChoices(sourceFor("DE"))).toEqual(["EUR", "USD", "GBP", "JPY"]);
    expect(currencyChoices(sourceFor("UK"))).toEqual(["GBP", "USD", "EUR", "JPY"]);
    expect(currencyChoices(sourceFor("JP"))).toEqual(["JPY", "USD", "EUR", "GBP"]);
  });

  it("inserts a foreign source currency first, giving five choices", () => {
    expect(currencyChoices(sourceFor("CA"))).toEqual(["CAD", "USD", "EUR", "GBP", "JPY"]);
    expect(currencyChoices(sourceFor("AU"))).toEqual(["AUD", "USD", "EUR", "GBP", "JPY"]);
    expect(currencyChoices(sourceFor("MX"))).toEqual(["MXN", "USD", "EUR", "GBP", "JPY"]);
  });

  it.each(MARKETPLACE_CODES)("offers at most five unique choices led by the %s currency", (code) => {
    const choices = currencyChoices(sourceFor(code));
    expect(choices[0]).toBe(MARKETPLACE_BY_CODE[code].currency);
    expect(choices.length).toBeLessThanOrEqual(5);
    expect(new Set(choices).size).toBe(choices.length);
    for (const currency of DISPLAY_CURRENCIES) {
      expect(choices).toContain(currency);
    }
  });
});

describe("deliveredLocalTotal", () => {
  it("adds item, shipping and import fees exactly for the mockup markets", () => {
    expect(deliveredLocalTotal(de)).toEqual(money(323.19, "EUR"));
    expect(deliveredLocalTotal(uk)).toEqual(money(293.59, "GBP"));
    expect(deliveredLocalTotal(it_)).toEqual(money(334.6, "EUR"));
    expect(deliveredLocalTotal(ca)).toEqual(money(534.6, "CAD"));
    expect(deliveredLocalTotal(au)).toEqual(money(672.3, "AUD"));
    expect(deliveredLocalTotal(baseline)).toEqual(money(399.99, "USD"));
  });

  it("prefers the total Amazon displayed over the computed sum", () => {
    const result: ComparisonResult = {
      ...de,
      breakdown: { ...de.breakdown!, totalDisplayed: money(320.5, "EUR") }
    };
    expect(deliveredLocalTotal(result)).toEqual(money(320.5, "EUR"));
  });

  it("treats missing shipping and import fees as zero", () => {
    const result: ComparisonResult = {
      marketplace: "DE",
      status: "OK",
      confidence: 0.95,
      breakdown: { item: money(279, "EUR") }
    };
    expect(deliveredLocalTotal(result)).toEqual(money(279, "EUR"));

    const withShippingOnly: ComparisonResult = {
      ...result,
      breakdown: { item: money(279, "EUR"), shipping: money(12.99, "EUR") }
    };
    expect(deliveredLocalTotal(withShippingOnly)).toEqual(money(291.99, "EUR"));
  });

  it("sums yen amounts without introducing decimals", () => {
    expect(deliveredLocalTotal(okResult("JP", 52800, 1200, 0, 0.95))).toEqual(money(54000, "JPY"));
  });

  it("returns undefined when there is no breakdown", () => {
    expect(deliveredLocalTotal(jp)).toBeUndefined();
    expect(deliveredLocalTotal({ ...de, breakdown: undefined })).toBeUndefined();
  });
});

describe("displayTotal", () => {
  it("converts the delivered total into the display currency", () => {
    expect(displayTotal(de, "USD", fxTable)).toEqual(money(349.05, "USD"));
    expect(displayTotal(uk, "USD", fxTable)).toEqual(money(372.16, "USD"));
    expect(displayTotal(it_, "USD", fxTable)).toEqual(money(361.37, "USD"));
    expect(displayTotal(ca, "USD", fxTable)).toEqual(money(391.44, "USD"));
    expect(displayTotal(au, "USD", fxTable)).toEqual(money(438.72, "USD"));
    expect(displayTotal(de, "GBP", fxTable)).toEqual(money(275.36, "GBP"));
    expect(displayTotal(baseline, "EUR", fxTable)).toEqual(money(370.36, "EUR"));
  });

  it("returns the local total untouched when it is already in the display currency", () => {
    expect(displayTotal(de, "EUR", fxTable)).toEqual(money(323.19, "EUR"));
    expect(displayTotal(baseline, "USD", fxTable)).toEqual(money(399.99, "USD"));
  });

  it("does not need an FX table when no conversion is required", () => {
    expect(displayTotal(de, "EUR")).toEqual(money(323.19, "EUR"));
    expect(displayTotal(baseline, "USD")).toEqual(money(399.99, "USD"));
  });

  it("rounds yen totals to whole units", () => {
    expect(displayTotal(de, "JPY", fxTable)).toEqual(money(50263, "JPY"));
    expect(displayTotal(baseline, "JPY", fxTable)).toEqual(money(57599, "JPY"));
    expect(formatMoney(displayTotal(de, "JPY", fxTable))).toBe("¥50,263");
  });

  it("falls back to normalizedTotal when the FX table is missing and its currency matches", () => {
    const normalized = { ...de, normalizedTotal: money(349.05, "USD") };
    expect(displayTotal(normalized, "USD")).toEqual(money(349.05, "USD"));
    expect(displayTotal(normalized, "GBP")).toBeUndefined();
  });

  it("falls back to normalizedTotal when the FX table has no rate for the local currency", () => {
    const partialTable: FxTable = { ...fxTable, rates: { EUR: 1, USD: 1.08 } };
    expect(displayTotal({ ...ca, normalizedTotal: money(391.44, "USD") }, "USD", partialTable)).toEqual(
      money(391.44, "USD")
    );
    expect(displayTotal(ca, "USD", partialTable)).toBeUndefined();
  });

  it("uses normalizedTotal when there is no breakdown", () => {
    const result: ComparisonResult = {
      marketplace: "DE",
      status: "OK",
      confidence: 0.95,
      normalizedTotal: money(349.05, "USD")
    };
    expect(displayTotal(result, "USD", fxTable)).toEqual(money(349.05, "USD"));
    expect(displayTotal(result, "EUR", fxTable)).toBeUndefined();
  });

  it("returns undefined when nothing can be shown", () => {
    expect(displayTotal(jp, "USD", fxTable)).toBeUndefined();
    expect(displayTotal(de, "GBP")).toBeUndefined();
  });
});

describe("rankAvailable", () => {
  it("ranks the mockup results by delivered total in USD", () => {
    expect(codes(rankAvailable(mockupResults, "USD", fxTable))).toEqual(["DE", "IT", "UK", "CA", "AU"]);
  });

  it("keeps the same order in other display currencies", () => {
    expect(codes(rankAvailable(mockupResults, "JPY", fxTable))).toEqual(["DE", "IT", "UK", "CA", "AU"]);
    expect(codes(rankAvailable(mockupResults, "EUR", fxTable))).toEqual(["DE", "IT", "UK", "CA", "AU"]);
  });

  it("drops failed results and OK results without a displayable total", () => {
    const noTotal: ComparisonResult = { marketplace: "FR", status: "OK", confidence: 0.95 };
    const ranked = rankAvailable([noTotal, jp, de, mx], "USD", fxTable);
    expect(codes(ranked)).toEqual(["DE"]);
  });

  it("breaks ties by marketplace code", () => {
    const frSame = okResult("FR", 279.0, 12.99, 31.2, 0.95);
    const esSame = okResult("ES", 279.0, 12.99, 31.2, 0.95);
    expect(codes(rankAvailable([frSame, de, esSame], "USD", fxTable))).toEqual(["DE", "ES", "FR"]);
    expect(codes(rankAvailable([esSame, frSame, de], "EUR"))).toEqual(["DE", "ES", "FR"]);
  });

  it("does not mutate its input", () => {
    const input = [...mockupResults];
    rankAvailable(input, "USD", fxTable);
    expect(input).toEqual(mockupResults);
  });

  it("returns an empty list when nothing is available", () => {
    expect(rankAvailable([], "USD", fxTable)).toEqual([]);
    expect(rankAvailable([jp, fr, es, mx], "USD", fxTable)).toEqual([]);
  });
});

describe("issues", () => {
  it("returns every non-OK result in input order, including no-confident-match", () => {
    expect(codes(issues(mockupResults))).toEqual(["MX", "FR", "ES", "JP"]);
  });

  it("returns an empty list when every marketplace was compared", () => {
    expect(issues([de, uk, it_])).toEqual([]);
  });
});

describe("needsMatchCheck", () => {
  it("flags an OK match below 90% confidence", () => {
    expect(needsMatchCheck(it_)).toBe(true);
    expect(needsMatchCheck(au)).toBe(true);
  });

  it("does not flag confident matches, including exactly 90%", () => {
    expect(needsMatchCheck(de)).toBe(false);
    expect(needsMatchCheck(uk)).toBe(false);
    expect(needsMatchCheck({ ...de, confidence: 0.9 })).toBe(false);
  });

  it("never flags results that are not OK", () => {
    expect(needsMatchCheck(mx)).toBe(false);
    expect(needsMatchCheck(es)).toBe(false);
  });
});

describe("computeVerdict", () => {
  it("tells the user to buy from Germany and save $50.94 on the mockup run", () => {
    const verdict = computeVerdict(baseline, mockupResults, "USD", fxTable);
    expect(verdict.kind).toBe("save");
    if (verdict.kind !== "save") {
      throw new Error("expected a save verdict");
    }
    expect(verdict.best).toBe(de);
    expect(verdict.bestTotal).toEqual(money(349.05, "USD"));
    expect(verdict.baselineTotal).toEqual(money(399.99, "USD"));
    expect(verdict.saving).toEqual(money(50.94, "USD"));
    expect(verdict.percent).toBeCloseTo(12.7353, 3);
    expect(formatMoney(verdict.saving)).toBe("$50.94");
    expect(formatMoney(verdict.bestTotal)).toBe("$349.05");
    expect(percentFormat(verdict.percent)).toBe("13");
  });

  it("states the saving in euros and pounds", () => {
    const inEuros = computeVerdict(baseline, mockupResults, "EUR", fxTable);
    expect(inEuros).toMatchObject({
      kind: "save",
      bestTotal: money(323.19, "EUR"),
      baselineTotal: money(370.36, "EUR"),
      saving: money(47.17, "EUR")
    });

    const inPounds = computeVerdict(baseline, mockupResults, "GBP", fxTable);
    expect(inPounds).toMatchObject({
      kind: "save",
      bestTotal: money(275.36, "GBP"),
      baselineTotal: money(315.55, "GBP"),
      saving: money(40.19, "GBP")
    });
  });

  it("states the saving in whole yen", () => {
    const verdict = computeVerdict(baseline, mockupResults, "JPY", fxTable);
    expect(verdict).toMatchObject({
      kind: "save",
      bestTotal: money(50263, "JPY"),
      baselineTotal: money(57599, "JPY"),
      saving: money(7336, "JPY")
    });
    if (verdict.kind !== "save") {
      throw new Error("expected a save verdict");
    }
    expect(formatMoney(verdict.saving)).toBe("¥7,336");
    expect(percentFormat(verdict.percent)).toBe("13");
  });

  it("says stay here when nothing beats the page price", () => {
    const cheapBaseline = { ...baseline, breakdown: { item: money(299.99, "USD") }, normalizedTotal: undefined };
    expect(computeVerdict(cheapBaseline, mockupResults, "USD", fxTable)).toEqual({
      kind: "stay",
      baselineTotal: money(299.99, "USD")
    });
  });

  it("says stay here when the best marketplace only ties the page price", () => {
    const tiedBaseline = { ...baseline, breakdown: { item: money(349.05, "USD") }, normalizedTotal: undefined };
    expect(computeVerdict(tiedBaseline, mockupResults, "USD", fxTable)).toEqual({
      kind: "stay",
      baselineTotal: money(349.05, "USD")
    });
  });

  it("names the cheapest marketplace when the page price could not be read", () => {
    expect(computeVerdict(undefined, mockupResults, "USD", fxTable)).toEqual({
      kind: "cheapest",
      best: de,
      bestTotal: money(349.05, "USD")
    });
  });

  it("names the cheapest marketplace when the baseline has no usable total", () => {
    const unreadable: ComparisonResult = { marketplace: "US", status: "OK", confidence: 1 };
    expect(computeVerdict(unreadable, mockupResults, "USD", fxTable)).toMatchObject({ kind: "cheapest", best: de });
    const failedBaseline: ComparisonResult = { ...baseline, status: "PARSE_FAILED" };
    expect(computeVerdict(failedBaseline, mockupResults, "USD", fxTable)).toMatchObject({
      kind: "cheapest",
      best: de
    });
  });

  it("reports no delivered price when no marketplace is available", () => {
    expect(computeVerdict(baseline, [jp, fr, es, mx], "USD", fxTable)).toEqual({ kind: "none" });
    expect(computeVerdict(undefined, [jp, fr], "USD", fxTable)).toEqual({ kind: "none" });
    expect(computeVerdict(undefined, [], "USD")).toEqual({ kind: "none" });
  });

  it("ignores a result for the source marketplace itself", () => {
    const sourceDuplicate = okResult("US", 100, 0, 0, 1);
    const verdict = computeVerdict(baseline, [sourceDuplicate, de], "USD", fxTable);
    expect(verdict).toMatchObject({ kind: "save", best: de });
  });

  it("uses normalizedTotal when the FX table is unavailable", () => {
    const normalizedDe = { ...de, normalizedTotal: money(349.05, "USD") };
    expect(computeVerdict(baseline, [normalizedDe, uk], "USD")).toMatchObject({
      kind: "save",
      best: normalizedDe,
      saving: money(50.94, "USD")
    });
  });
});

describe("rankedRows", () => {
  it("lists the source row among available rows sorted by delivered total", () => {
    const rows = rankedRows(baseline, mockupResults, "USD", fxTable);
    expect(rows.map((row) => row.result.marketplace)).toEqual(["DE", "IT", "UK", "CA", "US", "AU"]);
    expect(rows.map((row) => row.total.amount)).toEqual([349.05, 361.37, 372.16, 391.44, 399.99, 438.72]);
    expect(rows.map((row) => row.delta?.amount)).toEqual([-50.94, -38.62, -27.83, -8.55, 0, 38.73]);
    expect(rows.map((row) => row.isSource)).toEqual([false, false, false, false, true, false]);
    expect(rows.map((row) => row.isBest)).toEqual([true, false, false, false, false, false]);
    expect(rows[4].result).toBe(baseline);
  });

  it("produces the mockup delta copy and colours", () => {
    const deltas = rankedRows(baseline, mockupResults, "USD", fxTable).map((row) =>
      formatDelta(row.delta, row.isSource)
    );
    expect(deltas).toEqual([
      { text: `${MINUS}$50.94`, cls: "down" },
      { text: `${MINUS}$38.62`, cls: "down" },
      { text: `${MINUS}$27.83`, cls: "down" },
      { text: `${MINUS}$8.55`, cls: "down" },
      { text: "the page you are on", cls: "flat" },
      { text: "+$38.73", cls: "up" }
    ]);
  });

  it("expresses totals and deltas in whole yen", () => {
    const rows = rankedRows(baseline, mockupResults, "JPY", fxTable);
    expect(rows[0].total).toEqual(money(50263, "JPY"));
    expect(rows[0].delta).toEqual(money(-7336, "JPY"));
    expect(formatDelta(rows[0].delta, false)).toEqual({ text: `${MINUS}¥7,336`, cls: "down" });
    expect(rows.every((row) => Number.isInteger(row.total.amount))).toBe(true);
    expect(rows.every((row) => Number.isInteger(row.delta?.amount))).toBe(true);
  });

  it("omits the source row and deltas when there is no baseline", () => {
    const rows = rankedRows(undefined, mockupResults, "USD", fxTable);
    expect(rows.map((row) => row.result.marketplace)).toEqual(["DE", "IT", "UK", "CA", "AU"]);
    expect(rows.every((row) => row.delta === undefined && !row.isSource)).toBe(true);
    expect(rows.map((row) => row.isBest)).toEqual([true, false, false, false, false]);
    expect(formatDelta(rows[0].delta, rows[0].isSource)).toEqual({ text: "", cls: "flat" });
  });

  it("marks the source row as best when the verdict is stay here", () => {
    const cheapBaseline = { ...baseline, breakdown: { item: money(299.99, "USD") }, normalizedTotal: undefined };
    const rows = rankedRows(cheapBaseline, mockupResults, "USD", fxTable);
    expect(rows[0]).toMatchObject({ isSource: true, isBest: true, total: money(299.99, "USD") });
    expect(rows.slice(1).every((row) => !row.isBest && (row.delta?.amount ?? 0) > 0)).toBe(true);
    expect(formatDelta(rows[1].delta, rows[1].isSource)).toEqual({ text: "+$49.06", cls: "up" });
  });

  it("puts the source row first on a tie and shows the tied marketplace as same price", () => {
    const tiedBaseline = { ...baseline, breakdown: { item: money(349.05, "USD") }, normalizedTotal: undefined };
    const rows = rankedRows(tiedBaseline, [de, uk], "USD", fxTable);
    expect(rows.map((row) => row.result.marketplace)).toEqual(["US", "DE", "UK"]);
    expect(rows[0]).toMatchObject({ isSource: true, isBest: true });
    expect(rows[1]).toMatchObject({ isSource: false, isBest: false, delta: money(0, "USD") });
    expect(formatDelta(rows[1].delta, rows[1].isSource)).toEqual({ text: "same price", cls: "flat" });
  });

  it("breaks ties between marketplaces by code", () => {
    const frSame = okResult("FR", 279.0, 12.99, 31.2, 0.95);
    const rows = rankedRows(baseline, [frSame, de], "USD", fxTable);
    expect(rows.map((row) => row.result.marketplace)).toEqual(["DE", "FR", "US"]);
    expect(rows.map((row) => row.isBest)).toEqual([true, false, false]);
  });

  it("shows only the source row when no marketplace is available", () => {
    const rows = rankedRows(baseline, [jp, fr, es, mx], "USD", fxTable);
    expect(rows).toEqual([
      { result: baseline, total: money(399.99, "USD"), delta: money(0, "USD"), isSource: true, isBest: false }
    ]);
  });

  it("returns no rows when there is neither a baseline nor an available result", () => {
    expect(rankedRows(undefined, [jp, mx], "USD", fxTable)).toEqual([]);
  });
});

describe("formatDelta", () => {
  it("formats savings with a true minus sign", () => {
    const delta = formatDelta(money(-12.34, "USD"), false);
    expect(delta).toEqual({ text: "−$12.34", cls: "down" });
    expect(delta.text.startsWith("-")).toBe(false);
  });

  it("formats extra cost with a plus sign", () => {
    expect(formatDelta(money(12.34, "USD"), false)).toEqual({ text: "+$12.34", cls: "up" });
  });

  it("labels the source row regardless of delta", () => {
    expect(formatDelta(money(0, "USD"), true)).toEqual({ text: "the page you are on", cls: "flat" });
    expect(formatDelta(undefined, true)).toEqual({ text: "the page you are on", cls: "flat" });
  });

  it("returns empty flat text when there is no baseline", () => {
    expect(formatDelta(undefined, false)).toEqual({ text: "", cls: "flat" });
  });

  it("calls a zero delta the same price", () => {
    expect(formatDelta(money(0, "USD"), false)).toEqual({ text: "same price", cls: "flat" });
  });

  it("formats yen without decimals", () => {
    expect(formatDelta(money(-7336, "JPY"), false)).toEqual({ text: `${MINUS}¥7,336`, cls: "down" });
    expect(formatDelta(money(1250, "JPY"), false)).toEqual({ text: "+¥1,250", cls: "up" });
  });

  it("honours the locale argument", () => {
    expect(formatDelta(money(-12.34, "EUR"), false, "de-DE")).toEqual({
      text: `${MINUS}12,34${NBSP}€`,
      cls: "down"
    });
  });
});

describe("statusText", () => {
  it.each<[ComparisonStatus, string]>([
    ["OK", "Available"],
    ["UNAVAILABLE", "Delivered total not quotable"],
    ["DESTINATION_MISMATCH", "Does not ship here"],
    ["PARSE_FAILED", "Could not read the page"],
    ["NO_CONFIDENT_MATCH", "No confident match"]
  ])("maps %s to %s", (status, text) => {
    expect(statusText(status)).toBe(text);
  });
});

describe("issueNote", () => {
  it("returns the result notes as written", () => {
    expect(issueNote(jp, "US")).toBe("Match found, but the seller does not ship to the United States.");
    expect(issueNote(fr)).toBe("Out of stock — no delivery date offered.");
    expect(issueNote(mx)).toBe("Closest listing scored 31% — below the confidence floor.");
  });

  it("joins several notes into sentences and drops the match confidence label", () => {
    const demoted: ComparisonResult = {
      marketplace: "CA",
      status: "UNAVAILABLE",
      confidence: 0.92,
      notes: ["Match confidence: HIGH", "Shipping not displayed for destination", "  ", "Missing FX conversion path to USD"]
    };
    expect(issueNote(demoted)).toBe("Shipping not displayed for destination. Missing FX conversion path to USD.");
  });

  it("falls back to a per-status sentence when there are no notes", () => {
    expect(issueNote(failedResult("JP", "DESTINATION_MISMATCH", 0.93), "US")).toBe(
      "Match found, but the seller does not ship to United States."
    );
    expect(issueNote(failedResult("JP", "DESTINATION_MISMATCH", 0.93, []), "DE")).toBe(
      "Match found, but the seller does not ship to Germany."
    );
    expect(issueNote(failedResult("FR", "UNAVAILABLE", 0.9))).toBe(
      "Amazon did not show a delivered price for this destination."
    );
    expect(issueNote(failedResult("ES", "PARSE_FAILED", 0.89, [" "]))).toBe("The product page could not be read.");
    expect(issueNote(failedResult("MX", "NO_CONFIDENT_MATCH", 0.31, ["Match confidence: LOW"]))).toBe(
      "No listing scored above the confidence floor."
    );
  });

  it("uses a generic destination when the country is unknown", () => {
    expect(issueNote(failedResult("JP", "DESTINATION_MISMATCH", 0.93))).toBe(
      "Match found, but the seller does not ship to your address."
    );
  });

  it("returns an empty note for an OK result without notes", () => {
    expect(issueNote({ ...de, notes: undefined })).toBe("");
  });
});

describe("phaseLabel", () => {
  it("maps each phase to the mockup copy", () => {
    expect(phaseLabel("OPEN")).toBe("Opening tab");
    expect(phaseLabel("SEARCH")).toBe("Searching");
    expect(phaseLabel("MATCH")).toBe("Matching product");
    expect(phaseLabel("READ")).toBe("Reading cost stack");
  });

  it("defaults to opening a tab before the first phase arrives", () => {
    expect(phaseLabel()).toBe("Opening tab");
    expect(phaseLabel(undefined)).toBe("Opening tab");
  });
});

describe("trustSentence", () => {
  it("warns on a low-confidence match", () => {
    expect(trustSentence(it_)).toBe(
      "We are 76% sure this is the same product. Colour is not stated in the listing title — confirm it is the black variant before buying."
    );
  });

  it("reassures on a confident match", () => {
    expect(trustSentence(uk)).toBe(
      "We are 94% sure this is the same product — title, brand and variant all line up. Import fees deposit quoted. Sold and shipped by Amazon UK."
    );
    expect(trustSentence(de)).toBe(
      "We are 91% sure this is the same product — title, brand and variant all line up. Import fees deposit quoted on the product page. Delivery 6–10 days."
    );
  });

  it("omits the trailing note when there is none", () => {
    expect(trustSentence(baseline)).toBe(
      "We are 100% sure this is the same product — title, brand and variant all line up."
    );
    expect(trustSentence({ ...it_, notes: ["Match confidence: MEDIUM"] })).toBe(
      "We are 76% sure this is the same product."
    );
  });

  it("rounds the confidence to a whole percent", () => {
    expect(trustSentence({ ...au, confidence: 0.876, notes: [] })).toBe("We are 88% sure this is the same product.");
    expect(trustSentence({ ...de, confidence: 0.934, notes: [] })).toBe(
      "We are 93% sure this is the same product — title, brand and variant all line up."
    );
  });
});

describe("estimatedSeconds", () => {
  it("allows three seconds per marketplace", () => {
    expect(estimatedSeconds(9)).toBe(27);
    expect(estimatedSeconds(4)).toBe(12);
  });

  it("never promises less than five seconds", () => {
    expect(estimatedSeconds(1)).toBe(5);
    expect(estimatedSeconds(0)).toBe(5);
  });
});

describe("targetMarkets", () => {
  const allEnabled: ExtensionSettings = {
    enabledMarketplaces: [...MARKETPLACE_CODES],
    comparisonCurrency: "SOURCE",
    disclosureAcknowledged: false
  };

  it("checks every enabled marketplace except the one the user is on", () => {
    expect(targetMarkets(allEnabled, source)).toEqual(["CA", "MX", "UK", "DE", "FR", "IT", "ES", "JP", "AU"]);
    expect(targetMarkets(allEnabled, source)).toHaveLength(9);
  });

  it("keeps every enabled marketplace when the source is unknown", () => {
    expect(targetMarkets(allEnabled)).toEqual([...MARKETPLACE_CODES]);
  });

  it("preserves the settings order and ignores a disabled source", () => {
    const settings: ExtensionSettings = { ...allEnabled, enabledMarketplaces: ["UK", "DE", "CA"] };
    expect(targetMarkets(settings, source)).toEqual(["UK", "DE", "CA"]);
    expect(targetMarkets(settings, sourceFor("DE"))).toEqual(["UK", "CA"]);
  });

  it("returns no targets when only the source is enabled", () => {
    expect(targetMarkets({ ...allEnabled, enabledMarketplaces: ["US"] }, source)).toEqual([]);
    expect(targetMarkets({ ...allEnabled, enabledMarketplaces: [] }, source)).toEqual([]);
  });
});

describe("percentFormat", () => {
  it("rounds to a whole number without a sign", () => {
    expect(percentFormat(12.7353)).toBe("13");
    expect(percentFormat(12.4)).toBe("12");
    expect(percentFormat(0.4)).toBe("0");
    expect(percentFormat(100)).toBe("100");
    expect(percentFormat(-12.7)).toBe("13");
  });

  it("guards against non-finite input", () => {
    expect(percentFormat(Number.NaN)).toBe("0");
    expect(percentFormat(Number.POSITIVE_INFINITY)).toBe("0");
  });
});

describe("progressPercent", () => {
  it("rounds completed over total to a whole percent", () => {
    expect(progressPercent(0, 9)).toBe(0);
    expect(progressPercent(3, 9)).toBe(33);
    expect(progressPercent(5, 9)).toBe(56);
    expect(progressPercent(9, 9)).toBe(100);
  });

  it("stays within 0 to 100", () => {
    expect(progressPercent(0, 0)).toBe(0);
    expect(progressPercent(12, 9)).toBe(100);
    expect(progressPercent(-1, 9)).toBe(0);
  });
});

describe("checkLabel", () => {
  it("pluralises the run button", () => {
    expect(checkLabel(9)).toBe("Check 9 other Amazons");
    expect(checkLabel(2)).toBe("Check 2 other Amazons");
    expect(checkLabel(0)).toBe("Check 0 other Amazons");
  });

  it("uses the singular for one marketplace", () => {
    expect(checkLabel(1)).toBe("Check 1 other Amazon");
  });
});

describe("issuesLabel", () => {
  it("pluralises the accordion summary", () => {
    expect(issuesLabel(issues(mockupResults).length)).toBe("4 marketplaces could not be compared");
    expect(issuesLabel(2)).toBe("2 marketplaces could not be compared");
  });

  it("uses the singular for one marketplace", () => {
    expect(issuesLabel(1)).toBe("1 marketplace could not be compared");
  });
});

describe("formatLocal", () => {
  it("formats delivered totals in each marketplace's own locale", () => {
    expect(formatLocal(deliveredLocalTotal(de)!, "DE")).toBe(`323,19${NBSP}€`);
    expect(formatLocal(deliveredLocalTotal(it_)!, "IT")).toBe(`334,60${NBSP}€`);
    expect(formatLocal(deliveredLocalTotal(uk)!, "UK")).toBe("£293.59");
    expect(formatLocal(deliveredLocalTotal(ca)!, "CA")).toBe("$534.60");
    expect(formatLocal(deliveredLocalTotal(au)!, "AU")).toBe("$672.30");
    expect(formatLocal(deliveredLocalTotal(baseline)!, "US")).toBe("$399.99");
  });

  it("formats yen without decimals", () => {
    expect(formatLocal(money(54000, "JPY"), "JP")).toMatch(/^[¥￥]54,000$/);
  });
});

describe("formatVariantTokens", () => {
  it("capitalises each extracted token and joins them with a middle dot", () => {
    expect(formatVariantTokens(["black", "2 pack", "x100"])).toBe("Black · 2 pack · X100");
  });

  it("returns an empty string for no tokens", () => {
    expect(formatVariantTokens([])).toBe("");
  });
});
