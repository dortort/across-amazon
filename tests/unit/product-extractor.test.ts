import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractProductData, extractProductDataWithOffers } from "../../src/content/product-extractor";
import { deliveredTotal } from "../../src/shared/money";
import type { ListingAvailability, Marketplace, Money, PriceBreakdown, ProductExtractionResult } from "../../src/shared/types";
import { destinationFields } from "./destination-fields";

const PAGE_BY_MARKET: Partial<Record<Marketplace, { url: string; item: string }>> = {
  US: { url: "https://www.amazon.com/dp/B000000001", item: "$49.99" },
  CA: { url: "https://www.amazon.ca/dp/B000000002", item: "CA$64.99" },
  DE: { url: "https://www.amazon.de/dp/B000000005", item: "€37,20" },
  JP: { url: "https://www.amazon.co.jp/dp/B000000009", item: "￥4,200" }
};

function extract(blocks: string, marketplace: Marketplace = "US"): ProductExtractionResult {
  const page = PAGE_BY_MARKET[marketplace];
  if (!page) {
    throw new Error(`No test page for ${marketplace}`);
  }
  const html = `<!doctype html><html><body>
    <div id="corePriceDisplay_desktop_feature_div"><span class="a-price"><span class="a-offscreen">${page.item}</span></span></div>
    ${blocks}
  </body></html>`;
  const dom = new JSDOM(html, { url: page.url });
  return extractProductData(
    dom.window.document,
    { marketplace, sourceDestinationCountryCode: marketplace },
    dom.window.location.href
  );
}

const HOST_BY_MARKET: Partial<Record<Marketplace, string>> = {
  US: "www.amazon.com",
  CA: "www.amazon.ca",
  MX: "www.amazon.com.mx",
  UK: "www.amazon.co.uk",
  DE: "www.amazon.de",
  JP: "www.amazon.co.jp",
  AU: "www.amazon.com.au"
};

function extractPriced(marketplace: Marketplace, item: string, blocks = ""): ProductExtractionResult {
  const host = HOST_BY_MARKET[marketplace];
  if (!host) {
    throw new Error(`No test host for ${marketplace}`);
  }
  const html = `<!doctype html><html><body>
    <div id="corePriceDisplay_desktop_feature_div"><span class="a-price"><span class="a-offscreen">${item}</span></span></div>
    ${blocks}
  </body></html>`;
  const dom = new JSDOM(html, { url: `https://${host}/dp/B000000001` });
  return extractProductData(dom.window.document, { marketplace, sourceDestinationCountryCode: marketplace }, dom.window.location.href);
}

describe("product extractor currency detection", () => {
  it.each([
    { market: "CA", currency: "CAD" },
    { market: "MX", currency: "MXN" },
    { market: "AU", currency: "AUD" },
    { market: "US", currency: "USD" }
  ] as const)("reads a bare $64.99 on $market as $currency", ({ market, currency }) => {
    expect(extractPriced(market, "$64.99").breakdown?.item).toEqual({ amount: 64.99, currency });
  });

  it.each([
    { item: "US$12.00", market: "CA", amount: 12, currency: "USD" },
    { item: "CA$5", market: "US", amount: 5, currency: "CAD" },
    { item: "MX$899.00", market: "US", amount: 899, currency: "MXN" },
    { item: "AU$78.99", market: "CA", amount: 78.99, currency: "AUD" },
    { item: "C$14.99", market: "MX", amount: 14.99, currency: "CAD" }
  ] as const)("lets the explicit prefix in $item win on $market", ({ item, market, amount, currency }) => {
    expect(extractPriced(market, item).breakdown?.item).toEqual({ amount, currency });
  });

  it("reads every bare-dollar charge on amazon.ca in Canadian dollars", () => {
    const result = extractPriced(
      "CA",
      "$64.99",
      `<div id="deliveryBlockMessage">Shipping <span class="a-color-price">$8.00</span></div>
       <div id="exports_desktop_feature_div">Import Fees Deposit $5.50</div>
       <div id="subtotals-marketplace-table"><span class="a-color-price">$78.49</span></div>`
    );

    expect(result.breakdown).toEqual({
      item: { amount: 64.99, currency: "CAD" },
      shipping: { amount: 8, currency: "CAD" },
      importFees: { amount: 5.5, currency: "CAD" },
      totalDisplayed: { amount: 78.49, currency: "CAD" }
    });
  });

  it("gives free shipping on amazon.com.mx the peso currency of a bare-dollar item price", () => {
    const result = extractPriced("MX", "$899.00", '<div id="deliveryBlockMessage">Envío GRATIS el martes, 21 de octubre</div>');

    expect(result.breakdown?.shipping).toEqual({ amount: 0, currency: "MXN" });
  });

  it("keeps a dollar sign on a non-dollar marketplace as US dollars", () => {
    expect(extractPriced("DE", "$12.00").breakdown?.item).toEqual({ amount: 12, currency: "USD" });
  });

  it("reads an ISO currency code ahead of the marketplace default", () => {
    const result = extractPriced("UK", "£32.50", '<div id="deliveryBlockMessage">Shipping EUR 4,50</div>');

    expect(result.breakdown?.shipping).toEqual({ amount: 4.5, currency: "EUR" });
  });

  it.each([
    { item: "CHF78.27", market: "DE", amount: 78.27, currency: "CHF" },
    { item: "CHF 12.90", market: "DE", amount: 12.9, currency: "CHF" },
    { item: "INR 1,299.00", market: "UK", amount: 1299, currency: "INR" }
  ] as const)("reads $item shown for a foreign delivery address on $market as $currency", ({ item, market, amount, currency }) => {
    expect(extractPriced(market, item).breakdown?.item).toEqual({ amount, currency });
  });

  it("reads a Swiss franc delivery charge written as plain text with a non-breaking space", () => {
    const result = extractPriced(
      "DE",
      "CHF78.27",
      '<div id="mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_LARGE"><span> CHF&nbsp;41.36 delivery <span class="a-text-bold">Monday, 9 November</span></span></div>'
    );

    expect(result.breakdown?.item).toEqual({ amount: 78.27, currency: "CHF" });
    expect(result.breakdown?.shipping).toEqual({ amount: 41.36, currency: "CHF" });
  });

  it("reads an amount without any currency marker in the marketplace currency", () => {
    const result = extractPriced("JP", "4200", '<div id="deliveryBlockMessage">配達料 <span class="a-color-price">500</span></div>');

    expect(result.breakdown?.item).toEqual({ amount: 4200, currency: "JPY" });
    expect(result.breakdown?.shipping).toEqual({ amount: 500, currency: "JPY" });
  });
});

