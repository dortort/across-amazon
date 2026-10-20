import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { buildOtherOffersUrl, parseOtherOffers, quotableOffers } from "../../src/content/other-offers";
import type { OtherOffer, OtherOffersPanel } from "../../src/content/other-offers";

const OFFERS_FIXTURES = join(process.cwd(), "tests", "fixtures", "offers-live");
const DE_PANEL = "DE-four-new-offers.html";
const UK_PANEL = "UK-item-in-pounds-delivery-in-francs.html";
const MX_PANEL = "MX-one-offer-not-shippable.html";

function panelDocument(file: string, prepare?: (document: Document) => void): Document {
  const dom = new JSDOM(readFileSync(join(OFFERS_FIXTURES, file), "utf8"));
  prepare?.(dom.window.document);
  return dom.window.document;
}

function parsePanel(file: string, marketCurrency: string, prepare?: (document: Document) => void): OtherOffersPanel {
  const panel = parseOtherOffers(panelDocument(file, prepare), marketCurrency);
  if (!panel) {
    throw new Error(`No offer list in ${file}`);
  }
  return panel;
}

function firstOffer(document: Document): Element {
  const offer = document.querySelector("#aod-offer-list #aod-offer");
  if (!offer) {
    throw new Error("No offer in the panel");
  }
  return offer;
}

function withCondition(heading: string, code: string | null): (document: Document) => void {
  return (document) => {
    const offer = firstOffer(document);
    const title = offer.querySelector("#aod-offer-heading span");
    if (title) {
      title.textContent = ` ${heading} `;
    }
    const marker = offer.querySelector("[data-csa-c-content-id*=':amzn1.bot.']");
    if (code === null) {
      marker?.removeAttribute("data-csa-c-content-id");
    } else {
      marker?.setAttribute("data-csa-c-content-id", `amzn1.asin.B0CGVJVQV8:amzn1.bot.${code}`);
    }
  };
}

function offer(overrides: Partial<OtherOffer>): OtherOffer {
  return {
    index: 0,
    condition: "New",
    isNew: true,
    item: { amount: 100, currency: "EUR" },
    shipping: { amount: 10, currency: "EUR" },
    seller: "Seller",
    dispatcher: "Amazon",
    fulfilledByAmazon: true,
    ...overrides
  };
}

