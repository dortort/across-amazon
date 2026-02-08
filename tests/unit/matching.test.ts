import { describe, expect, it } from "vitest";
import { computeMatchScore, extractVariationTokens, normalizeText, pickBestCandidate, tokenizeTitle } from "../../src/shared/matching";
import type { SourceContext } from "../../src/shared/types";

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