describe("product extractor item price", () => {
  function itemPrice(body: string, marketplace: Marketplace = "US"): ProductExtractionResult["breakdown"] {
    const host = HOST_BY_MARKET[marketplace] ?? "www.amazon.com";
    const dom = new JSDOM(`<!doctype html><html><body>${body}</body></html>`, { url: `https://${host}/dp/B000000001` });
    return extractProductData(dom.window.document, { marketplace, sourceDestinationCountryCode: marketplace }, dom.window.location.href).breakdown;
  }

  function priceToPay(symbol: string, whole: string, fraction?: string): string {
    const fractionPart = fraction === undefined ? "" : `<span class="a-price-decimal">.</span></span><span class="a-price-fraction">${fraction}</span>`;
    return `<span class="a-price aok-align-center reinventPricePriceToPayMargin priceToPay apex-pricetopay-value"><span class="a-offscreen"> </span><span><span class="a-price-symbol">${symbol}</span><span class="a-price-whole">${whole}${fraction === undefined ? "</span>" : fractionPart}</span></span>`;
  }

  const PER_UNIT = '<span class="a-size-mini a-color-base aok-align-center pricePerUnit">(<span class="a-price a-text-price apex-priceperunit-value"><span class="a-offscreen">$0.98</span><span>$0.98</span></span> / Foot)</span>';

  it("assembles the price to pay from its visible parts when its offscreen copy is blank, skipping the per-unit price", () => {
    const breakdown = itemPrice(`<div id="corePriceDisplay_desktop_feature_div">${priceToPay("$", "18", "99")}${PER_UNIT}</div>`);

    expect(breakdown?.item).toEqual({ amount: 18.99, currency: "USD" });
  });

  it("assembles a yen price without a fraction and skips the struck-through list price", () => {
    const breakdown = itemPrice(
      `<div id="corePriceDisplay_desktop_feature_div">${priceToPay("¥", "804")}<span class="a-size-small a-color-secondary aok-align-center basisPrice">List Price: <span class="a-price a-text-price apex-basisprice-value" data-a-strike="true"><span class="a-offscreen">¥1,133</span></span></span></div>`,
      "JP"
    );

    expect(breakdown?.item).toEqual({ amount: 804, currency: "JPY" });
  });

  it("reads the Swiss franc price to pay of a foreign delivery address from its visible parts", () => {
    const breakdown = itemPrice(`<div id="apex_desktop">${priceToPay("CHF", "78", "27")}</div>`, "DE");

    expect(breakdown?.item).toEqual({ amount: 78.27, currency: "CHF" });
  });

  it("reads a price to pay outside the price blocks it knows", () => {
    const breakdown = itemPrice(`<div id="newer_price_feature_div">${priceToPay("$", "18", "99")}</div>`);

    expect(breakdown?.item).toEqual({ amount: 18.99, currency: "USD" });
  });

  it("reads a price to pay inside the product block", () => {
    const breakdown = itemPrice(`<div id="ppd"><div id="centerCol"><div id="newer_price_feature_div">${priceToPay("$", "18", "99")}</div></div></div>`);

    expect(breakdown?.item).toEqual({ amount: 18.99, currency: "USD" });
  });

  it("reads no price to pay or centred price outside the product block", () => {
    const breakdown = itemPrice(
      `<div id="dp-container"><div id="ppd"><div id="centerCol"></div><div id="rightCol"></div></div><div id="Desktop-Detailed-Evaluation-Zone">${priceToPay("$", "18", "99")}<span class="a-price aok-align-center"><span class="a-offscreen">$15.99</span></span></div></div>`
    );

    expect(breakdown).toBeUndefined();
  });

  it.each([
    ["a sponsored card above the product block", '<div id="above-dp-container"><div id="desktop-dp-lpo_feature_div_0">PRICE</div></div>'],
    ["a recommendation carousel", '<div id="sims-simsContainer_feature_div_0"><div id="sp_detail_thematic">PRICE</div></div>'],
    ["the similar items of an out-of-stock box", '<div id="outOfStock" class="a-box">Currently unavailable. PRICE</div>']
  ])("reads no item price from %s on a page without a product block", (_widget, body) => {
    const price = '<span class="a-price aok-align-center"><span class="a-offscreen">$15.99</span></span>';

    expect(itemPrice(body.replace("PRICE", price + priceToPay("$", "24", "99")))).toBeUndefined();
  });

  it("prefers the buy box price to the centre column price", () => {
    const breakdown = itemPrice(
      '<div id="centerCol"><div id="corePriceDisplay_desktop_feature_div"><span class="a-price"><span class="a-offscreen">$19.49</span></span></div></div>' +
        `<div id="qualifiedBuybox"><div id="corePrice_feature_div"><span class="a-price aok-align-center apex-pricetopay-value"><span class="a-offscreen">$18.99</span></span>${PER_UNIT}</div></div>`
    );

    expect(breakdown?.item).toEqual({ amount: 18.99, currency: "USD" });
  });

  it("reads the price to pay of an older layout that marks it as a text price", () => {
    const breakdown = itemPrice(
      '<div id="corePrice_desktop"><span class="a-price a-text-price a-size-base" data-a-strike="true"><span class="a-offscreen">$29.99</span></span><span class="a-price a-text-price a-size-medium apexPriceToPay"><span class="a-offscreen">$24.99</span></span></div>'
    );

    expect(breakdown?.item).toEqual({ amount: 24.99, currency: "USD" });
  });

  it.each([
    ["#price_inside_buybox", '<span id="price_inside_buybox" class="a-size-medium a-color-price"> $24.99 </span>'],
    ["#priceblock_ourprice", '<span id="priceblock_ourprice" class="a-size-medium a-color-price">$24.99</span>'],
    ["#priceblock_dealprice", '<span id="priceblock_dealprice" class="a-size-medium a-color-price">$24.99</span>'],
    [
      "#tp_price_block_total_price_ww",
      '<div id="tp_price_block_total_price_ww"><span class="a-price"><span class="a-offscreen">$24.99</span></span></div>'
    ]
  ])("reads the item price from %s", (_selector, body) => {
    expect(itemPrice(body)?.item).toEqual({ amount: 24.99, currency: "USD" });
  });

  it("reads no item price from per-unit, list or twister prices alone", () => {
    const breakdown = itemPrice(
      `<div id="corePriceDisplay_desktop_feature_div">${PER_UNIT}<span class="a-price a-text-price apex-basisprice-value"><span class="a-offscreen">$29.99</span></span></div>` +
        '<div id="inline-twister-row-size_name"><span class="a-price aok-align-center"><span class="a-offscreen">$9.99</span></span></div>'
    );

    expect(breakdown).toBeUndefined();
  });
});