describe("buildOtherOffersUrl", () => {
  function pageWith(body: string): Document {
    return new JSDOM(`<!doctype html><html><body>${body}</body></html>`, { url: "https://www.amazon.de/dp/B0CGVJVQV8" }).window
      .document;
  }

  it("builds the request for the first page of new offers from the page's all-offers parameters on its own origin", () => {
    const page = pageWith(
      '<div id="olpLinkWidget_feature_div"><input type="hidden" id="all-offers-display-params" data-asin="B0CGVJVQV8" data-m="" data-qid="" data-smid="" data-sourcecustomerorglistid="" data-sourcecustomerorglistitemid="" data-sr=""></div>'
    );

    expect(buildOtherOffersUrl(page, "https://www.amazon.de")).toBe(
      "https://www.amazon.de/gp/product/ajax/aodAjaxMain/ref=aod_f_new?asin=B0CGVJVQV8&m=&qid=&smid=&sourcecustomerorglistid=&sourcecustomerorglistitemid=&sr=&pc=dp&pageno=1&filters=%257B%2522all%2522%253Atrue%252C%2522new%2522%253Atrue%257D"
    );
  });

  it("carries the seller and search values the parameters set", () => {
    const page = pageWith(
      '<input type="hidden" id="all-offers-display-params" data-asin="B0CGVJVQV8" data-m="A0000000000001" data-qid="1760954400" data-smid="" data-sr="8-1">'
    );

    expect(buildOtherOffersUrl(page, "https://www.amazon.co.uk")).toBe(
      "https://www.amazon.co.uk/gp/product/ajax/aodAjaxMain/ref=aod_f_new?asin=B0CGVJVQV8&m=A0000000000001&qid=1760954400&smid=&sourcecustomerorglistid=&sourcecustomerorglistitemid=&sr=8-1&pc=dp&pageno=1&filters=%257B%2522all%2522%253Atrue%252C%2522new%2522%253Atrue%257D"
    );
  });

  it("falls back to the page ASIN with every other value empty when the parameters carry none", () => {
    const page = pageWith('<input id="all-offers-display-params">');

    expect(buildOtherOffersUrl(page, "https://www.amazon.com.mx", "B0CGVJVQV8")).toBe(
      "https://www.amazon.com.mx/gp/product/ajax/aodAjaxMain/ref=aod_f_new?asin=B0CGVJVQV8&m=&qid=&smid=&sourcecustomerorglistid=&sourcecustomerorglistitemid=&sr=&pc=dp&pageno=1&filters=%257B%2522all%2522%253Atrue%252C%2522new%2522%253Atrue%257D"
    );
    expect(buildOtherOffersUrl(pageWith(""), "https://www.amazon.com.mx", "B0CGVJVQV8")).toContain("?asin=B0CGVJVQV8&m=&");
  });

  it("asks for a later page of new offers with the same parameters", () => {
    const page = pageWith('<input type="hidden" id="all-offers-display-params" data-asin="B0CGVJVQV8" data-m="" data-sr="">');
    const url = new URL(buildOtherOffersUrl(page, "https://www.amazon.de", undefined, 3) ?? "");

    expect(url.pathname).toBe("/gp/product/ajax/aodAjaxMain/ref=aod_f_new");
    expect(url.searchParams.get("pageno")).toBe("3");
    expect(JSON.parse(decodeURIComponent(url.searchParams.get("filters") ?? ""))).toEqual({ all: true, new: true });
    expect(url.search).not.toContain("isonlyrenderofferlist");
  });

  it("builds nothing without an ASIN", () => {
    expect(buildOtherOffersUrl(pageWith('<input id="all-offers-display-params" data-asin="">'), "https://www.amazon.de")).toBeUndefined();
    expect(buildOtherOffersUrl(pageWith(""), "https://www.amazon.de", "not-an-asin")).toBeUndefined();
  });
});

