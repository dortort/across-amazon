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

const CURRENCY_BY_MARKET: Record<Marketplace, string> = {
  US: "USD",
  CA: "CAD",
  MX: "MXN",
  UK: "GBP",
  DE: "EUR",
  FR: "EUR",
  IT: "EUR",
  ES: "EUR",
  JP: "JPY",
  AU: "AUD"
};

const PRODUCT_AMOUNTS_BY_MARKET: Record<Marketplace, { item: number; shipping: number; importFees: number }> = {
  US: { item: 49.99, shipping: 6, importFees: 4 },
  CA: { item: 64.99, shipping: 8, importFees: 5.5 },
  MX: { item: 899, shipping: 95, importFees: 70 },
  UK: { item: 32.5, shipping: 3.2, importFees: 2 },
  DE: { item: 37.2, shipping: 4.5, importFees: 3.2 },
  FR: { item: 38.1, shipping: 4.3, importFees: 3 },
  IT: { item: 36.9, shipping: 4.2, importFees: 2.9 },
  ES: { item: 35.8, shipping: 4.1, importFees: 2.8 },
  JP: { item: 4200, shipping: 500, importFees: 300 },
  AU: { item: 78.99, shipping: 9.9, importFees: 6.5 }
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

  it.each(MARKETS)("reads every %s product charge in the marketplace currency", (market) => {
    const dom = loadFixture("product", market);
    const result = extractProductData(
      dom.window.document,
      { marketplace: market, sourceDestinationCountryCode: market },
      dom.window.location.href
    );
    const currency = CURRENCY_BY_MARKET[market];
    const amounts = PRODUCT_AMOUNTS_BY_MARKET[market];

    expect(result.breakdown).toEqual({
      item: { amount: amounts.item, currency },
      shipping: { amount: amounts.shipping, currency },
      importFees: { amount: amounts.importFees, currency },
      totalDisplayed: { amount: amounts.item, currency }
    });
    expect(result.notes).toEqual([]);
  });

  it.each(MARKETS)("reads every %s search candidate price in the marketplace currency", (market) => {
    const dom = loadFixture("search", market);
    const candidates = extractSearchCandidates(dom.window.document, { marketplace: market, limit: 8 }, dom.window.location.origin);

    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) {
      expect(candidate.price).toEqual({ amount: PRODUCT_AMOUNTS_BY_MARKET[market].item, currency: CURRENCY_BY_MARKET[market] });
    }
  });

  it("reads the product image from the landing image on the source page", () => {
    const dom = loadFixture("source", "US");
    const extracted = extractSourceContext(dom.window.document, dom.window.location.href, dom.window.location.hostname);

    expect(extracted.source?.imageUrl).toBe("https://m.media-amazon.com/images/I/41acme-widget._AC_SX425_.jpg");
  });

  it("falls back to the og:image meta tag when there is no landing image", () => {
    const dom = loadFixture("source", "DE");
    const extracted = extractSourceContext(dom.window.document, dom.window.location.href, dom.window.location.hostname);

    expect(extracted.source?.imageUrl).toBe("https://m.media-amazon.com/images/I/51acme-widget-de._AC_SX425_.jpg");
  });

  it("leaves imageUrl unset when the page has no product image", () => {
    const dom = loadFixture("source", "UK");
    const extracted = extractSourceContext(dom.window.document, dom.window.location.href, dom.window.location.hostname);

    expect(extracted.source).toBeDefined();
    expect(extracted.source).not.toHaveProperty("imageUrl");
  });

  describe("source image fallbacks", () => {
    const PRODUCT_BODY = `
      <input id="ASIN" value="B000000001" />
      <span id="productTitle">Acme Ultra Widget Model X100 2 Pack Blue</span>
    `;

    function imageUrlFor(markup: string, head = ""): string | undefined {
      const dom = new JSDOM(`<!doctype html><html><head>${head}</head><body>${PRODUCT_BODY}${markup}</body></html>`, {
        url: "https://www.amazon.com/dp/B000000001"
      });
      return extractSourceContext(dom.window.document, dom.window.location.href, dom.window.location.hostname).source
        ?.imageUrl;
    }

    it("uses data-old-hires when the landing image src is a data placeholder", () => {
      expect(
        imageUrlFor(
          '<img id="landingImage" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" data-old-hires="https://m.media-amazon.com/images/I/hires.jpg" />'
        )
      ).toBe("https://m.media-amazon.com/images/I/hires.jpg");
    });

    it("uses the image wrapper img when there is no landing image id", () => {
      expect(imageUrlFor('<div id="imgTagWrapperId"><img src="https://m.media-amazon.com/images/I/wrapper.jpg" /></div>')).toBe(
        "https://m.media-amazon.com/images/I/wrapper.jpg"
      );
    });

    it("prefers the landing image over the og:image meta tag", () => {
      expect(
        imageUrlFor(
          '<img id="landingImage" src="https://m.media-amazon.com/images/I/landing.jpg" />',
          '<meta property="og:image" content="https://m.media-amazon.com/images/I/og.jpg" />'
        )
      ).toBe("https://m.media-amazon.com/images/I/landing.jpg");
    });

    it("resolves a relative image path against the page URL", () => {
      expect(imageUrlFor('<img id="landingImage" src="/images/I/relative.jpg" />')).toBe(
        "https://www.amazon.com/images/I/relative.jpg"
      );
    });

    it("ignores empty and non-http image sources", () => {
      expect(
        imageUrlFor(
          '<img id="landingImage" src="" data-old-hires="" />',
          '<meta property="og:image" content="javascript:alert(1)" />'
        )
      ).toBeUndefined();
    });
  });

  it("reads the baseline price from the source page with free domestic delivery", () => {
    const dom = loadFixture("source", "US");
    const result = extractProductData(
      dom.window.document,
      { marketplace: "US", sourceDestinationCountryCode: "US" },
      dom.window.location.href
    );

    expect(result.breakdown?.item).toEqual({ amount: 49.99, currency: "USD" });
    expect(result.breakdown?.shipping).toEqual({ amount: 0, currency: "USD" });
    expect(result.breakdown?.importFees).toBeUndefined();
    expect(result.destinationMatched).toBe(true);
    expect(result.notes).toEqual(["Import fees not displayed for destination"]);
  });
});