describe("product extractor delivery charges", () => {
  describe("free delivery", () => {
    it("treats FREE delivery followed by a date as free shipping", () => {
      const result = extract('<div id="deliveryBlockMessage">FREE delivery <span class="a-text-bold">Tuesday, October 21</span></div>');

      expect(result.breakdown?.shipping).toEqual({ amount: 0, currency: "USD" });
      expect(result.hasShippingInfo).toBe(true);
      expect(result.notes).not.toContain("Shipping not displayed for destination");
    });

    it("keeps shipping free when the delivery slot also carries a cutoff time and an order threshold", () => {
      const result = extract(
        '<div id="mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_LARGE">FREE delivery Tuesday, October 21 on orders shipped by Amazon over $35. Order within 5 hrs 12 mins</div>'
      );

      expect(result.breakdown?.shipping).toEqual({ amount: 0, currency: "USD" });
      expect(result.hasShippingInfo).toBe(true);
    });

    it("does not read a date held in a price-coloured element as a price", () => {
      const result = extract('<div id="deliveryBlockMessage">FREE delivery <span class="a-color-price">Tuesday, October 21</span></div>');

      expect(result.breakdown?.shipping).toEqual({ amount: 0, currency: "USD" });
      expect(result.hasShippingInfo).toBe(true);
    });

    it("prefers an explicit price element over a free marker in the same block", () => {
      const result = extract(
        '<div id="deliveryBlockMessage">FREE delivery over $35, otherwise <span class="a-color-price">$5.99</span> delivery Tuesday, October 21</div>'
      );

      expect(result.breakdown?.shipping).toEqual({ amount: 5.99, currency: "USD" });
    });
  });

  describe("explicit shipping prices", () => {
    it("reads a shipping price element that sits next to a delivery date", () => {
      const result = extract(
        '<div id="deliveryBlockMessage">Shipping <span class="a-color-price">$5.99</span> arrives Tuesday, October 21</div>'
      );

      expect(result.breakdown?.shipping).toEqual({ amount: 5.99, currency: "USD" });
      expect(result.hasShippingInfo).toBe(true);
    });

    it("reads a shipping price written in plain text next to a delivery date", () => {
      const result = extract('<div id="deliveryBlockMessage">$5.99 delivery Tuesday, October 21</div>');

      expect(result.breakdown?.shipping).toEqual({ amount: 5.99, currency: "USD" });
      expect(result.hasShippingInfo).toBe(true);
    });

    it("reads a trailing currency symbol before a day-month date", () => {
      const result = extract('<div id="deliveryBlockMessage">Versand 4,50 € Dienstag, 21. Oktober</div>', "DE");

      expect(result.breakdown?.shipping).toEqual({ amount: 4.5, currency: "EUR" });
    });

    it("reads a yen shipping charge written with 円 before a Japanese date", () => {
      const result = extract('<div id="deliveryBlockMessage">配達料 500円 10月21日 火曜日</div>', "JP");

      expect(result.breakdown?.shipping).toEqual({ amount: 500, currency: "JPY" });
    });

    it.each([
      { label: "Shipping €4,50 in a price element", block: 'Shipping <span class="a-color-price">€4,50</span>', market: "DE", amount: 4.5, currency: "EUR" },
      { label: "Shipping €4,50 in plain text", block: "Shipping €4,50", market: "DE", amount: 4.5, currency: "EUR" },
      { label: "+ $12.99 Shipping in plain text", block: "+ $12.99 Shipping", market: "US", amount: 12.99, currency: "USD" },
      { label: "+ $12.99 Shipping in an offscreen price", block: '+ <span class="a-offscreen">$12.99</span> Shipping', market: "US", amount: 12.99, currency: "USD" }
    ] as const)("keeps parsing $label", ({ block, market, amount, currency }) => {
      const result = extract(`<div id="deliveryBlockMessage">${block}</div>`, market);

      expect(result.breakdown?.shipping).toEqual({ amount, currency });
      expect(result.hasShippingInfo).toBe(true);
    });
  });

  describe("import fees", () => {
    it.each([
      { label: "in plain text", block: "Import Fees Deposit CA$41.62" },
      { label: "in a price element", block: 'Import Fees Deposit <span class="a-color-price">CA$41.62</span>' },
      { label: "with an arrival date", block: "Import Fees Deposit CA$41.62 · Arrives Tuesday, October 21" }
    ])("reads an import fees deposit with a price $label", ({ block }) => {
      const result = extract(
        `<div id="deliveryBlockMessage">FREE delivery Tuesday, October 21</div><div id="exports_desktop_feature_div">${block}</div>`,
        "CA"
      );

      expect(result.breakdown?.importFees).toEqual({ amount: 41.62, currency: "CAD" });
      expect(result.hasImportInfo).toBe(true);
    });

    it("treats a No Import Fees Deposit marker as zero import fees", () => {
      const result = extract(
        '<div id="deliveryBlockMessage">FREE delivery Tuesday, October 21</div><div id="exports_desktop_feature_div">No Import Fees Deposit</div>'
      );

      expect(result.breakdown?.importFees).toEqual({ amount: 0, currency: "USD" });
      expect(result.hasImportInfo).toBe(true);
      expect(result.notes).not.toContain("Import fees not displayed for destination");
    });

    it.each(["No Import Fees Deposit", "No Import Charges"])(
      "reads %s beside a shipping price element in the same block as zero import fees",
      (marker) => {
        const result = extract(`<div id="deliveryBlockMessage">${marker} &amp; <span class="a-color-price">$12.99</span> Shipping to Canada</div>`);

        expect(result.breakdown?.shipping).toEqual({ amount: 12.99, currency: "USD" });
        expect(result.breakdown?.importFees).toEqual({ amount: 0, currency: "USD" });
      }
    );

    it("splits a combined No Import Fees Deposit and shipping line into zero import fees and the shipping price", () => {
      const result = extract('<div id="deliveryBlockMessage">No Import Fees Deposit &amp; $12.99 Shipping to Canada</div>');

      expect(result.breakdown?.shipping).toEqual({ amount: 12.99, currency: "USD" });
      expect(result.breakdown?.importFees).toEqual({ amount: 0, currency: "USD" });
    });
  });

  describe("the delivery message's price attribute", () => {
    function deliveryBlock(primary: string, secondary = 'data-csa-c-delivery-price="fastest"'): string {
      return `<div id="deliveryBlockMessage"><div id="mir-layout-DELIVERY_BLOCK"><div id="mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_LARGE"><span ${primary}> Delivery <span class="a-text-bold">Thursday, November 5</span> to Switzerland. Order within 7 hrs 52 mins</span></div><div id="mir-layout-DELIVERY_BLOCK-slot-SECONDARY_DELIVERY_MESSAGE_LARGE"><span ${secondary}> Or fastest delivery <span class="a-text-bold">Wednesday, October 28</span></span></div></div></div>`;
    }

    it("reads the delivery charge from the attribute when the message text shows none", () => {
      const result = extract(deliveryBlock('data-csa-c-delivery-price="$17.88" data-csa-c-delivery-destination="Switzerland"'));

      expect(result.breakdown?.shipping).toEqual({ amount: 17.88, currency: "USD" });
      expect(result.hasShippingInfo).toBe(true);
    });

    it.each([
      { value: "CHF&nbsp;41.36", market: "DE", shipping: { amount: 41.36, currency: "CHF" } },
      { value: "¥4716", market: "JP", shipping: { amount: 4716, currency: "JPY" } },
      { value: "FREE", market: "US", shipping: { amount: 0, currency: "USD" } }
    ] as const)("reads the attribute value $value on $market", ({ value, market, shipping }) => {
      const result = extract(deliveryBlock(`data-csa-c-delivery-price="${value}"`), market);

      expect(result.breakdown?.shipping).toEqual(shipping);
    });

    it("does not quote the price of the fastest delivery option", () => {
      const result = extract(deliveryBlock("", 'data-csa-c-delivery-price="$29.99"'));

      expect(result.hasShippingInfo).toBe(false);
      expect(result.breakdown?.shipping).toBeUndefined();
    });
  });

  describe("blocks without a price", () => {
    it("reports no shipping info for a delivery block with only a date", () => {
      const result = extract('<div id="deliveryBlockMessage">Delivery Tuesday, October 21</div>');

      expect(result.hasShippingInfo).toBe(false);
      expect(result.breakdown?.shipping).toBeUndefined();
      expect(result.notes).toContain("Shipping not displayed for destination");
    });

    it("reports no import info for an import block with only a date", () => {
      const result = extract(
        '<div id="deliveryBlockMessage">FREE delivery Tuesday, October 21</div><div id="exports_desktop_feature_div">Import fees deposit due at checkout on October 21</div>'
      );

      expect(result.hasImportInfo).toBe(false);
      expect(result.breakdown?.importFees).toBeUndefined();
      expect(result.notes).toEqual(["Import fees not displayed for destination"]);
    });

    it("lowers the parse confidence when neither shipping nor import can be read", () => {
      const result = extract('<div id="deliveryBlockMessage">Delivery Tuesday, October 21</div>');

      expect(result.parseConfidence).toBe(0.6);
      expect(result.notes).toEqual(["Shipping not displayed for destination", "Import fees not displayed for destination"]);
    });
  });
});

describe("product extractor identity", () => {
  function pageAt(url: string, head: string, body: string, marketplace: Marketplace = "US"): ProductExtractionResult {
    const dom = new JSDOM(`<!doctype html><html><head>${head}</head><body>${body}</body></html>`, { url });
    return extractProductData(dom.window.document, { marketplace, sourceDestinationCountryCode: marketplace }, dom.window.location.href);
  }

  it("reads the ASIN from the page's ASIN field ahead of a canonical link to another ASIN", () => {
    const result = pageAt(
      "https://www.amazon.de/dp/B09LCMVB3F",
      '<link rel="canonical" href="https://www.amazon.de/-/en/Anker-100-Cable-Fast-Charging/dp/B0FC6LDVBP" />',
      '<input type="hidden" id="ASIN" name="ASIN" value="b09lcmvb3f" />',
      "DE"
    );

    expect(result.asin).toBe("B09LCMVB3F");
    expect(result.canonicalUrl).toBe("https://www.amazon.de/-/en/Anker-100-Cable-Fast-Charging/dp/B0FC6LDVBP");
  });

  it("reads the ASIN from a /clp/ canonical link when the page has no ASIN field", () => {
    const result = pageAt(
      "https://www.amazon.com/dp/B09XS7JWHH",
      '<link rel="canonical" href="https://www.amazon.com/clp/B09XS7JWHH" />',
      '<span id="productTitle"> Sony WH-1000XM5 Premium Noise Cancelling Wireless Headphones, Black </span>'
    );

    expect(result).toMatchObject({
      asin: "B09XS7JWHH",
      title: "Sony WH-1000XM5 Premium Noise Cancelling Wireless Headphones, Black"
    });
  });

  it("collapses the whitespace Amazon leaves inside the product title", () => {
    const result = pageAt("https://www.amazon.com/dp/B09XS7JWHH", "", '<span id="productTitle">\n   Sony WH-1000XM5\n   Headphones   </span>');

    expect(result.title).toBe("Sony WH-1000XM5 Headphones");
  });

  it("returns no ASIN and no title for a not-found page served at a product URL", () => {
    const result = pageAt(
      "https://www.amazon.co.uk/dp/B09XS7JWHH",
      "<title>Page Not Found</title>",
      '<a href="/ref=cs_404_logo"><img alt="Sorry! We couldn\'t find that page. Try searching or go to Amazon\'s home page." /></a>',
      "UK"
    );

    expect(result.asin).toBeUndefined();
    expect(result.title).toBeUndefined();
    expect(result.breakdown).toBeUndefined();
    expect(result.canonicalUrl).toBe("https://www.amazon.co.uk/dp/B09XS7JWHH");
  });
});

function extractLive(
  file: string,
  marketplace: Marketplace,
  sourceDestinationCountryCode: string = marketplace,
  prepare?: (document: Document) => void
): ProductExtractionResult {
  const html = readFileSync(join(process.cwd(), "tests", "fixtures", "product-live", file), "utf8");
  const probe = new JSDOM(html);
  const url = probe.window.document.querySelector("meta[name='source-url']")?.getAttribute("content") ?? "";
  const dom = new JSDOM(html, { url });
  prepare?.(dom.window.document);
  return extractProductData(dom.window.document, { marketplace, sourceDestinationCountryCode }, dom.window.location.href);
}

