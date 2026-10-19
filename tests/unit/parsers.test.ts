import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { extractProductData } from "../../src/content/product-extractor";
import { extractSearchCandidates } from "../../src/content/search-extractor";
import { extractSourceContext } from "../../src/content/source-extractor";
import type { Marketplace, SearchCandidate } from "../../src/shared/types";

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

  describe("search candidate currency", () => {
    function candidatePrice(market: Marketplace, price: string) {
      const html = `<!doctype html><html><body>
        <div class="s-result-item" data-component-type="s-search-result" data-asin="B000000001">
          <h2><a href="/dp/B000000001"><span>Acme Ultra Widget Model X100 2 Pack Blue</span></a></h2>
          <span class="a-price"><span class="a-offscreen">${price}</span></span>
        </div>
      </body></html>`;
      const dom = new JSDOM(html, { url: `https://${DOMAIN_BY_MARKET[market]}/s?k=acme` });
      const [candidate] = extractSearchCandidates(dom.window.document, { marketplace: market, limit: 8 }, dom.window.location.origin);
      return candidate?.price;
    }

    it.each([
      { market: "CA", currency: "CAD" },
      { market: "MX", currency: "MXN" },
      { market: "AU", currency: "AUD" },
      { market: "US", currency: "USD" }
    ] as const)("reads a bare $64.99 on $market as $currency", ({ market, currency }) => {
      expect(candidatePrice(market, "$64.99")).toEqual({ amount: 64.99, currency });
    });

    it.each([
      { price: "US$12.00", market: "CA", amount: 12, currency: "USD" },
      { price: "CA$5", market: "US", amount: 5, currency: "CAD" },
      { price: "MX$899.00", market: "AU", amount: 899, currency: "MXN" },
      { price: "AU$78.99", market: "US", amount: 78.99, currency: "AUD" }
    ] as const)("lets the explicit prefix in $price win on $market", ({ price, market, amount, currency }) => {
      expect(candidatePrice(market, price)).toEqual({ amount, currency });
    });

    it.each([
      { price: "CHF 733.45", market: "DE", amount: 733.45, currency: "CHF" },
      { price: "CHF 698.48", market: "UK", amount: 698.48, currency: "CHF" },
      { price: "CHF 21.50", market: "FR", amount: 21.5, currency: "CHF" }
    ] as const)("reads $price on $market in the currency it names", ({ price, market, amount, currency }) => {
      expect(candidatePrice(market, price)).toEqual({ amount, currency });
    });

    it("keeps a dollar sign on a non-dollar marketplace as US dollars", () => {
      expect(candidatePrice("UK", "$12.00")).toEqual({ amount: 12, currency: "USD" });
    });

    it("reads an amount without a currency marker in the marketplace currency", () => {
      expect(candidatePrice("JP", "4,200")).toEqual({ amount: 4200, currency: "JPY" });
    });
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

type LiveSearchMarket = "CA" | "MX" | "UK" | "DE" | "FR" | "JP";

const FIXTURE_NUMBER_BY_MARKET: Record<Marketplace, string> = {
  US: "01",
  CA: "02",
  MX: "03",
  UK: "04",
  DE: "05",
  FR: "06",
  IT: "07",
  ES: "08",
  JP: "09",
  AU: "10"
};

const GRID_IMAGE = "https://m.media-amazon.com/images/I/IMG._AC_UL320_.jpg";
const LIST_IMAGE = "https://m.media-amazon.com/images/I/IMG._AC_UY218_.jpg";

const LIVE_SEARCH_RESULTS: Record<LiveSearchMarket, { ad: string; candidates: Array<Omit<SearchCandidate, "marketplace">> }> = {
  CA: {
    ad: "B0F3QJLD3B",
    candidates: [
      {
        asin: "B09XS7JWHH",
        title: "WH-1000XM5 Premium Noise Cancelling Wireless Headphones, Black",
        brand: "Sony",
        price: { amount: 498, currency: "CAD" },
        url: "https://www.amazon.ca/Sony-WH-1000XM5-Cancelling-Headphones-Hands-Free/dp/B09XS7JWHH",
        imageUrl: GRID_IMAGE
      },
      {
        asin: "B0CX1TJXKV",
        title: "ULT Wear Wireless Noise Cancelling Bluetooth Headphones - Black",
        brand: "Sony",
        price: { amount: 199.99, currency: "CAD" },
        url: "https://www.amazon.ca/Sony-Canceling-Headphones-Assistant-International/dp/B0CX1TJXKV",
        imageUrl: GRID_IMAGE
      },
      {
        asin: "B0B2FCT81R",
        title: "WH-1000XM5 Wireless Noise Cancelling Headphones Alexa Voice Control Black (Renewed)",
        brand: "Amazon Renewed",
        price: { amount: 335, currency: "CAD" },
        url: "https://www.amazon.ca/Sony-WH-1000XM5-Wireless-Cancelling-Headphones/dp/B0B2FCT81R",
        imageUrl: GRID_IMAGE
      }
    ]
  },
  MX: {
    ad: "B0BZLCX88J",
    candidates: [
      {
        asin: "B09XS7JWHH",
        title: "Sony WH-1000XM5 Audífonos inalámbricos con Cancelación de Ruido, Negro (Versión Extranjera)",
        url: "https://www.amazon.com.mx/Sony-WH-1000XM5-Aud%C3%ADfonos-inal%C3%A1mbricos-Cancelaci%C3%B3n/dp/B09XS7JWHH",
        imageUrl: GRID_IMAGE
      },
      {
        asin: "B0CFSD4TSQ",
        title: "Sony WH-1000XM5 Audífonos inalámbricos con Cancelación de Ruido, Negro (Versión Nacional)",
        price: { amount: 4699, currency: "MXN" },
        url: "https://www.amazon.com.mx/Sony-WH-1000XM5-Aud%C3%ADfonos-inal%C3%A1mbricos-Cancelaci%C3%B3n/dp/B0CFSD4TSQ",
        imageUrl: GRID_IMAGE
      },
      {
        asin: "B0DDV3FRHR",
        title:
          "Sony WH-1000XM5 Auriculares Premium con Optimizador automático de cancelación de Ruido, 30 Horas de batería, Control por Voz, Rosa",
        price: { amount: 4267, currency: "MXN" },
        url: "https://www.amazon.com.mx/Sony-WH-1000XM5-Aud%C3%ADfonos-inal%C3%A1mbricos-Cancelaci%C3%B3n/dp/B0DDV3FRHR",
        imageUrl: GRID_IMAGE
      }
    ]
  },
  UK: {
    ad: "B0D7HRBYKR",
    candidates: [
      {
        asin: "B09Y2LL45F",
        title: "WH-1000XM5 Premium Wireless Noise Cancelling Headphones",
        brand: "Sony",
        url: "https://www.amazon.co.uk/Sony-WH-1000XM5-Cancelling-Wireless-Headphones-Silver/dp/B09Y2LL45F",
        imageUrl: LIST_IMAGE
      },
      {
        asin: "B0BNNKXS18",
        title:
          "WH-1000XM5 Noise Cancelling Wireless Headphones - 30 hours battery life - Over-ear style - Optimised for Alexa and the Google Assistant - with built-in mic for phone calls - Black (Renewed)",
        brand: "Amazon Renewed",
        price: { amount: 698.48, currency: "CHF" },
        url: "https://www.amazon.co.uk/Sony-WH-1000XM5-Cancelling-Wireless-Headphones-Black/dp/B0BNNKXS18",
        imageUrl: LIST_IMAGE
      },
      {
        asin: "B0CRF2V57G",
        title:
          "WH-1000XM5 Noise Cancelling Wireless Headphones - 30 hours battery life - Over-ear style - with built-in mic for phone calls - Black & SanDisk Extreme Portable SSD 2TB up to 550MB/s read",
        brand: "Sony",
        url: "https://www.amazon.co.uk/Sony-WH-1000XM5-Cancelling-Wireless-Headphones-black/dp/B0CRF2V57G",
        imageUrl: "https://m.media-amazon.com/images/I/IMG._AC_UY218_.gif"
      }
    ]
  },
  DE: {
    ad: "B0FQTXJRCY",
    candidates: [
      {
        asin: "B0HBX9NHMS",
        title: "WH-1000XM4C Wireless Noise Cancelling Headphones with Apache 207 EQ",
        brand: "Sony",
        price: { amount: 733.45, currency: "CHF" },
        url: "https://www.amazon.de/-/en/Sony-WH-1000XM4C-Cancelling-Headphones-Multipoint-black/dp/B0HBX9NHMS",
        imageUrl: LIST_IMAGE
      },
      {
        asin: "B0FVXC9LYP",
        title: "Hinge Repair Kit for Sony WH-1000XM5(XM5) - Black",
        brand: "SOULWIT",
        price: { amount: 126.51, currency: "CHF" },
        url: "https://www.amazon.de/-/en/SOULWIT-Hinge-Repair-Sony-WH-1000XM5-black/dp/B0FVXC9LYP",
        imageUrl: LIST_IMAGE
      },
      {
        asin: "B0BZLCX88J",
        title: "PadZ XM5 - Premium Replacement Ear Pads Compatible with Sony WH-1000XM5",
        brand: "WC",
        price: { amount: 73.51, currency: "CHF" },
        url: "https://www.amazon.de/-/en/WC-PadZ-XM5-Replacement-Compatible-Black/dp/B0BZLCX88J",
        imageUrl: LIST_IMAGE
      }
    ]
  },
  FR: {
    ad: "B0BZLC4YKH",
    candidates: [
      {
        asin: "B0F38PL24W",
        title:
          "WH-1000XM5SA Special Edition with Soft Case, Active Noise Reduction, Bluetooth, Clear Call Quality, High Resolution Audio, Up to 30 Hours Battery Life, Compatible with iOS and Android - Black",
        brand: "Sony",
        price: { amount: 230.13, currency: "EUR" },
        url: "https://www.amazon.fr/-/en/Sony-WH-1000XM5SA-Reduction-Resolution-Compatible/dp/B0F38PL24W",
        imageUrl: GRID_IMAGE
      },
      {
        asin: "B0F2TT8Q7M",
        title: "WH-1000XM6 Premium Noise Cancelling Wireless Bluetooth Headphones",
        brand: "Sony",
        url: "https://www.amazon.fr/-/en/Sony-WH-1000XM6-Cancelling-High-Resolution-Comfortable/dp/B0F2TT8Q7M",
        imageUrl: GRID_IMAGE
      },
      {
        asin: "B0HBXHB1TQ",
        title: "WH-1000XM4C Noise Cancelling Wireless Bluetooth Headphones",
        brand: "Sony",
        url: "https://www.amazon.fr/-/en/Sony-WH-1000XM4C-Cancelling-Headphones-Multipoint/dp/B0HBXHB1TQ",
        imageUrl: GRID_IMAGE
      }
    ]
  },
  JP: {
    ad: "B0CZF3NTH7",
    candidates: [
      {
        asin: "B0DGKYNLWF",
        title:
          "WH-1000XM5 Wireless Noise Cancelling Stereo Headphones, VGP Hall of Fame, Improved Noise-Canceling Performance, Equipped with Amazon Alexa, Improved Call Performance, Soft Fit Leather, High Noise",
        brand: "Sony",
        url: "https://www.amazon.co.jp/-/en/Sony-WH-1000XM5-Cancelling-Noise-Canceling-Performance/dp/B0DGKYNLWF",
        imageUrl: GRID_IMAGE
      },
      {
        asin: "B0H1GFQ9NB",
        title: "WH-1000XM5 Ear Pads Ear Cushions for Sony 1000XM5 Replacement Sony",
        price: { amount: 2999, currency: "JPY" },
        url: "https://www.amazon.co.jp/-/en/WH-1000XM5-Pads-Cushions-1000XM5-Replacement/dp/B0H1GFQ9NB",
        imageUrl: GRID_IMAGE
      },
      {
        asin: "B0F98Z3XXM",
        title: "WH-1000XM6, Black: Wireless Headphones + Elecom Headphone Stand, T-Shape, Black",
        brand: "Sony",
        url: "https://www.amazon.co.jp/-/en/Sony-WH-1000XM6-Black-Headphones-Headphone/dp/B0F98Z3XXM",
        imageUrl: GRID_IMAGE
      }
    ]
  }
};

const LIVE_SEARCH_MARKETS = Object.keys(LIVE_SEARCH_RESULTS) as LiveSearchMarket[];

function searchPage(directory: "search" | "search-live", market: Marketplace): JSDOM {
  const html = readFileSync(join(process.cwd(), "tests", "fixtures", directory, `${market}.html`), "utf8");
  return new JSDOM(html, { url: `https://${DOMAIN_BY_MARKET[market]}/s?k=Sony+WH-1000XM5+Black` });
}

function searchCards(dom: JSDOM, market: Marketplace, limit = 8): SearchCandidate[] {
  return extractSearchCandidates(dom.window.document, { marketplace: market, limit }, dom.window.location.origin);
}

function searchCardsIn(body: string, market: Marketplace = "CA"): SearchCandidate[] {
  const dom = new JSDOM(`<!doctype html><html><body>${body}</body></html>`, {
    url: `https://${DOMAIN_BY_MARKET[market]}/s?k=sony`
  });
  return searchCards(dom, market);
}

describe("search result cards", () => {
  it.each(MARKETS)("reads the %s cards whose heading wraps the product link", (market) => {
    const domain = DOMAIN_BY_MARKET[market];
    const number = FIXTURE_NUMBER_BY_MARKET[market];
    const price = { amount: PRODUCT_AMOUNTS_BY_MARKET[market].item, currency: CURRENCY_BY_MARKET[market] };

    expect(searchCards(searchPage("search", market), market)).toEqual([
      {
        marketplace: market,
        asin: `B0000000${number}`,
        title: "Acme Ultra Widget Model X100 2 Pack Blue",
        brand: "Acme",
        price,
        url: `https://${domain}/dp/B0000000${number}`,
        imageUrl: `https://${domain}/image.jpg`
      },
      {
        marketplace: market,
        asin: `D0000000${number}`,
        title: "Acme Basic Widget Model Z10 1 Pack",
        price,
        url: `https://${domain}/dp/D0000000${number}`
      }
    ]);
  });

  it.each(LIVE_SEARCH_MARKETS)("reads the current %s cards whose product link wraps the title heading", (market) => {
    const { ad, candidates } = LIVE_SEARCH_RESULTS[market];

    const extracted = searchCards(searchPage("search-live", market), market);

    expect(extracted).toEqual(candidates.map((candidate) => ({ marketplace: market, ...candidate })));
    expect(extracted.map((candidate) => candidate.asin)).not.toContain(ad);
  });

  it.each(LIVE_SEARCH_MARKETS)("drops the %s ad even without its AdHolder class and Sponsored label", (market) => {
    const dom = searchPage("search-live", market);
    const document = dom.window.document;
    const adCard = document.querySelector(`[data-asin="${LIVE_SEARCH_RESULTS[market].ad}"]`);
    adCard?.classList.remove("AdHolder");
    for (const span of Array.from(adCard?.querySelectorAll("span") ?? [])) {
      if (span.children.length === 0 && /^(sponsored|patrocinado)$/i.test(span.textContent?.trim() ?? "")) {
        span.textContent = "";
      }
    }

    expect(searchCards(dom, market).map((candidate) => candidate.asin)).toEqual(
      LIVE_SEARCH_RESULTS[market].candidates.map((candidate) => candidate.asin)
    );
  });

  it("counts the limit in organic cards, so ads ahead of the source listing do not use it up", () => {
    expect(searchCards(searchPage("search-live", "CA"), "CA", 1).map((candidate) => candidate.asin)).toEqual(["B09XS7JWHH"]);
  });

  it.each(["Gesponsert", "Sponsorisé", "Sponsorizzato", "スポンサー", "広告"])(
    "drops a card labelled %s that still links to a product page",
    (label) => {
      const candidates = searchCardsIn(`
        <div class="s-result-item" data-component-type="s-search-result" data-asin="B0AD000001">
          <span class="a-color-secondary">${label}</span>
          <a href="/dp/B0AD000001"><h2><span>Advertised headphones</span></h2></a>
        </div>
        <div class="s-result-item" data-component-type="s-search-result" data-asin="B0ORGANIC1">
          <a href="/dp/B0ORGANIC1"><h2><span>Sponsored by nobody: organic headphones</span></h2></a>
        </div>`);

      expect(candidates.map((candidate) => candidate.asin)).toEqual(["B0ORGANIC1"]);
    }
  );

  it("drops a card whose only links lead to an ad redirect or a store page", () => {
    const candidates = searchCardsIn(`
      <div class="s-result-item" data-component-type="s-search-result" data-asin="B0AD000002">
        <a href="/sspa/click?ie=UTF8&amp;url=%2FSony-WH-1000XM5%2Fdp%2FB09XS7JWHH"><h2><span>Redirected ad</span></h2></a>
      </div>
      <div class="s-result-item" data-component-type="s-search-result" data-asin="">
        <a href="/stores/Sony/page/1234"><h2><span>Sony store</span></h2></a>
      </div>`);

    expect(candidates).toEqual([]);
  });

  it("reads the ASIN from the product link when the card has none and keeps an absolute link", () => {
    const [candidate] = searchCardsIn(`
      <div class="s-result-item" data-component-type="s-search-result" data-asin="">
        <a href="https://www.amazon.ca/Sony-WH-1000XM5/dp/b09xsdmt4f/ref=sr_1_2?keywords=sony"><h2><span>WH-1000XM5 Silver</span></h2></a>
      </div>`);

    expect(candidate).toMatchObject({
      asin: "B09XSDMT4F",
      title: "WH-1000XM5 Silver",
      url: "https://www.amazon.ca/Sony-WH-1000XM5/dp/b09xsdmt4f/ref=sr_1_2?keywords=sony"
    });
  });

  it("falls back to the product image text and link when no heading links to the product", () => {
    const [candidate] = searchCardsIn(`
      <div class="s-result-item" data-component-type="s-search-result" data-asin="B09XS7JWHH">
        <a href="/dp/B09XS7JWHH"><img class="s-image" src="https://m.media-amazon.com/images/I/sony.jpg" alt="Sony WH-1000XM5 Black" /></a>
        <h2><span>Sony</span></h2>
      </div>`);

    expect(candidate).toMatchObject({
      asin: "B09XS7JWHH",
      title: "Sony WH-1000XM5 Black",
      url: "https://www.amazon.ca/dp/B09XS7JWHH",
      imageUrl: "https://m.media-amazon.com/images/I/sony.jpg"
    });
  });

  it("reads the price to pay ahead of a struck-through list price", () => {
    const [candidate] = searchCardsIn(`
      <div class="s-result-item" data-component-type="s-search-result" data-asin="B0B2FCT81R">
        <a href="/dp/B0B2FCT81R"><h2><span>WH-1000XM5 (Renewed)</span></h2></a>
        <span class="a-price a-text-price"><span class="a-offscreen">$498.00</span></span>
        <span class="a-price"><span class="a-offscreen">$335.00</span></span>
      </div>`);

    expect(candidate.price).toEqual({ amount: 335, currency: "CAD" });
  });
});
