import { collapseText, hasFreeMarker, normalize, parseCurrencyMarkedMoney, parseMoney, readDeliveryPrice, readPriceText } from "./price-reading";
import type { ParsedMoney } from "./price-reading";

const OFFERS_PATH = "/gp/product/ajax/aodAjaxMain/ref=aod_f_new";
const OFFERS_QUERY = ["asin", "m", "qid", "smid", "sourcecustomerorglistid", "sourcecustomerorglistitemid", "sr"];
const NEW_OFFERS_FILTER = encodeURIComponent(JSON.stringify({ all: true, new: true }));
const ASIN_PATTERN = /^[A-Z0-9]{10}$/i;

const PRICE_TO_PAY = "#aod-offer-price .apex-pricetopay-value";
const ANY_PRICE = "#aod-offer-price .a-price:not(.a-text-price)";
const OFFER_PRICE_LABEL = "#aod-offer-price .apex-pricetopay-accessibility-label";
const DELIVERY_MESSAGES =
  "[id^='mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE'], #mir-layout-DELIVERY_BLOCK-slot-NO_PROMISE_UPSELL_MESSAGE";
const SELLER = "#aod-offer-soldBy .a-col-right > a, #aod-offer-soldBy .a-col-right > span";
const DISPATCHER = "#aod-offer-shipsFrom .a-col-right > span";

const NEW_CONDITIONS = new Set(["new", "neu", "nuevo", "neuf", "nuovo", "新品"]);
const CONDITION_CODE = /:amzn1\.bot\.([A-Z_]+)$/;
const AMAZON_DISPATCHER = /^amazon(?:$|[\s.])/i;

export interface OtherOffer {
  index: number;
  condition: string;
  isNew: boolean;
  item?: ParsedMoney;
  shipping?: ParsedMoney;
  seller?: string;
  dispatcher?: string;
  fulfilledByAmazon: boolean;
}

export interface QuotableOffer extends OtherOffer {
  item: ParsedMoney;
  shipping: ParsedMoney;
}

export interface OtherOffersPanel {
  offers: OtherOffer[];
  offerCount: number;
}

export function buildOtherOffersUrl(documentRef: Document, origin: string, fallbackAsin?: string, page = 1): string | undefined {
  const params = documentRef.querySelector("#all-offers-display-params");
  const asin = params?.getAttribute("data-asin")?.trim() || fallbackAsin;
  if (!asin || !ASIN_PATTERN.test(asin)) {
    return undefined;
  }

  const url = new URL(OFFERS_PATH, origin);
  for (const name of OFFERS_QUERY) {
    url.searchParams.set(name, name === "asin" ? asin : (params?.getAttribute(`data-${name}`)?.trim() ?? ""));
  }
  url.searchParams.set("pc", "dp");
  url.searchParams.set("pageno", String(page));
  url.searchParams.set("filters", NEW_OFFERS_FILTER);
  return url.href;
}

function readItemPrice(offer: Element, marketCurrency: string): ParsedMoney | undefined {
  const price = offer.querySelector(PRICE_TO_PAY) ?? offer.querySelector(ANY_PRICE);
  const text = price ? readPriceText(price) : undefined;
  const label = collapseText(offer.querySelector(OFFER_PRICE_LABEL));
  return (text ? parseMoney(text, marketCurrency) : undefined) ?? (label ? parseCurrencyMarkedMoney(label, marketCurrency) : undefined);
}

function readConditionCode(offer: Element): string | undefined {
  const contentId = offer.querySelector("[data-csa-c-content-id*=':amzn1.bot.']")?.getAttribute("data-csa-c-content-id") ?? "";
  return CONDITION_CODE.exec(contentId)?.[1];
}

function readShipping(offer: Element, item: ParsedMoney | undefined, marketCurrency: string): ParsedMoney | undefined {
  const free = { amount: 0, currency: item?.currency ?? marketCurrency };
  const attributed = readDeliveryPrice(offer, marketCurrency);
  if (attributed) {
    return attributed.amount ?? free;
  }

  for (const message of Array.from(offer.querySelectorAll(DELIVERY_MESSAGES))) {
    const text = message.textContent ?? "";
    const amount = parseCurrencyMarkedMoney(text, marketCurrency);
    if (amount) {
      return amount;
    }
    if (hasFreeMarker(text)) {
      return free;
    }
  }

  return undefined;
}

function readOffer(offer: Element, index: number, marketCurrency: string): OtherOffer {
  const condition = collapseText(offer.querySelector("#aod-offer-heading")) ?? "";
  const item = readItemPrice(offer, marketCurrency);
  const dispatcher = collapseText(offer.querySelector(DISPATCHER));
  return {
    index,
    condition,
    isNew: readConditionCode(offer) === "NEW" || NEW_CONDITIONS.has(normalize(condition)),
    item,
    shipping: readShipping(offer, item, marketCurrency),
    seller: collapseText(offer.querySelector(SELLER)),
    dispatcher,
    fulfilledByAmazon: dispatcher !== undefined && AMAZON_DISPATCHER.test(dispatcher)
  };
}

function readOfferCount(list: Element, parsed: number): number {
  const total = Number.parseInt(list.querySelector<HTMLInputElement>("#aod-total-offer-count")?.value ?? "", 10);
  return Number.isNaN(total) ? parsed : Math.max(total, parsed);
}

export function parseOtherOffers(panel: ParentNode, marketCurrency: string): OtherOffersPanel | undefined {
  const list = panel.querySelector("#aod-offer-list");
  if (!list) {
    return undefined;
  }

  const offers = Array.from(list.querySelectorAll("#aod-offer"), (offer, index) => readOffer(offer, index, marketCurrency));
  return { offers, offerCount: readOfferCount(list, offers.length) };
}

function isQuotable(offer: OtherOffer): offer is QuotableOffer {
  return offer.isNew && offer.item !== undefined && offer.shipping !== undefined;
}

export function quotableOffers(offers: OtherOffer[]): QuotableOffer[] {
  return offers.filter(isQuotable);
}

function offerKey({ seller, item, shipping }: OtherOffer): string {
  return JSON.stringify([seller, item?.amount, item?.currency, shipping?.amount, shipping?.currency]);
}

export function unseenOffers(read: OtherOffer[], page: OtherOffer[]): OtherOffer[] {
  const seen = new Set(read.map(offerKey));
  return page.filter((offer) => !seen.has(offerKey(offer)));
}