describe("product extractor on pages for a delivery address in Switzerland", () => {
  it("explains a page that cannot ship to the address instead of failing", () => {
    const result = extractLive("US-cannot-ship-to-switzerland.html", "US");

    expect(result.breakdown).toBeUndefined();
    expect(result.isDeliverable).toBe(false);
    expect(result.parseConfidence).toBe(0.1);
    expect(result.notes).toEqual([
      "Price not displayed for destination",
      "Amazon says: This item cannot be shipped to your selected delivery location. Please choose a different delivery location.",
      "Shipping not displayed for destination",
      "Import fees not displayed for destination"
    ]);
  });

  it("reads the delivered cost of a product that ships there from amazon.com from the AmazonGlobal details", () => {
    const result = extractLive("US-ships-to-switzerland.html", "US");

    expect(result.breakdown).toEqual({
      item: { amount: 13.59, currency: "USD" },
      shipping: { amount: 17.3, currency: "USD" },
      importFees: { amount: 0, currency: "USD" },
      totalDisplayed: { amount: 30.89, currency: "USD" }
    });
    expect(result.hasShippingInfo).toBe(true);
    expect(result.hasImportInfo).toBe(true);
    expect(result.notes).toEqual([]);
  });

  it.each([
    { label: "as captured", remove: [], totalDisplayed: { amount: 206.27, currency: "USD" } },
    { label: "without its AmazonGlobal details", remove: ["#amazonGlobal_feature_div .a-popover-preload"], totalDisplayed: undefined }
  ])("reads the shipping and import charges of an amazon.com page that charges both $label", ({ remove, totalDisplayed }) => {
    const result = extractLive("US-shipping-and-import-charges.html", "US", "US", (document) => {
      remove.forEach((selector) => document.querySelectorAll(selector).forEach((element) => element.remove()));
    });

    expect(result.breakdown).toEqual({
      item: { amount: 129.95, currency: "USD" },
      shipping: { amount: 39.1, currency: "USD" },
      importFees: { amount: 37.22, currency: "USD" },
      totalDisplayed
    });
    expect(deliveredTotal(result.breakdown)).toEqual({ amount: 206.27, currency: "USD" });
    expect(result.notes).toEqual([]);
  });

  it("quotes the AmazonGlobal line's sum as shipping when the amazon.com page shows neither its details nor a delivery price", () => {
    const result = extractLive("US-shipping-and-import-charges.html", "US", "US", (document) => {
      document.querySelectorAll("#amazonGlobal_feature_div .a-popover-preload, #deliveryBlockMessage").forEach((element) => element.remove());
    });

    expect(result.breakdown).toEqual({
      item: { amount: 129.95, currency: "USD" },
      shipping: { amount: 76.32, currency: "USD" },
      importFees: undefined
    });
    expect(deliveredTotal(result.breakdown)).toEqual({ amount: 206.27, currency: "USD" });
    expect(result.notes).toEqual(["Import fees not displayed for destination"]);
  });

  it("still reads the Swiss franc price and delivery of a product that ships there from amazon.de", () => {
    const result = extractLive("DE-ships-to-switzerland.html", "DE");

    expect(result.breakdown?.item).toEqual({ amount: 78.27, currency: "CHF" });
    expect(result.breakdown?.shipping).toEqual({ amount: 41.36, currency: "CHF" });
    expect(result.notes).toEqual(["Import fees not displayed for destination"]);
  });
});

describe("product extractor on live pages of one cable for a delivery address in Switzerland", () => {
  interface LivePage {
    file: string;
    market: Marketplace;
    asin: string;
    breakdown?: PriceBreakdown;
    delivered?: Money;
    availability: ListingAvailability;
    notes: string[];
  }

  const NO_IMPORT_FEES_NOTE = "Import fees not displayed for destination";
  const priceless = (notice: string): string[] => [
    "Price not displayed for destination",
    `Amazon says: ${notice}`,
    "Shipping not displayed for destination",
    NO_IMPORT_FEES_NOTE
  ];

  const LIVE_PAGES: LivePage[] = [
    {
      file: "US-no-import-charges.html",
      market: "US",
      asin: "B09LCMVB3F",
      breakdown: {
        item: { amount: 18.99, currency: "USD" },
        shipping: { amount: 17.88, currency: "USD" },
        importFees: { amount: 0, currency: "USD" },
        totalDisplayed: { amount: 36.87, currency: "USD" }
      },
      delivered: { amount: 36.87, currency: "USD" },
      availability: "available",
      notes: []
    },
    {
      file: "DE-new-and-used-offers.html",
      market: "DE",
      asin: "B09LCMVB3F",
      breakdown: { item: { amount: 78.27, currency: "CHF" }, shipping: { amount: 41.36, currency: "CHF" } },
      delivered: { amount: 119.63, currency: "CHF" },
      availability: "available",
      notes: [NO_IMPORT_FEES_NOTE]
    },
    {
      file: "UK-deal-ships-to-switzerland.html",
      market: "UK",
      asin: "B0F62PGJSM",
      breakdown: { item: { amount: 32.8, currency: "CHF" }, shipping: { amount: 36.34, currency: "CHF" } },
      delivered: { amount: 69.14, currency: "CHF" },
      availability: "available",
      notes: [NO_IMPORT_FEES_NOTE]
    },
    {
      file: "JP-deal-ships-to-switzerland.html",
      market: "JP",
      asin: "B0FJ1XPCTR",
      breakdown: { item: { amount: 804, currency: "JPY" }, shipping: { amount: 4716, currency: "JPY" } },
      delivered: { amount: 5520, currency: "JPY" },
      availability: "available",
      notes: [NO_IMPORT_FEES_NOTE]
    },
    {
      file: "UK-cannot-dispatch-to-switzerland.html",
      market: "UK",
      asin: "B09LCMVB3F",
      availability: "undeliverable",
      notes: priceless("This item cannot be dispatched to your selected delivery location. Please choose a different delivery location.")
    },
    {
      file: "JP-cannot-ship-to-switzerland.html",
      market: "JP",
      asin: "B09LCMVB3F",
      availability: "undeliverable",
      notes: priceless("This item cannot be shipped to your selected delivery location. Please choose a different delivery location.")
    }
  ];

  it.each(LIVE_PAGES)("reads the cost stack of $file", ({ file, market, asin, breakdown, delivered, availability, notes }) => {
    const result = extractLive(file, market, "US");

    expect(result.asin).toBe(asin);
    expect(result.breakdown).toEqual(breakdown);
    expect(deliveredTotal(result.breakdown)).toEqual(delivered);
    expect(result).toMatchObject({
      destinationCountryCode: undefined,
      destinationMatched: true,
      isDeliverable: breakdown !== undefined,
      availability
    });
    expect(result.notes).toEqual(notes);
  });

  it.each(LIVE_PAGES.filter((page) => page.breakdown))(
    "still reads the item price of $file from the centre column when the buy box shows none",
    ({ file, market, breakdown }) => {
      const result = extractLive(file, market, "US", (document) => {
        document.querySelectorAll("#corePrice_feature_div").forEach((element) => element.remove());
      });

      expect(result.breakdown?.item).toEqual(breakdown?.item);
    }
  );

  it.each([
    {
      without: "its AmazonGlobal details",
      selector: "#amazonGlobal_feature_div .a-popover-preload",
      importFees: { amount: 0, currency: "USD" },
      notes: []
    },
    { without: "any AmazonGlobal block", selector: "#amazonGlobal_feature_div", importFees: undefined, notes: [NO_IMPORT_FEES_NOTE] }
  ])("still reads the amazon.com shipping without $without", ({ selector, importFees, notes }) => {
    const result = extractLive("US-no-import-charges.html", "US", "US", (document) => {
      document.querySelectorAll(selector).forEach((element) => element.remove());
    });

    expect(result.breakdown).toEqual({
      item: { amount: 18.99, currency: "USD" },
      shipping: { amount: 17.88, currency: "USD" },
      importFees
    });
    expect(result.notes).toEqual(notes);
  });

  it("reads the amazon.ca page that kept an address in Canada as a destination mismatch", () => {
    const result = extractLive("CA-domestic-address.html", "CA", "US");

    expect(result.asin).toBe("B09LCD851Z");
    expect(result.breakdown).toEqual({ item: { amount: 16.99, currency: "CAD" }, shipping: { amount: 0, currency: "CAD" } });
    expect(deliveredTotal(result.breakdown)).toEqual({ amount: 16.99, currency: "CAD" });
    expect(result).toMatchObject({
      destinationCountryCode: "CA",
      destinationMatched: false,
      isDeliverable: false,
      availability: "available"
    });
    expect(result.notes).toEqual([NO_IMPORT_FEES_NOTE, "Destination mismatch detected (CA)"]);
  });

  it("reads the centre column price of the amazon.ca page, not its per-unit price, when the buy box shows none", () => {
    const result = extractLive("CA-domestic-address.html", "CA", "US", (document) => {
      document.querySelectorAll("#corePrice_feature_div").forEach((element) => element.remove());
    });

    expect(result.breakdown?.item).toEqual({ amount: 16.99, currency: "CAD" });
  });
});

