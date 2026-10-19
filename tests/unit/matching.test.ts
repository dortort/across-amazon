import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { extractSearchCandidates } from "../../src/content/search-extractor";
import {
  computeMatchScore,
  extractAttributeTokens,
  findSourceVariant,
  extractModelTokens,
  extractVariationTokens,
  normalizeText,
  pickBestCandidate,
  sharesSourceAsin,
  tokenizeTitle,
  variantConflicts
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

  it("scores a listing whose title names no colour on its title and brand alone", () => {
    const colourless = sony({ asin: "B09Y2MYL5C", title: "WH-1000XM5 Premium Wireless Noise Cancelling Headphones" });

    expect(computeMatchScore({ ...SONY_SOURCE, variationTokens: ["black"] }, colourless)).toMatchObject({
      total: 0.8571,
      variationScore: 0,
      confidenceLabel: "MEDIUM"
    });
  });

  it("picks a colourless WH-1000XM5 card over black WF-1000XM5 earbuds, as amazon.es lists them", () => {
    const blackSource: SourceContext = { ...SONY_SOURCE, variationTokens: ["black"] };
    const cards = [
      sony({ asin: "B0C4TLFZSZ", title: "WF-1000XM5 Wireless Noise Cancelling Headphones Black" }),
      sony({ asin: "B0BXM22X99", title: "WH-1000XM5 Premium Wireless Noise Cancelling Headphones" }),
      sony({ asin: "B09Y2MYL5C", title: "WH-1000XM5 Premium Wireless Noise Cancelling Headphones" })
    ];

    expect(pickBestCandidate(blackSource, cards)).toMatchObject({ candidate: { asin: "B0BXM22X99" }, score: { total: 0.8571 } });
  });

  it("caps earbuds whose model number differs from the headphones' only in its prefix at 0.5", () => {
    const blackSource: SourceContext = { ...SONY_SOURCE, variationTokens: ["black"] };
    const earbuds = sony({ asin: "B0C4TLFZSZ", title: "WF-1000XM5 Wireless Noise Cancelling Headphones Black" });

    expect(computeMatchScore(blackSource, earbuds).total).toBe(0.5);
    expect(pickBestCandidate(blackSource, [earbuds])).toBeUndefined();
  });

  it.each([
    ["the listing", SONY_SOURCE.title, "Sony 1000XM5 Premium Noise Cancelling Wireless Headphones, Black"],
    ["the source", "Sony 1000XM5 Premium Noise Cancelling Wireless Headphones, Black", SONY_SOURCE.title]
  ])("does not cap a listing when %s writes the model number without its prefix", (_side, sourceTitle, listingTitle) => {
    expect(computeMatchScore({ ...SONY_SOURCE, title: sourceTitle }, sony({ title: listingTitle })).total).toBe(0.95);
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

  it("picks the WH-1000XM5 card on UK, whose title names no colour, and leaves its colour to the product page check", () => {
    expect(pickBestCandidate(SONY_SOURCE, liveCandidates("UK"))).toMatchObject({
      candidate: { asin: "B09Y2LL45F", title: "WH-1000XM5 Premium Wireless Noise Cancelling Headphones" },
      score: { total: 0.8571, variationScore: 0, confidenceLabel: "MEDIUM" }
    });
  });

  it.each(["DE", "FR"] as const)(
    "picks nothing on %s, where only other models, bundles and accessories are listed",
    (market) => {
      expect(pickBestCandidate(SONY_SOURCE, liveCandidates(market))).toBeUndefined();
    }
  );

  it("picks the WH-1000XM5 card on JP by its brand and model number, although its title shares few words with the source", () => {
    expect(pickBestCandidate(SONY_SOURCE, liveCandidates("JP"))).toMatchObject({
      candidate: { asin: "B0DGKYNLWF" },
      score: { total: 0.8071, titleScore: 0.7, confidenceLabel: "MEDIUM" }
    });
  });

  it("keeps the WH-1000XM5 bundles with a SanDisk drive on UK below the plain headphones", () => {
    const scores = liveCandidates("UK").map((candidate) => [candidate.asin, computeMatchScore(SONY_SOURCE, candidate).total]);

    expect(scores).toEqual([
      ["B09Y2LL45F", 0.8571],
      ["B0BNNKXS18", 0.4212],
      ["B0CRF2V57G", 0.655]
    ]);
  });
});

describe("a shared brand and model number", () => {
  const BLACK_SONY: SourceContext = { ...SONY_SOURCE, variationTokens: ["black"] };
  const sonyCard = (asin: string, title: string, brand = "Sony"): SearchCandidate =>
    listing({ marketplace: "IT", asin, title, brand, url: `https://www.amazon.it/dp/${asin}` });
  const ITALIAN_CARDS = [
    sonyCard("B09Y2MYL5C", "WH-1000XM5 Premium Bluetooth Headphones with Noise Cancelling"),
    sonyCard("B0BXM22X99", "WH-1000XM5 Premium Bluetooth Headphones with Noise Cancelling"),
    sonyCard("B09Y2LL45F", "WH-1000XM5 Premium Bluetooth Headphones with Noise Cancelling"),
    sonyCard("B0C4TLFZSZ", "WF-1000XM5 Premium Wireless Earphones with Noise Cancelling"),
    sonyCard("B0F2TSQL21", "WH-1000XM6 Premium Bluetooth Headphones with Noise Cancelling"),
    sonyCard("B0CX1TJXKV", "ULT WEAR Bluetooth Headphones with Noise Cancelling and Deep Bass")
  ];

  it("lifts the title score of a card with the source brand and model number to 0.7, as amazon.it lists the WH-1000XM5", () => {
    expect(computeMatchScore(BLACK_SONY, ITALIAN_CARDS[0])).toEqual({
      total: 0.8071,
      titleScore: 0.7,
      brandScore: 1,
      variationScore: 0,
      confidenceLabel: "MEDIUM"
    });
    expect(pickBestCandidate(BLACK_SONY, ITALIAN_CARDS)).toMatchObject({ candidate: { asin: "B09Y2MYL5C" } });
  });

  it("keeps a title that already scores above 0.7 as it is", () => {
    expect(computeMatchScore(BLACK_SONY, sonyCard("B0BXM22X99", "WH-1000XM5 Premium Wireless Noise Cancelling Headphones")).titleScore).toBe(
      7 / 9
    );
  });

  it.each([
    [
      "has no brand of its own",
      { ...sonyCard("B0H8N7F34T", "Replacement Hinge Repair Kit for Sony WH-1000XM5 Headphones (Black)"), brand: undefined }
    ],
    ["has another brand", sonyCard("B0BPM7F4S3", "Ear Pads for Sony WH-1000XM5 Replacement Ear Cushions - Black", "SOULWIT")],
    [
      "is a bundle",
      sonyCard("B0CRF2V57G", "WH-1000XM5 Wireless Headphones - Black & SanDisk Extreme Portable SSD 2TB up to 550MB/s read")
    ],
    ["is a bundle named as one", sonyCard("B0FMXS12CR", "Bundle Deal: Sony WH-1000XM5 Black Wireless Headphones with Stand")],
    ["names another colour", sonyCard("B09Y2LL45F", "WH-1000XM5 Wireless Headphones, Silver")],
    ["names a second model number", sonyCard("B0C4TLFZSZ", "WH-1000XM5 Wireless Headphones and WF-1000XM5 Earbuds, Black")]
  ])("does not lift a card that %s", (_case, card) => {
    expect(computeMatchScore(BLACK_SONY, card).total).toBeLessThan(0.78);
  });

  it("does not lift a card for a source page without a brand", () => {
    expect(computeMatchScore({ ...BLACK_SONY, brand: undefined }, ITALIAN_CARDS[0]).total).toBeLessThan(0.78);
  });

  it.each([
    ["a short model number", "Acme Ultra Widget Model X100 2 Pack Blue", "X100 Garden Hose Reel Wall Mounted Blue"],
    ["a capacity", "Acme Portable SSD 128GB Blue", "Acme 128GB Memory Card Blue"],
    ["a single letter and digits", "Acme Ultra Widget A2337 Blue", "A2337 Garden Hose Reel Wall Mounted Blue"]
  ])("does not treat %s as a model number", (_case, sourceTitle, cardTitle) => {
    const source: SourceContext = { ...ACME_SOURCE, title: sourceTitle, variationTokens: [] };

    expect(computeMatchScore(source, listing({ title: cardTitle, brand: "Acme" })).titleScore).toBeLessThan(0.7);
  });
});

describe("variant check", () => {
  const BLACK_SONY: SourceContext = { ...SONY_SOURCE, variationTokens: ["black"] };
  const UK_TWISTER = [
    { asin: "B09Y2LL45F", label: "With Hard Case" },
    { asin: "B0F38PL24W", label: "With Soft Case" },
    { asin: "B09Y2LL45F", label: "Silver" },
    { asin: "B09Y2MYL5C", label: "Black" },
    { asin: "B0BXM22X99", label: "Midnight Blue" },
    { asin: "B0DBLP647C", label: "Smoky Pink" }
  ];

  it.each([
    [["With Hard Case", "Silver"], true],
    [["Midnight Blue"], true],
    [["Hard Case", "Black/White"], false],
    [["Hard Case"], false],
    [[], false]
  ])("decides whether a page showing %j conflicts with a black source: %s", (selected, expected) => {
    expect(variantConflicts(BLACK_SONY, selected)).toBe(expected);
  });

  it.each([
    [["1 Pack"], true],
    [["Blue", "2 Pack"], false],
    [["Red", "2 Pack"], true],
    [["8 oz"], true]
  ])("compares each kind of attribute on its own, so %j against a 2 pack of 16 oz blue conflicts: %s", (selected, expected) => {
    expect(variantConflicts({ ...ACME_SOURCE, variationTokens: ["2 pack", "16 oz", "blue"] }, selected)).toBe(expected);
  });

  it("finds the source colour among the variants a twister offers", () => {
    expect(findSourceVariant(BLACK_SONY, UK_TWISTER)).toEqual({ asin: "B09Y2MYL5C", label: "Black" });
  });

  it("finds nothing when no variant carries the source colour", () => {
    expect(findSourceVariant(BLACK_SONY, UK_TWISTER.filter((option) => option.label !== "Black"))).toBeUndefined();
    expect(findSourceVariant({ ...BLACK_SONY, title: "Sony WH-1000XM5", variationTokens: [] }, UK_TWISTER)).toBeUndefined();
  });
});
