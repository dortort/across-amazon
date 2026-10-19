import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { extractSearchCandidates } from "../../src/content/search-extractor";
import {
  computeMatchScore,
  extractAttributeTokens,
  extractModelTokens,
  extractVariationTokens,
  normalizeText,
  pickBestCandidate,
  sharesSourceAsin,
  tokenizeTitle
} from "../../src/shared/matching";
import type { Marketplace, SearchCandidate, SourceContext } from "../../src/shared/types";

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

describe("model numbers", () => {
  it.each([
    ["Sony WH-1000XM5 Premium Noise Cancelling Wireless Headphones", ["wh1000xm5", "1000xm5"]],
    ["Sony WH1000XM5", ["wh1000xm5"]],
    ["ソニー WH-1000XM5 ブラック", ["wh1000xm5", "1000xm5"]],
    ["Model X100 2 pack 16 oz blue USB-C 4K", ["x100"]],
    ["Hinge Repair Kit for Sony WH-1000XM5(XM5)", ["wh1000xm5", "1000xm5", "xm5"]],
    ["Wireless headphones, 30 hours, over-ear", []]
  ])("reads the model numbers in %s", (title, expected) => {
    expect(extractModelTokens(title)).toEqual(expected);
  });

  it("keeps model numbers out of the attribute tokens and puts both in the variation tokens", () => {
    expect(extractAttributeTokens("Sony WH-1000XM5 2 Pack 16 oz Black")).toEqual(["2 pack", "16 oz", "black"]);
    expect(extractVariationTokens("Sony WH-1000XM5 2 Pack 16 oz Black")).toEqual(["wh1000xm5", "1000xm5", "2 pack", "16 oz", "black"]);
  });
});

describe("scoring without every signal on the source page", () => {
  const sony = (overrides: Partial<SearchCandidate>): SearchCandidate =>
    listing({ title: SONY_SOURCE.title, brand: "Sony", url: "https://www.amazon.co.uk/dp/B0LISTING1", ...overrides });

  it("scores an identical listing 1 when the source page has no variant selectors", () => {
    expect(computeMatchScore(SONY_SOURCE, sony({})).total).toBe(1);
  });

  it("rejects another colour of the same headphones by the colour in the title", () => {
    const silver = sony({ title: "Sony WH-1000XM5 Premium Noise Cancelling Wireless Headphones, Silver" });

    expect(computeMatchScore(SONY_SOURCE, silver).total).toBe(0.61);
    expect(pickBestCandidate(SONY_SOURCE, [silver])).toBeUndefined();
  });

  it("caps a listing with a different model number at 0.5", () => {
    expect(computeMatchScore(SONY_SOURCE, sony({ title: "Sony WH-1000XM4 Premium Noise Cancelling Wireless Headphones, Black" })).total).toBe(
      0.5
    );
  });

  it("rejects an accessory made for the same model", () => {
    const earPads = sony({ title: "Ear Pads Replacement for Sony WH-1000XM5 Headphones, Black", brand: "Generic" });

    expect(computeMatchScore(SONY_SOURCE, earPads).total).toBeLessThan(0.78);
  });

  it("drops the brand from the score when the source page has none", () => {
    expect(computeMatchScore({ ...SONY_SOURCE, brand: undefined }, sony({})).total).toBe(1);
  });

  it("keeps a label read as the brand from reaching the threshold, as the old source extractor did", () => {
    expect(computeMatchScore({ ...SONY_SOURCE, brand: "Brand" }, sony({})).total).toBe(0.75);
  });

  it("credits a listing without a brand whose title names the source brand", () => {
    expect(computeMatchScore(SONY_SOURCE, sony({ brand: undefined })).total).toBe(0.9375);
  });

  it("gives no brand credit to a listing without a brand whose title does not name it", () => {
    const unbranded = sony({ brand: undefined, title: "WH-1000XM5 Premium Noise Cancelling Wireless Headphones, Black" });

    expect(computeMatchScore(SONY_SOURCE, unbranded).total).toBeLessThan(0.78);
  });

  it("scores the fixture listings by title, brand and the variant tokens from both the selectors and the title", () => {
    const source: SourceContext = { ...ACME_SOURCE, variationTokens: ["2 pack", "16 oz", "blue"] };

    expect(computeMatchScore(source, listing({ brand: "Acme" }))).toMatchObject({ total: 0.9, confidenceLabel: "HIGH" });
    expect(computeMatchScore(source, listing({ title: "Acme Basic Widget Model Z10 1 Pack" }))).toMatchObject({
      total: 0.3875,
      confidenceLabel: "LOW"
    });
  });
});

describe("matching the current amazon search results", () => {
  const HOSTS: Partial<Record<Marketplace, string>> = {
    CA: "www.amazon.ca",
    MX: "www.amazon.com.mx",
    UK: "www.amazon.co.uk",
    DE: "www.amazon.de",
    FR: "www.amazon.fr",
    JP: "www.amazon.co.jp"
  };

  function liveCandidates(market: Marketplace): SearchCandidate[] {
    const html = readFileSync(join(process.cwd(), "tests", "fixtures", "search-live", `${market}.html`), "utf8");
    const dom = new JSDOM(html, { url: `https://${HOSTS[market]}/s?k=Sony+WH-1000XM5+Black` });
    return extractSearchCandidates(dom.window.document, { marketplace: market, limit: 8 }, dom.window.location.origin);
  }

  it.each(["CA", "MX"] as const)("picks the source ASIN on %s", (market) => {
    expect(pickBestCandidate(SONY_SOURCE, liveCandidates(market))).toMatchObject({
      candidate: { asin: "B09XS7JWHH" },
      score: { total: 1, confidenceLabel: "HIGH" }
    });
  });

  it.each(["UK", "DE", "FR", "JP"] as const)(
    "picks nothing on %s, where only other colours, models, bundles and accessories are listed",
    (market) => {
      expect(pickBestCandidate(SONY_SOURCE, liveCandidates(market))).toBeUndefined();
    }
  );
});