describe("product extractor delivery address", () => {
  function deliveringTo(blocks: string): ProductExtractionResult {
    const dom = new JSDOM(
      `<!doctype html><html><body><div id="corePriceDisplay_desktop_feature_div"><span class="a-price"><span class="a-offscreen">$498.00</span></span></div>${blocks}</body></html>`,
      { url: "https://www.amazon.ca/dp/B09XS7JWHH" }
    );
    return extractProductData(dom.window.document, { marketplace: "CA", sourceDestinationCountryCode: "US" }, dom.window.location.href);
  }

  function readDestination(market: Marketplace, host: string, blocks: string): ProductExtractionResult {
    const dom = new JSDOM(
      `<!doctype html><html><body><div id="corePriceDisplay_desktop_feature_div"><span class="a-price"><span class="a-offscreen">12,34 €</span></span></div>${blocks}</body></html>`,
      { url: `https://${host}/dp/B09XS7JWHH` }
    );
    return extractProductData(dom.window.document, { marketplace: market, sourceDestinationCountryCode: "US" }, dom.window.location.href);
  }

  const DELIVER_TO_SWITZERLAND = '<span id="glow-ingress-line1">Deliver to</span><span id="glow-ingress-line2">Switzerland</span>';

  function deliverToBox(place: string): string {
    return `<span id="glow-ingress-line1">Deliver to Francis</span><span id="glow-ingress-line2">${place}</span>`;
  }

  it("reads an address given as a town and postcode as one in the marketplace's own country", () => {
    const result = deliveringTo(
      '<span id="glow-ingress-line1">Delivering to Balzac T4B 2T3</span><span id="glow-ingress-line2">Update location</span>' +
        '<span id="contextualIngressPtLabel">Delivering to Balzac T4B 2T3 – Update location</span>' +
        '<div id="mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_LARGE">FREE delivery Friday, October 23</div>'
    );

    expect(result.destinationCountryCode).toBe("CA");
    expect(result.destinationMatched).toBe(false);
    expect(result.notes).toContain("Destination mismatch detected (CA)");
  });

  it.each([
    ["UK", "www.amazon.co.uk", "London SW1A 1AA"],
    ["DE", "www.amazon.de", "Berlin 10115"],
    ["US", "www.amazon.com", "New York 10001"],
    ["AU", "www.amazon.com.au", "Sydney 2000"],
    ["JP", "www.amazon.co.jp", "Tokyo 100-0001"]
  ] as const)("reads a %s postcode on %s (%s) as an address at home", (market, host, place) => {
    const result = readDestination(market, host, deliverToBox(place));

    expect(result.destinationCountryCode).toBe(market === "UK" ? "GB" : market);
  });

  it.each([
    ["DE", "www.amazon.de", "Zurich 8001"],
    ["US", "www.amazon.com", "Zurich 8001"],
    ["UK", "www.amazon.co.uk", "Paris 75001"],
    ["AU", "www.amazon.com.au", "Berlin 10115"],
    ["JP", "www.amazon.co.jp", "Zurich 8001"]
  ] as const)("leaves a postcode that is not in the %s format on %s unresolved: %s", (market, host, place) => {
    const result = readDestination(market, host, deliverToBox(place));

    expect(result.destinationCountryCode).toBeUndefined();
    expect(result.destinationMatched).toBe(true);
  });

  it("leaves the town and postcode the source page also shows unresolved", () => {
    const dom = new JSDOM(`<!doctype html><html><body>${deliverToBox("Paris 75001")}</body></html>`, {
      url: "https://www.amazon.de/dp/B09XS7JWHH"
    });
    const read = (sourceDeliverTo?: string) =>
      extractProductData(
        dom.window.document,
        { marketplace: "DE", sourceDestinationCountryCode: "US", sourceDeliverTo },
        dom.window.location.href
      );

    expect(read("Deliver to Francis Paris 75001")).toMatchObject({ destinationCountryCode: undefined, destinationMatched: true });
    expect(read("Deliver to Francis New York 10001")).toMatchObject({ destinationCountryCode: "DE", destinationMatched: false });
    expect(read(undefined)).toMatchObject({ destinationCountryCode: "DE", destinationMatched: false });
  });

  it("leaves a country it does not know from the text alone unresolved, even beside a dated delivery message", () => {
    const result = deliveringTo(
      '<span id="glow-ingress-line1">Deliver to</span><span id="glow-ingress-line2">Switzerland</span>' +
        '<div id="deliveryBlockMessage">FREE delivery Friday, October 23</div>'
    );

    expect(result.destinationCountryCode).toBeUndefined();
    expect(result.destinationMatched).toBe(true);
  });

  describe("from the page fields Amazon renders for its own scripts", () => {
    function readFields(sourceDestinationCountryCode: string | undefined, blocks: string): ProductExtractionResult {
      const dom = new JSDOM(
        `<!doctype html><html><body><div id="corePriceDisplay_desktop_feature_div"><span class="a-price"><span class="a-offscreen">12,34 €</span></span></div>${blocks}</body></html>`,
        { url: "https://www.amazon.de/dp/B09XS7JWHH" }
      );
      return extractProductData(dom.window.document, { marketplace: "DE", sourceDestinationCountryCode }, dom.window.location.href);
    }

    it("matches Switzerland on a page that the source also delivers to Switzerland", () => {
      const result = readFields("CH", `${DELIVER_TO_SWITZERLAND}${destinationFields({ vas: "CH", input: "CH", nav: "CH" })}`);

      expect(result).toMatchObject({ destinationCountryCode: "CH", destinationMatched: true });
      expect(result.notes).not.toContain("Destination mismatch detected (CH)");
    });

    it("reports Switzerland on a page for a source that delivers to the United States as a mismatch", () => {
      const result = readFields("US", `${DELIVER_TO_SWITZERLAND}${destinationFields({ input: "CH" })}`);

      expect(result).toMatchObject({ destinationCountryCode: "CH", destinationMatched: false });
      expect(result.notes).toContain("Destination mismatch detected (CH)");
    });

    it("prefers the page fields to a country the Deliver to box names", () => {
      const result = readFields(
        "CH",
        `<span id="glow-ingress-line1">Deliver to</span><span id="glow-ingress-line2">Germany</span>${destinationFields({ vas: "CH", nav: null })}`
      );

      expect(result).toMatchObject({ destinationCountryCode: "CH", destinationMatched: true });
    });

    it("matches any page when the source destination is unknown", () => {
      const result = readFields(undefined, `${DELIVER_TO_SWITZERLAND}${destinationFields({ input: "CH" })}`);

      expect(result).toMatchObject({ destinationCountryCode: "CH", destinationMatched: true });
    });
  });

  it.each([
    ["ES", "www.amazon.es", "Entrega por 12,34 € el lunes, 9 de noviembre"],
    ["MX", "www.amazon.com.mx", "Envío por $250.00 el martes, 28 de octubre"],
    ["US", "www.amazon.com", "Get it as soon as Tuesday, Oct 28 if you order within 3 hrs"],
    ["ES", "www.amazon.es", "Envío GRATIS de productos usados el lunes"]
  ] as const)("does not read a country from the words of a %s delivery message on %s: %s", (market, host, message) => {
    const result = readDestination(market, host, `${DELIVER_TO_SWITZERLAND}<div id="deliveryBlockMessage">${message}</div>`);

    expect(result.destinationCountryCode).toBeUndefined();
    expect(result.destinationMatched).toBe(true);
  });

  it("reads the country the delivery message names in its destination attribute", () => {
    const result = readDestination(
      "US",
      "www.amazon.com",
      '<div id="mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_LARGE"><span data-csa-c-delivery-destination="Canada"> Delivery Friday, October 23</span></div>'
    );

    expect(result.destinationCountryCode).toBe("CA");
    expect(result.destinationMatched).toBe(false);
  });

  it("still reads a country a delivery message names in full", () => {
    const result = readDestination(
      "DE",
      "www.amazon.de",
      `${DELIVER_TO_SWITZERLAND}<div id="deliveryBlockMessage">Lieferung nach Deutschland am Dienstag</div>`
    );

    expect(result.destinationCountryCode).toBe("DE");
  });

  it("leaves the live amazon.de page for an address in Switzerland unresolved from its text alone", () => {
    const html = readFileSync(join(process.cwd(), "tests", "fixtures", "product-live", "DE-ships-to-switzerland.html"), "utf8");
    const dom = new JSDOM(html, { url: "https://www.amazon.de/dp/B09LCMVB3F" });
    const result = extractProductData(dom.window.document, { marketplace: "DE", sourceDestinationCountryCode: "US" }, dom.window.location.href);

    expect(result.destinationCountryCode).toBeUndefined();
    expect(result.destinationMatched).toBe(true);
  });
});

