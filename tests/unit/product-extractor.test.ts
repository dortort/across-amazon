import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { extractProductData } from "../../src/content/product-extractor";
import type { Marketplace, ProductExtractionResult } from "../../src/shared/types";

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

  it("reads an amount without any currency marker in the marketplace currency", () => {
    const result = extractPriced("JP", "4200", '<div id="deliveryBlockMessage">配達料 <span class="a-color-price">500</span></div>');

    expect(result.breakdown?.item).toEqual({ amount: 4200, currency: "JPY" });
    expect(result.breakdown?.shipping).toEqual({ amount: 500, currency: "JPY" });
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

    it("splits a combined No Import Fees Deposit and shipping line into zero import fees and the shipping price", () => {
      const result = extract('<div id="deliveryBlockMessage">No Import Fees Deposit &amp; $12.99 Shipping to Canada</div>');

      expect(result.breakdown?.shipping).toEqual({ amount: 12.99, currency: "USD" });
      expect(result.breakdown?.importFees).toEqual({ amount: 0, currency: "USD" });
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
