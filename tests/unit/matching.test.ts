import { describe, expect, it } from "vitest";
import {
  computeMatchScore,
  extractVariationTokens,
  normalizeText,
  pickBestCandidate,
  sharesSourceAsin,
  tokenizeTitle
} from "../../src/shared/matching";
import type { SearchCandidate, SourceContext } from "../../src/shared/types";

describe("matching helpers", () => {
  it("normalizes text for latin and japanese scripts", () => {
    expect(normalizeText("Crème BRÛLÉE  2-Pack!!")).toBe("creme brulee 2 pack");
    expect(normalizeText("高品質 モデルX100")).toContain("高品質");
  });

  it("tokenizes titles with stopwords removed", () => {
    const englishTokens = tokenizeTitle("The Acme Widget for Home and Office", "US");
    expect(englishTokens).toEqual(["acme", "widget", "home", "office"]);

    const japaneseTokens = tokenizeTitle("高品質 の ウィジェット 向け 家庭", "JP");
    expect(japaneseTokens).toContain("高品質");
    expect(japaneseTokens.length).toBeGreaterThan(1);
  });

  it("extracts variation tokens from model and pack strings", () => {
    const tokens = extractVariationTokens("Model X100 2 pack 16 oz blue");
    expect(tokens).toContain("x100");
    expect(tokens).toContain("2 pack");
    expect(tokens).toContain("16 oz");
    expect(tokens).toContain("blue");
  });

  it("scores close candidates above the conservative threshold", () => {
    const source: SourceContext = {
      marketplace: "US",
      asin: "B00TEST000",
      title: "Acme Ultra Widget Model X100 2 Pack Blue",
      brand: "Acme",
      variationTokens: ["x100", "2 pack", "blue"],
      destinationCountryCode: "US",
      sourceUrl: "https://www.amazon.com/dp/B00TEST000"
    };

    const strongCandidate = {
      marketplace: "UK" as const,
      title: "Acme Ultra Widget Model X100 2 Pack Blue",
      brand: "Acme",
      url: "https://www.amazon.co.uk/dp/B00TEST000"
    };

    const weakCandidate = {
      marketplace: "UK" as const,
      title: "Generic Replacement Parts Basic Bundle",
      brand: "Generic",
      url: "https://www.amazon.co.uk/dp/B00OTHER00"
    };

    const strongScore = computeMatchScore(source, strongCandidate);
    const weakScore = computeMatchScore(source, weakCandidate);

    expect(strongScore.total).toBeGreaterThanOrEqual(0.78);
    expect(weakScore.total).toBeLessThan(0.78);

    const best = pickBestCandidate(source, [weakCandidate, strongCandidate]);
    expect(best?.candidate.url).toBe(strongCandidate.url);
  });
});

const SONY_SOURCE: SourceContext = {
  marketplace: "US",
  asin: "B09XS7JWHH",
  title: "Sony WH-1000XM5 Premium Noise Cancelling Wireless Headphones, Black",
  brand: "Sony",
  variationTokens: [],
  destinationCountryCode: "US",
  sourceUrl: "https://www.amazon.com/dp/B09XS7JWHH"
};

const ACME_SOURCE: SourceContext = {
  marketplace: "US",
  asin: "B000000001",
  title: "Acme Ultra Widget Model X100 2 Pack Blue",
  brand: "Acme",
  variationTokens: ["x100", "2 pack", "blue"],
  destinationCountryCode: "US",
  sourceUrl: "https://www.amazon.com/dp/B000000001"
};

const JAPANESE_SONY_TITLE = "ソニー ワイヤレスノイズキャンセリングヘッドホン WH-1000XM5 ブラック";

function listing(overrides: Partial<SearchCandidate>): SearchCandidate {
  return {
    marketplace: "UK",
    title: "Acme Ultra Widget Model X100 2 Pack Blue",
    url: "https://www.amazon.co.uk/dp/B0LISTING1",
    ...overrides
  };
}

describe("ASIN identity", () => {
  it("scores a listing in another language with the source ASIN as a confident match and still reports its part scores", () => {
    const japanese = listing({ marketplace: "JP", title: JAPANESE_SONY_TITLE, url: "https://www.amazon.co.jp/dp/B09XS7JWHH" });
    const byTitle = computeMatchScore(SONY_SOURCE, japanese);

    const score = computeMatchScore(SONY_SOURCE, { ...japanese, asin: "b09xs7jwhh" });

    expect(byTitle.total).toBeLessThan(0.78);
    expect(byTitle.titleScore).toBeGreaterThan(0);
    expect(score).toEqual({
      total: 1,
      titleScore: byTitle.titleScore,
      brandScore: byTitle.brandScore,
      variationScore: byTitle.variationScore,
      confidenceLabel: "HIGH"
    });
  });

  it("lets the listing with the source ASIN beat a listing with a closer title", () => {
    const sameTitle = listing({ asin: "B0OTHER001", title: SONY_SOURCE.title, brand: "Sony" });
    const sameAsin = listing({ marketplace: "JP", asin: "B09XS7JWHH", title: JAPANESE_SONY_TITLE });

    expect(pickBestCandidate(SONY_SOURCE, [sameTitle, sameAsin])?.candidate).toBe(sameAsin);
  });

  it("prefers the listing with the source ASIN when two listings score the same", () => {
    const exactTitle = listing({ asin: "B0OTHER001", brand: "Acme" });
    const sameAsin = listing({ asin: "B000000001", brand: "Acme" });

    expect(computeMatchScore(ACME_SOURCE, exactTitle).total).toBe(1);
    expect(pickBestCandidate(ACME_SOURCE, [exactTitle, sameAsin])?.candidate).toBe(sameAsin);
  });

  it("does not trust an ASIN shared by a listing with nothing in common with the source title", () => {
    const hose = listing({ asin: "B000000001", title: "Garden Hose Reel Wall Mounted", brand: "Acme" });

    expect(sharesSourceAsin(ACME_SOURCE, hose)).toBe(false);
    expect(computeMatchScore(ACME_SOURCE, hose).total).toBeLessThan(0.78);
    expect(pickBestCandidate(ACME_SOURCE, [hose])).toBeUndefined();
  });

  it("scores a listing with another ASIN exactly like a listing without one", () => {
    const candidate = listing({ title: "Acme Ultra Widget Model X100 Blue", brand: "Acme" });

    expect(computeMatchScore(ACME_SOURCE, { ...candidate, asin: "B0OTHER001" })).toEqual(computeMatchScore(ACME_SOURCE, candidate));
  });

  it.each([
    ["the same ASIN in another case with surrounding space", " b000000001 ", "Acme Widget", true],
    ["a different ASIN", "B000000002", "Acme Ultra Widget Model X100 2 Pack Blue", false],
    ["no ASIN", undefined, "Acme Ultra Widget Model X100 2 Pack Blue", false],
    ["no title", "B000000001", "", false]
  ] as const)("decides a listing with %s shares the source ASIN: %s", (_case, asin, title, expected) => {
    expect(sharesSourceAsin(ACME_SOURCE, { marketplace: "DE", asin, title })).toBe(expected);
  });
});