describe("product extractor variants", () => {
  it("reads the selected variant and every variant the twister offers", () => {
    const result = extractLive("UK-other-colour.html", "UK");

    expect(result.asin).toBe("B09Y2LL45F");
    expect(result.selectedVariants).toEqual(["With Hard Case", "Silver"]);
    expect(result.variantOptions).toEqual([
      { asin: "B09Y2LL45F", label: "With Hard Case" },
      { asin: "B0F38PL24W", label: "With Soft Case" },
      { asin: "B09Y2LL45F", label: "Silver" },
      { asin: "B09Y2MYL5C", label: "Black" },
      { asin: "B0BXM22X99", label: "Midnight Blue" },
      { asin: "B0DBLP647C", label: "Smoky Pink" }
    ]);
  });

  it("reads the selected variant from the older variation selectors", () => {
    const result = extract(
      '<div id="variation_color_name"><span class="selection"> Blue </span></div><div id="variation_size_name"><span class="selection">16 oz</span></div>'
    );

    expect(result.selectedVariants).toEqual(["Blue", "16 oz"]);
    expect(result.variantOptions).toEqual([]);
  });

  it("returns no variants for a page without a twister", () => {
    const result = extract("");

    expect(result.selectedVariants).toEqual([]);
    expect(result.variantOptions).toEqual([]);
  });
});

describe("product extractor pages without a price", () => {
  function priceless(body: string): ProductExtractionResult {
    const dom = new JSDOM(`<!doctype html><html><body><span id="productTitle">Sony WH-1000XM5</span>${body}</body></html>`, {
      url: "https://www.amazon.de/dp/B09XS7JWHH"
    });
    return extractProductData(dom.window.document, { marketplace: "DE", sourceDestinationCountryCode: "DE" }, dom.window.location.href);
  }

  it("relays Amazon's availability message", () => {
    const result = priceless(
      '<div id="availability"><span class="a-size-medium a-color-price primary-availability-message"> Currently unavailable.\n We don\'t know when or if this item will be back in stock. </span></div>'
    );

    expect(result.notes.slice(0, 2)).toEqual([
      "Price not displayed for destination",
      "Amazon says: Currently unavailable. We don't know when or if this item will be back in stock."
    ]);
  });

  it("reads the message itself, not the script Amazon keeps beside it", () => {
    const result = priceless(
      '<div id="availability"><script>P.when("A", "load").execute(function () {});</script><span class="primary-availability-message">No disponible por el momento.</span></div>'
    );

    expect(result.notes).toContain("Amazon says: No disponible por el momento.");
  });

  it("notes the missing price when the page gives no reason", () => {
    expect(priceless("").notes).toEqual([
      "Price not displayed for destination",
      "Shipping not displayed for destination",
      "Import fees not displayed for destination"
    ]);
  });
});

describe("product extractor listing availability", () => {
  function unpriced(body: string): ProductExtractionResult {
    const dom = new JSDOM(`<!doctype html><html><body><span id="productTitle">Sony WH-1000XM5</span>${body}</body></html>`, {
      url: "https://www.amazon.de/dp/B09XS7JWHH"
    });
    return extractProductData(dom.window.document, { marketplace: "DE", sourceDestinationCountryCode: "DE" }, dom.window.location.href);
  }

  function availabilityMessage(text: string): string {
    return `<div id="availability"><span class="a-size-medium a-color-base primary-availability-message"> ${text} </span></div>`;
  }

  it("reports the live amazon.de page of a dead listing as unavailable", () => {
    const result = extractLive("DE-currently-unavailable.html", "DE");

    expect(result).toMatchObject({
      asin: "B09XS7JWHH",
      title: "Sony WH-1000XM5 Wireless Industry Leading",
      availability: "unavailable",
      breakdown: undefined
    });
    expect(result.notes).toEqual([
      "Price not displayed for destination",
      "Amazon says: Currently unavailable.",
      "Shipping not displayed for destination",
      "Import fees not displayed for destination"
    ]);
  });

  it("reports the live amazon.com page of a dead listing as unavailable, not at the price of the sponsored items above it", () => {
    const result = extractLive("US-currently-unavailable-sponsored.html", "US");

    expect(result).toMatchObject({
      asin: "B09HM94VDS",
      availability: "unavailable",
      isDeliverable: false,
      breakdown: undefined
    });
    expect(result.notes).toEqual([
      "Price not displayed for destination",
      "Amazon says: Currently unavailable.",
      "Shipping not displayed for destination",
      "Import fees not displayed for destination"
    ]);
  });

  it.each([
    ["US-cannot-ship-to-switzerland.html", "US"],
    ["UK-other-colour.html", "UK"]
  ] as const)("reports the live page %s that cannot reach the address as undeliverable", (file, market) => {
    expect(extractLive(file, market).availability).toBe("undeliverable");
  });

  it.each([
    ["US-ships-to-switzerland.html", "US"],
    ["DE-ships-to-switzerland.html", "DE"]
  ] as const)("reports the priced live page %s as available", (file, market) => {
    expect(extractLive(file, market).availability).toBe("available");
  });

  it("reports a priced page as available", () => {
    expect(extract("").availability).toBe("available");
  });

  it.each([
    ["English", "Currently unavailable."],
    ["German", "Derzeit nicht verfügbar."],
    ["French", "Actuellement indisponible."],
    ["Italian", "Attualmente non disponibile."],
    ["Spanish", "No disponible por el momento."],
    ["Japanese", "現在在庫切れです。"]
  ])("reads the %s notice %s as unavailable", (_language, text) => {
    expect(unpriced(availabilityMessage(text)).availability).toBe("unavailable");
  });

  it("reads an out-of-stock box in the buy box as unavailable", () => {
    const result = unpriced(
      '<div id="outOfStock" class="a-box"><span class="a-color-base a-text-bold">在庫切れ</span><br>入荷時期は未定です。</div>'
    );

    expect(result.availability).toBe("unavailable");
  });

  it.each([
    ["English", "This item cannot be shipped to your selected delivery location. Please choose a different delivery location."],
    ["British English", "This item cannot be dispatched to your selected delivery location. Please choose a different delivery location."],
    ["German", "Dieser Artikel kann nicht an den ausgewählten Lieferort versendet werden."],
    ["French", "Cet article ne peut pas être expédié à l'adresse de livraison sélectionnée."],
    ["Italian", "Questo articolo non può essere spedito all'indirizzo di consegna selezionato."],
    ["Spanish", "Este producto no se puede enviar a la dirección de entrega seleccionada."],
    ["Japanese", "この商品は、選択したお届け先に発送できません。"]
  ])("reads the %s notice %s as undeliverable", (_language, text) => {
    expect(unpriced(availabilityMessage(text)).availability).toBe("undeliverable");
  });

  it("leaves a page without a price whose notice it does not recognise unknown", () => {
    expect(unpriced(availabilityMessage("Usually dispatched within 1 to 2 months.")).availability).toBe("unknown");
  });

  it("leaves a page without a price but with a way to buy unknown", () => {
    expect(unpriced('<input id="add-to-cart-button" type="submit" value="Add to basket">').availability).toBe("unknown");
    expect(unpriced('<span id="buybox-see-all-buying-choices"><a href="/gp/offer-listing/B09XS7JWHH">See All Buying Options</a></span>').availability).toBe(
      "unknown"
    );
  });

  it("reports a page with no price, no notice and no way to buy as unavailable", () => {
    expect(unpriced("").availability).toBe("unavailable");
    expect(unpriced('<div id="buybox"><form id="addToCart"></form></div>').availability).toBe("unavailable");
  });

  it("does not read the script Amazon keeps in the availability block as a notice", () => {
    const result = unpriced(
      '<div id="availability"><script>var notice = "This item cannot be shipped to your selected delivery location";</script>In stock</div>'
    );

    expect(result.availability).toBe("unknown");
  });
});