describe("parseOtherOffers on live panels for a delivery address in Switzerland", () => {
  it("reads the four new offers amazon.de lists in its own order, skipping the empty featured offer", () => {
    const panel = parsePanel(DE_PANEL, "EUR");

    expect(panel.offerCount).toBe(4);
    expect(panel.offers).toEqual([
      {
        index: 0,
        condition: "New",
        isNew: true,
        item: { amount: 651.25, currency: "EUR" },
        shipping: { amount: 55.26, currency: "EUR" },
        seller: "Star Brick City",
        dispatcher: "Amazon",
        fulfilledByAmazon: true
      },
      {
        index: 1,
        condition: "New",
        isNew: true,
        item: { amount: 714.28, currency: "EUR" },
        shipping: { amount: 55.26, currency: "EUR" },
        seller: "BricksBoutique",
        dispatcher: "Amazon",
        fulfilledByAmazon: true
      },
      {
        index: 2,
        condition: "New",
        isNew: true,
        item: { amount: 720.48, currency: "EUR" },
        shipping: { amount: 55.26, currency: "EUR" },
        seller: "Nucleus Investments",
        dispatcher: "Amazon",
        fulfilledByAmazon: true
      },
      {
        index: 3,
        condition: "New",
        isNew: true,
        item: { amount: 973.41, currency: "EUR" },
        shipping: { amount: 19, currency: "EUR" },
        seller: "RamanDz",
        dispatcher: "RamanDz",
        fulfilledByAmazon: false
      }
    ]);
  });

  it("reads the amazon.co.uk offers with the item in pounds and the delivery in Swiss francs", () => {
    const panel = parsePanel(UK_PANEL, "GBP");

    expect(panel.offerCount).toBe(2);
    expect(panel.offers.map(({ item, shipping, seller, dispatcher }) => ({ item, shipping, seller, dispatcher }))).toEqual([
      {
        item: { amount: 574.97, currency: "GBP" },
        shipping: { amount: 252.53, currency: "CHF" },
        seller: "BuyMyBricks",
        dispatcher: "Amazon"
      },
      {
        item: { amount: 699, currency: "GBP" },
        shipping: { amount: 40.86, currency: "CHF" },
        seller: "RamanDz",
        dispatcher: "RamanDz"
      }
    ]);
  });

  it("reads the amazon.com.mx offer that cannot be shipped for now without a delivery price", () => {
    const panel = parsePanel(MX_PANEL, "MXN");

    expect(panel).toEqual({
      offerCount: 1,
      offers: [
        {
          index: 0,
          condition: "Nuevo",
          isNew: true,
          item: { amount: 18520.58, currency: "MXN" },
          shipping: undefined,
          seller: "Amazon Europa",
          dispatcher: "Amazon Europa",
          fulfilledByAmazon: true
        }
      ]
    });
    expect(quotableOffers(panel.offers)).toEqual([]);
  });

  it("reads free delivery from the message text and from the price attribute as zero in the item currency", () => {
    const panel = parsePanel(DE_PANEL, "EUR", (document) => {
      const [upsell] = Array.from(document.querySelectorAll("#mir-layout-DELIVERY_BLOCK-slot-NO_PROMISE_UPSELL_MESSAGE"));
      upsell.textContent = "FREE delivery 26 - 29 October";
      document.querySelector("[data-csa-c-delivery-price]")?.setAttribute("data-csa-c-delivery-price", "FREE");
    });

    expect(panel.offers[0].shipping).toEqual({ amount: 0, currency: "EUR" });
    expect(panel.offers[3].shipping).toEqual({ amount: 0, currency: "EUR" });
  });

  it("reads the delivery amount of a message that also offers free delivery above a threshold", () => {
    const panel = parsePanel(DE_PANEL, "EUR", (document) => {
      const upsell = firstOffer(document).querySelector("#mir-layout-DELIVERY_BLOCK-slot-NO_PROMISE_UPSELL_MESSAGE");
      if (upsell) {
        upsell.textContent = "€3.99 delivery · FREE delivery on orders over €29";
      }
    });

    expect(panel.offers[0].shipping).toEqual({ amount: 3.99, currency: "EUR" });
  });

  it("reads the item price from its accessibility label when the visible price parts are missing", () => {
    const panel = parsePanel(DE_PANEL, "EUR", (document) => {
      firstOffer(document).querySelector("#aod-offer-price .a-price")?.remove();
    });

    expect(panel.offers[0].item).toEqual({ amount: 651.25, currency: "EUR" });
  });

  it("counts the offers it read when the panel carries no total", () => {
    const panel = parsePanel(DE_PANEL, "EUR", (document) => {
      document.querySelector("#aod-total-offer-count")?.remove();
    });

    expect(panel.offerCount).toBe(4);
  });

  it.each(["Nieuw", "Nowy", "Yeni", "Novo", "全新"])(
    "reads an offer whose condition code is NEW as new whatever its heading says, here %s",
    (heading) => {
      expect(parsePanel(DE_PANEL, "EUR", withCondition(heading, "NEW")).offers[0]).toMatchObject({ condition: heading, isNew: true });
    }
  );

  it.each(["New", "Neu", "Nuevo", "Neuf", "Nuovo", "新品"])("reads the heading %s as new when the offer carries no condition code", (heading) => {
    expect(parsePanel(DE_PANEL, "EUR", withCondition(heading, null)).offers[0]).toMatchObject({ condition: heading, isNew: true });
  });

  it.each(["Used - Like New", "Gebraucht - Wie neu", "Usado - Como nuevo", "D'occasion - Comme neuf", "Usato - Come nuovo", "中古品 - ほぼ新品"])(
    "reads the heading %s as used, with a used condition code or none",
    (heading) => {
      expect(parsePanel(DE_PANEL, "EUR", withCondition(heading, "USED_LIKE_NEW")).offers[0]).toMatchObject({ condition: heading, isNew: false });
      expect(parsePanel(DE_PANEL, "EUR", withCondition(heading, null)).offers[0]).toMatchObject({ condition: heading, isNew: false });
    }
  );

  it("quotes the price to pay, not a list price shown before it", () => {
    const panel = parsePanel(DE_PANEL, "EUR", (document) => {
      firstOffer(document)
        .querySelector("#aod-offer-price")
        ?.insertAdjacentHTML("afterbegin", '<span class="a-price a-text-price" data-a-strike="true"><span class="a-offscreen">€799.00</span></span>');
    });

    expect(panel.offers[0].item).toEqual({ amount: 651.25, currency: "EUR" });
  });

  it("reads a deal's accessibility label without its savings when the visible price parts are missing", () => {
    const panel = parsePanel(DE_PANEL, "EUR", (document) => {
      const offer = firstOffer(document);
      offer.querySelector("#aod-offer-price .a-price")?.remove();
      const label = offer.querySelector("#aod-offer-price .apex-pricetopay-accessibility-label");
      if (label) {
        label.textContent = " €651.25 with 15 percent savings ";
      }
    });

    expect(panel.offers[0].item).toEqual({ amount: 651.25, currency: "EUR" });
  });

  it("never reads a priced offer in the pinned featured block above the list", () => {
    const panel = parsePanel(DE_PANEL, "EUR", (document) => {
      document
        .querySelector("#aod-pinned-offer")
        ?.insertAdjacentHTML(
          "beforeend",
          '<div id="aod-offer"><div id="aod-offer-heading"><span>New</span></div>' +
            '<div id="aod-offer-price"><span class="a-price apex-pricetopay-value"><span class="a-offscreen">€599.00</span></span></div>' +
            '<div id="mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_LARGE"><span data-csa-c-delivery-price="FREE">FREE delivery</span></div>' +
            '<div id="aod-offer-soldBy"><div class="a-col-right"><a>Featured Seller</a></div></div></div>'
        );
    });

    expect(panel.offers).toHaveLength(4);
    expect(panel.offers.map((offer) => offer.seller)).not.toContain("Featured Seller");
    expect(quotableOffers(panel.offers)[0]).toMatchObject({ seller: "Star Brick City", item: { amount: 651.25, currency: "EUR" } });
  });

  it("finds no offer list in an answer that is not the panel", () => {
    const signIn = new JSDOM("<!doctype html><html><body><form name='signIn'><input id='ap_email'></form></body></html>");

    expect(parseOtherOffers(signIn.window.document, "EUR")).toBeUndefined();
  });
});

