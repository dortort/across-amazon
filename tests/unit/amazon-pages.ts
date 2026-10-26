import { countryName } from "../../src/shared/markets";

export const LOCATION_FORM_PATH = "/portal-migration/hz/glow/get-rendered-address-selections";
export const ADDRESS_CHANGE_PATH = "/portal-migration/hz/glow/address-change";
export const OFFERS_PATH = "/gp/product/ajax/aodAjaxMain/ref=aod_f_new";
export const PAGE_TOKEN = "TEST-PAGE-TOKEN";
export const POST_TOKEN = "TEST-POST-TOKEN";

export const OFFER_SELECTORS = [
  "#corePriceDisplay_desktop_feature_div",
  "#deliveryBlockMessage",
  "#exports_desktop_feature_div",
  "#subtotals-marketplace-table"
];

export function removeElement(document: Document, selector: string): void {
  document.querySelector(selector)?.remove();
}

export function applyLocation(document: Document, countryCode: string): void {
  const line = document.querySelector("#glow-ingress-line2");
  if (line) {
    line.textContent = `Deliver to ${countryName(countryCode)}`;
  }
  const modal = {
    ajaxHeaders: { "anti-csrftoken-a2z": PAGE_TOKEN },
    name: "glow-modal",
    url: `${LOCATION_FORM_PATH}?deviceType=desktop&pageType=Detail&storeContext=industrial&actionSource=desktop-modal`
  };
  document.body.insertAdjacentHTML(
    "beforeend",
    `<span id="nav-global-location-data-modal-action" data-action="a-modal" data-a-modal='${JSON.stringify(modal)}'></span>` +
      `<input type="hidden" id="countryCode" value="${countryCode}">`
  );
}

export function removeLocationFields(document: Document): void {
  for (const selector of ["#nav-global-location-data-modal-action", "#countryCode"]) {
    document.querySelector(selector)?.remove();
  }
}

export function offerOnlyOtherSellers(document: Document): void {
  for (const selector of OFFER_SELECTORS) {
    removeElement(document, selector);
  }
  document.body.insertAdjacentHTML(
    "beforeend",
    '<div id="olpLinkWidget_feature_div"><input type="hidden" id="all-offers-display-params" data-m="" data-qid="" data-smid="" data-sourcecustomerorglistid="" data-sourcecustomerorglistitemid="" data-sr=""></div>' +
      '<span id="buybox-see-all-buying-choices"><span class="a-button-inner"><a class="a-button-text">See All Buying Options</a></span></span>'
  );
  const asin = /\/dp\/([A-Z0-9]{10})/i.exec(document.URL)?.[1];
  if (asin) {
    document.querySelector("#all-offers-display-params")?.setAttribute("data-asin", asin);
  }
}

export function offersUrl(origin: string, asin: string): string {
  return `${origin}${OFFERS_PATH}?asin=${asin}&m=&qid=&smid=&sourcecustomerorglistid=&sourcecustomerorglistitemid=&sr=&pc=dp&pageno=1&filters=%257B%2522all%2522%253Atrue%252C%2522new%2522%253Atrue%257D`;
}