describe("product extractor AmazonGlobal details", () => {
  function globalDetails(rows: Array<[string, string]>): string {
    const cells = rows
      .map(
        ([label, value]) =>
          `<tr><td class="a-span9 a-text-left"><span class="a-size-base a-color-secondary"> ${label} </span></td><td class="a-span1 a-text-right"></td><td class="a-span2 a-text-right"><span class="a-size-base a-color-base"> ${value} </span></td></tr>`
      )
      .join('<tr><td><hr class="a-divider-normal"></td></tr>');
    return `<div id="amazonGlobal_feature_div"><span class="a-size-base a-color-secondary">$21.52 Shipping &amp; Import Charges to Switzerland</span><div class="a-popover-preload"><h3>Shipping &amp; Fee Details</h3><table class="a-lineitem"><tbody>${cells}</tbody></table></div></div>`;
  }

  it("prefers the AmazonGlobal shipping and import charges over a conditional free delivery line", () => {
    const result = extract(
      `<div id="mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_LARGE">FREE delivery Thursday, November 5 to Switzerland on eligible orders over $49</div>
       ${globalDetails([
         ["Price", "$49.99"],
         ["AmazonGlobal Shipping", "$12.99"],
         ["Estimated Import Charges", "$8.53"],
         ["Total", "$71.51"]
       ])}`
    );

    expect(result.breakdown).toEqual({
      item: { amount: 49.99, currency: "USD" },
      shipping: { amount: 12.99, currency: "USD" },
      importFees: { amount: 8.53, currency: "USD" },
      totalDisplayed: { amount: 71.51, currency: "USD" }
    });
  });

  function globalLine(text: string): string {
    return `<div id="amazonGlobal_feature_div"><span class="a-size-base a-color-secondary"> ${text} </span><span class="a-declarative"><a class="a-popover-trigger"><span class="a-size-base"> Details </span></a></span></div>`;
  }

  it("reads No Import Charges and the shipping from the AmazonGlobal line when its details are missing", () => {
    const result = extract(globalLine("No Import Charges &amp; $17.88 Shipping to Switzerland"));

    expect(result.breakdown?.shipping).toEqual({ amount: 17.88, currency: "USD" });
    expect(result.breakdown?.importFees).toEqual({ amount: 0, currency: "USD" });
    expect(result.notes).toEqual([]);
  });

  it("reads the import charges and free shipping the AmazonGlobal line quotes", () => {
    const result = extract(globalLine("$32.67 Import Charges &amp; FREE Shipping to Switzerland"));

    expect(result.breakdown?.shipping).toEqual({ amount: 0, currency: "USD" });
    expect(result.breakdown?.importFees).toEqual({ amount: 32.67, currency: "USD" });
    expect(result.notes).toEqual([]);
  });

  function primaryDelivery(price: string): string {
    return `<div id="mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_LARGE"><span data-csa-c-delivery-price="${price}"> Delivery <span class="a-text-bold">Thursday, November 5</span> to Switzerland</span></div>`;
  }

  it("splits the AmazonGlobal line's sum of shipping and import charges with the delivery message's price", () => {
    const result = extract(primaryDelivery("$39.10") + globalLine("$76.32 Shipping &amp; Import Charges to Switzerland"));

    expect(result.breakdown?.shipping).toEqual({ amount: 39.1, currency: "USD" });
    expect(result.breakdown?.importFees).toEqual({ amount: 37.22, currency: "USD" });
    expect(result.notes).toEqual([]);
  });

  it("reads zero import fees when the delivery message's price equals the AmazonGlobal line's sum", () => {
    const result = extract(primaryDelivery("$76.32") + globalLine("$76.32 Shipping &amp; Import Charges to Switzerland"));

    expect(result.breakdown?.shipping).toEqual({ amount: 76.32, currency: "USD" });
    expect(result.breakdown?.importFees).toEqual({ amount: 0, currency: "USD" });
    expect(result.notes).toEqual([]);
  });

  it.each([
    ["no delivery price", ""],
    ["a conditional free delivery", primaryDelivery("FREE")],
    ["a delivery price above the sum", primaryDelivery("$80.00")]
  ])("quotes the AmazonGlobal line's sum of shipping and import charges as shipping beside %s", (_label, delivery) => {
    const result = extract(delivery + globalLine("$76.32 Shipping &amp; Import Charges to Switzerland"));

    expect(result.breakdown?.shipping).toEqual({ amount: 76.32, currency: "USD" });
    expect(result.breakdown?.importFees).toBeUndefined();
    expect(result.notes).toEqual(["Import fees not displayed for destination"]);
  });

  it("prefers the AmazonGlobal line to a conditional free delivery in the delivery message", () => {
    const result = extract(
      `<div id="mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_LARGE"><span data-csa-c-delivery-price="FREE"> FREE delivery Thursday, November 5 to Switzerland on eligible orders over $49</span></div>${globalLine(
        "No Import Charges &amp; $17.30 Shipping to Switzerland"
      )}`
    );

    expect(result.breakdown?.shipping).toEqual({ amount: 17.3, currency: "USD" });
  });

  it("lets the AmazonGlobal details win over the AmazonGlobal line", () => {
    const result = extract(
      globalDetails([
        ["Price", "$49.99"],
        ["AmazonGlobal Shipping", "$12.99"],
        ["Estimated Import Charges", "$8.53"],
        ["Total", "$71.51"]
      ]).replace("$21.52 Shipping &amp; Import Charges", "No Import Charges &amp; $11.00 Shipping")
    );

    expect(result.breakdown?.shipping).toEqual({ amount: 12.99, currency: "USD" });
    expect(result.breakdown?.importFees).toEqual({ amount: 8.53, currency: "USD" });
  });

  it("keeps reading the delivery block when the AmazonGlobal details are empty", () => {
    const result = extract('<div id="amazonGlobal_feature_div"></div><div id="deliveryBlockMessage">Shipping <span class="a-color-price">$6.00</span></div>');

    expect(result.breakdown?.shipping).toEqual({ amount: 6, currency: "USD" });
    expect(result.breakdown?.totalDisplayed).toBeUndefined();
  });
});