describe("quotableOffers", () => {
  it("lists every new offer of the amazon.de panel with both prices, in Amazon's order", () => {
    expect(quotableOffers(parsePanel(DE_PANEL, "EUR").offers).map(({ index, item, shipping }) => ({ index, item, shipping }))).toEqual([
      { index: 0, item: { amount: 651.25, currency: "EUR" }, shipping: { amount: 55.26, currency: "EUR" } },
      { index: 1, item: { amount: 714.28, currency: "EUR" }, shipping: { amount: 55.26, currency: "EUR" } },
      { index: 2, item: { amount: 720.48, currency: "EUR" }, shipping: { amount: 55.26, currency: "EUR" } },
      { index: 3, item: { amount: 973.41, currency: "EUR" }, shipping: { amount: 19, currency: "EUR" } }
    ]);
  });

  it("keeps both amazon.co.uk offers in Amazon's order, leaving the choice between pounds and francs to the caller", () => {
    expect(quotableOffers(parsePanel(UK_PANEL, "GBP").offers).map(({ seller }) => seller)).toEqual(["BuyMyBricks", "RamanDz"]);
  });

  it("skips used offers and offers without an item price or a delivery price", () => {
    const usable = offer({ index: 3, seller: "Fourth" });
    const offers = [
      offer({ index: 0, condition: "Used - Like New", isNew: false }),
      offer({ index: 1, item: undefined }),
      offer({ index: 2, shipping: undefined }),
      usable
    ];

    expect(quotableOffers(offers)).toEqual([usable]);
  });

  it("lists nothing from an empty panel", () => {
    expect(quotableOffers([])).toEqual([]);
  });
});
