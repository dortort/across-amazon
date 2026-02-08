import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { extractProductData } from "../../src/content/product-extractor";
import { extractSearchCandidates } from "../../src/content/search-extractor";
import { extractSourceContext } from "../../src/content/source-extractor";
import type { Marketplace } from "../../src/shared/types";

const MARKETS: Marketplace[] = ["US", "CA", "MX", "UK", "DE", "FR", "IT", "ES", "JP", "AU"];

const DOMAIN_BY_MARKET: Record<Marketplace, string> = {
  US: "www.amazon.com",
  CA: "www.amazon.ca",
  MX: "www.amazon.com.mx",
  UK: "www.amazon.co.uk",
  DE: "www.amazon.de",
  FR: "www.amazon.fr",
  IT: "www.amazon.it",
  ES: "www.amazon.es",
  JP: "www.amazon.co.jp",
  AU: "www.amazon.com.au"
};

function loadFixture(group: "source" | "search" | "product", market: Marketplace): JSDOM {
  const file = join(process.cwd(), "tests", "fixtures", group, `${market}.html`);
  const html = readFileSync(file, "utf8");
  const url = `https://${DOMAIN_BY_MARKET[market]}/dp/B00TEST000`;
  return new JSDOM(html, { url });
}

describe("content parsers", () => {
  it("extracts source context for all marketplaces", () => {
    for (const market of MARKETS) {
      const dom = loadFixture("source", market);
      const extracted = extractSourceContext(dom.window.document, dom.window.location.href, dom.window.location.hostname);

      expect(extracted.error).toBeUndefined();
      expect(extracted.source?.marketplace).toBe(market);
      expect(extracted.source?.asin).toMatch(/^[A-Z0-9]{10}$/);
      expect(extracted.source?.variationTokens.length).toBeGreaterThan(0);
    }
  });

  it("extracts up to 8 organic search candidates and strips sponsored entries", () => {
    for (const market of MARKETS) {
      const dom = loadFixture("search", market);
      const candidates = extractSearchCandidates(dom.window.document, { marketplace: market, limit: 8 }, dom.window.location.origin);

      expect(candidates.length).toBeGreaterThanOrEqual(2);
      expect(candidates[0].asin).toMatch(/^[A-Z0-9]{10}$/);
      expect(candidates[0].title.toLowerCase()).toContain("acme");
    }
  });

  it("extracts product pricing and destination match status", () => {
    for (const market of MARKETS) {
      const dom = loadFixture("product", market);
      const result = extractProductData(
        dom.window.document,
        {
          marketplace: market,
          sourceDestinationCountryCode: market
        },
        dom.window.location.href
      );

      expect(result.marketplace).toBe(market);
      expect(result.breakdown?.item.amount).toBeGreaterThan(0);
      expect(result.hasShippingInfo).toBe(true);
      expect(result.hasImportInfo).toBe(true);
      expect(result.destinationMatched).toBe(true);
    }
  });
});