describe("product extractor other sellers' offers", () => {
  const LEGO_ASIN = "B0CGVJVQV8";
  const OFFERS_FIXTURES = join(process.cwd(), "tests", "fixtures", "offers-live");
  const QUOTED_NOTE = "Quoted another seller's offer";
  const NO_IMPORT_FEES_NOTE = "Import fees not displayed for destination";
  const OFFERS_PATH = "/gp/product/ajax/aodAjaxMain/ref=dp_aod_unknown_mbc";
  const PANEL_QUERY = `?asin=${LEGO_ASIN}&m=&qid=&smid=&sourcecustomerorglistid=&sourcecustomerorglistitemid=&sr=&pc=dp`;
  const BUYING_OPTIONS =
    '<span id="buybox-see-all-buying-choices"><span class="a-button-inner"><a class="a-button-text">See All Buying Options</a></span></span>';

  interface Answer {
    ok?: boolean;
    status?: number;
    body: string;
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  function panelBody(file: string): string {
    return new JSDOM(readFileSync(join(OFFERS_FIXTURES, file), "utf8")).window.document.body.innerHTML;
  }

  function fetchAnswering(answer: Answer) {
    return vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: answer.ok ?? true,
      status: answer.status ?? 200,
      text: async () => answer.body
    }));
  }

  function fetchFailing(error: Error) {
    return vi.fn(async (_url: string, _init?: RequestInit): Promise<{ ok: boolean; status: number; text: () => Promise<string> }> => {
      throw error;
    });
  }

  function legoPage(market: Marketplace, blocks: string = BUYING_OPTIONS): JSDOM {
    const host = HOST_BY_MARKET[market];
    if (!host) {
      throw new Error(`No test host for ${market}`);
    }
    return new JSDOM(
      `<!doctype html><html><body>
        <input type="hidden" id="ASIN" name="ASIN" value="${LEGO_ASIN}">
        <input type="hidden" id="countryCode" value="CH">
        <span id="productTitle"> LEGO Harry Potter Gringotts Wizarding Bank Collectors' Edition </span>
        <div id="olpLinkWidget_feature_div"><input type="hidden" id="all-offers-display-params" data-asin="${LEGO_ASIN}" data-m="" data-qid="" data-smid="" data-sourcecustomerorglistid="" data-sourcecustomerorglistitemid="" data-sr=""></div>
        ${blocks}
      </body></html>`,
      { url: `https://${host}/dp/${LEGO_ASIN}` }
    );
  }

  function read(page: JSDOM, market: Marketplace, fetchRef: Parameters<typeof extractProductDataWithOffers>[3]) {
    return extractProductDataWithOffers(
      page.window.document,
      { marketplace: market, sourceDestinationCountryCode: "CH", readOtherOffers: true },
      page.window.location.href,
      fetchRef
    );
  }

  function readPageAlone(page: JSDOM, market: Marketplace): ProductExtractionResult {
    return extractProductData(page.window.document, { marketplace: market, sourceDestinationCountryCode: "CH" }, page.window.location.href);
  }

  it("quotes the first new offer that delivers when the page shows no price and lists every one that does", async () => {
    const page = legoPage("DE");
    const fetchRef = fetchAnswering({ body: panelBody("DE-four-new-offers.html") });

    const result = await read(page, "DE", fetchRef);

    expect(result).toEqual({
      ...readPageAlone(page, "DE"),
      hasShippingInfo: true,
      hasImportInfo: false,
      isDeliverable: true,
      availability: "available",
      parseConfidence: 0.8,
      breakdown: { item: { amount: 651.25, currency: "EUR" }, shipping: { amount: 55.26, currency: "EUR" } },
      otherSeller: { seller: "Star Brick City", dispatcher: "Amazon", fulfilledByAmazon: true, offerCount: 4, deliveringNewCount: 4 },
      otherOffers: [
        {
          item: { amount: 651.25, currency: "EUR" },
          shipping: { amount: 55.26, currency: "EUR" },
          seller: "Star Brick City",
          dispatcher: "Amazon",
          fulfilledByAmazon: true
        },
        {
          item: { amount: 714.28, currency: "EUR" },
          shipping: { amount: 55.26, currency: "EUR" },
          seller: "BricksBoutique",
          dispatcher: "Amazon",
          fulfilledByAmazon: true
        },
        {
          item: { amount: 720.48, currency: "EUR" },
          shipping: { amount: 55.26, currency: "EUR" },
          seller: "Nucleus Investments",
          dispatcher: "Amazon",
          fulfilledByAmazon: true
        },
        {
          item: { amount: 973.41, currency: "EUR" },
          shipping: { amount: 19, currency: "EUR" },
          seller: "RamanDz",
          dispatcher: "RamanDz",
          fulfilledByAmazon: false
        }
      ],
      notes: [QUOTED_NOTE, NO_IMPORT_FEES_NOTE]
    });
    expect(result).toMatchObject({ asin: LEGO_ASIN, destinationCountryCode: "CH", destinationMatched: true });
    expect(deliveredTotal(result.breakdown)).toEqual({ amount: 706.51, currency: "EUR" });
  });

  it("asks the page's own origin for the panel, with the store's cookies", async () => {
    const fetchRef = fetchAnswering({ body: panelBody("DE-four-new-offers.html") });

    await read(legoPage("DE"), "DE", fetchRef);

    expect(fetchRef).toHaveBeenCalledTimes(1);
    expect(fetchRef).toHaveBeenCalledWith(
      `https://www.amazon.de${OFFERS_PATH}${PANEL_QUERY}`,
      expect.objectContaining({ credentials: "same-origin", signal: expect.any(AbortSignal) })
    );
  });

  it("drops Amazon's notice about the featured offer once another seller delivers", async () => {
    const page = legoPage(
      "UK",
      `${BUYING_OPTIONS}<div id="availability"><span class="primary-availability-message">This item cannot be dispatched to your selected delivery location. Please choose a different delivery location.</span></div>`
    );

    const result = await read(page, "UK", fetchAnswering({ body: panelBody("UK-item-in-pounds-delivery-in-francs.html") }));

    expect(readPageAlone(page, "UK").availability).toBe("undeliverable");
    expect(result.availability).toBe("available");
    expect(result.notes).toEqual([QUOTED_NOTE, NO_IMPORT_FEES_NOTE]);
  });

  it("quotes an item in pounds with its delivery in Swiss francs as Amazon shows them", async () => {
    const result = await read(legoPage("UK"), "UK", fetchAnswering({ body: panelBody("UK-item-in-pounds-delivery-in-francs.html") }));

    expect(result.breakdown).toEqual({ item: { amount: 574.97, currency: "GBP" }, shipping: { amount: 252.53, currency: "CHF" } });
    expect(result.otherSeller).toEqual({
      seller: "BuyMyBricks",
      dispatcher: "Amazon",
      fulfilledByAmazon: true,
      offerCount: 2,
      deliveringNewCount: 2
    });
    expect(result.otherOffers?.map(({ item, shipping, seller }) => ({ item, shipping, seller }))).toEqual([
      { item: { amount: 574.97, currency: "GBP" }, shipping: { amount: 252.53, currency: "CHF" }, seller: "BuyMyBricks" },
      { item: { amount: 699, currency: "GBP" }, shipping: { amount: 40.86, currency: "CHF" }, seller: "RamanDz" }
    ]);
    expect(deliveredTotal(result.breakdown)).toBeUndefined();
  });

  it("quotes nothing and says so when no other seller can ship there", async () => {
    const page = legoPage("MX");

    const result = await read(page, "MX", fetchAnswering({ body: panelBody("MX-one-offer-not-shippable.html") }));

    expect(result).toEqual({ ...readPageAlone(page, "MX"), notes: [...readPageAlone(page, "MX").notes, "No other seller delivers the item new to the destination"] });
    expect(result.breakdown).toBeUndefined();
    expect(result.otherSeller).toBeUndefined();
  });

  it.each([
    ["shows a price", `${BUYING_OPTIONS}<div id="corePriceDisplay_desktop_feature_div"><span class="a-price"><span class="a-offscreen">€699,99</span></span></div>`],
    ["has no See All Buying Options button", '<div id="availability"><span class="primary-availability-message">This item cannot be shipped to your selected delivery location.</span></div>'],
    ["is currently unavailable", `${BUYING_OPTIONS}<div id="availability"><span class="primary-availability-message">Currently unavailable.</span></div>`],
    [
      "delivers to another country than the source",
      `${BUYING_OPTIONS}<script type="a-state" data-a-state='{"key":"vas-base-vm"}'>{"countryCode":"DE"}</script>`
    ]
  ])("reads only the page when it %s", async (_case, blocks) => {
    const page = legoPage("DE", blocks);
    const fetchRef = fetchAnswering({ body: panelBody("DE-four-new-offers.html") });

    const result = await read(page, "DE", fetchRef);

    expect(fetchRef).not.toHaveBeenCalled();
    expect(result).toEqual(readPageAlone(page, "DE"));
  });

  it("reads only the page when the request does not ask for other offers", async () => {
    const page = legoPage("DE");
    const fetchRef = fetchAnswering({ body: panelBody("DE-four-new-offers.html") });

    const result = await extractProductDataWithOffers(
      page.window.document,
      { marketplace: "DE", sourceDestinationCountryCode: "CH" },
      page.window.location.href,
      fetchRef
    );

    expect(fetchRef).not.toHaveBeenCalled();
    expect(result).toEqual(readPageAlone(page, "DE"));
  });

  it("keeps the page's own reading with a note when the page names no ASIN to ask about", async () => {
    const page = legoPage("DE");
    page.window.document.querySelector("#ASIN")?.remove();
    page.window.document.querySelector("#all-offers-display-params")?.removeAttribute("data-asin");
    const fetchRef = fetchAnswering({ body: panelBody("DE-four-new-offers.html") });

    const result = await read(page, "DE", fetchRef);

    expect(fetchRef).not.toHaveBeenCalled();
    expect(result.notes.at(-1)).toBe("Other offers could not be read: the page names no ASIN");
    expect(result.breakdown).toBeUndefined();
  });

  it.each([
    ["Amazon answers with an error status", fetchAnswering({ ok: false, status: 503, body: "" }), "Amazon answered HTTP 503"],
    ["the request fails", fetchFailing(new TypeError("Failed to fetch")), "Failed to fetch"],
    [
      "Amazon answers with another page",
      fetchAnswering({ body: "<form name='signIn'><input id='ap_email'></form>" }),
      "Amazon's answer held no offer list"
    ]
  ])("keeps the page's own reading with a note when %s", async (_case, fetchRef, reason) => {
    const page = legoPage("DE");

    const result = await read(page, "DE", fetchRef);

    expect(result).toEqual({ ...readPageAlone(page, "DE"), notes: [...readPageAlone(page, "DE").notes, `Other offers could not be read: ${reason}`] });
  });

  it("gives up on a panel that has not answered after 15 seconds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const fetchRef = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<{ ok: boolean; status: number; text: () => Promise<string> }>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
        })
    );
    let settled = false;

    const pending = read(legoPage("DE"), "DE", fetchRef).finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(14_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;

    expect(fetchRef.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(result.breakdown).toBeUndefined();
    expect(result.notes.at(-1)).toBe("Other offers could not be read: timed out after 15 seconds");
  });
});
