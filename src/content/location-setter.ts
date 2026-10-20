import type { LocationRequest, LocationResult, Marketplace } from "../shared/types";

interface FetchedText {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<FetchedText>;

interface ModalAction {
  url: URL;
  token: string;
}

const ADDRESS_CHANGE_PATH = "/portal-migration/hz/glow/address-change?actionSource=glow";
const CSRF_TOKEN = /CSRF_TOKEN\s*:\s*"([^"]+)"/;
const XHR_HEADERS = { "X-Requested-With": "XMLHttpRequest", Accept: "text/html,*/*" };

const ISO_CODE = /^[A-Z]{2}$/;
const NAV_COUNTRY = /\$Nav\.declare\(\s*['"]config\.customerCountryCode['"]\s*,\s*['"]([A-Za-z]{2})['"]\s*\)/;

function asIso(value: unknown): string | undefined {
  const code = typeof value === "string" ? value.trim().toUpperCase() : "";
  return ISO_CODE.test(code) ? code : undefined;
}

function readVasCountry(documentRef: Document): string | undefined {
  for (const script of Array.from(documentRef.querySelectorAll('script[type="a-state"]'))) {
    try {
      const state = JSON.parse(script.getAttribute("data-a-state") ?? "{}") as { key?: unknown };
      if (state.key === "vas-base-vm") {
        return asIso((JSON.parse(script.textContent ?? "{}") as { countryCode?: unknown }).countryCode);
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

function readNavCountry(documentRef: Document): string | undefined {
  for (const script of Array.from(documentRef.querySelectorAll("script:not([src])"))) {
    const text = script.textContent ?? "";
    const code = text.includes("customerCountryCode") ? asIso(NAV_COUNTRY.exec(text)?.[1]) : undefined;
    if (code) {
      return code;
    }
  }
  return undefined;
}

export function readDestinationIso(documentRef: Document): string | undefined {
  return (
    readVasCountry(documentRef) ??
    asIso(documentRef.querySelector<HTMLInputElement>('input#countryCode[type="hidden"]')?.value) ??
    readNavCountry(documentRef)
  );
}

function readModalAction(documentRef: Document, origin: string): ModalAction | undefined {
  const raw = documentRef.querySelector("#nav-global-location-data-modal-action")?.getAttribute("data-a-modal");
  if (!raw) {
    return undefined;
  }
  try {
    const config = JSON.parse(raw) as { url?: unknown; ajaxHeaders?: Record<string, unknown> };
    const token =
      config.ajaxHeaders?.["anti-csrftoken-a2z"] ?? documentRef.querySelector<HTMLInputElement>("#glowValidationToken")?.value;
    return typeof config.url === "string" && typeof token === "string" && token
      ? { url: new URL(config.url, origin), token }
      : undefined;
  } catch {
    return undefined;
  }
}

function homeIso(marketplace: Marketplace): string {
  return marketplace === "UK" ? "GB" : marketplace;
}

function failed(reason: string): LocationResult {
  return { status: "FAILED", reason };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function offersCountry(formDocument: Document, countryCode: string): boolean | undefined {
  const countries = formDocument.querySelector("#GLUXCountryList");
  if (!countries) {
    return undefined;
  }
  return Array.from(countries.querySelectorAll("option"), (option) => option.getAttribute("value")).includes(countryCode);
}

export async function setDeliveryLocation(
  documentRef: Document,
  request: LocationRequest,
  origin: string,
  fetchRef: FetchLike
): Promise<LocationResult> {
  const target = request.countryCode;
  const current = readDestinationIso(documentRef);
  if (current === target) {
    return { status: "ALREADY_SET", countryCode: current };
  }

  const action = readModalAction(documentRef, origin);
  if (!action) {
    return current ? { status: "NO_WIDGET", countryCode: current } : { status: "NO_WIDGET" };
  }
  if (target === homeIso(request.marketplace)) {
    return failed("a postcode is needed for an address in the store's own country");
  }

  try {
    const form = await fetchRef(action.url.href, {
      credentials: "same-origin",
      headers: { ...XHR_HEADERS, "anti-csrftoken-a2z": action.token }
    });
    if (!form.ok) {
      return failed(`Amazon answered HTTP ${form.status}`);
    }
    const html = await form.text();
    const csrf = CSRF_TOKEN.exec(html)?.[1];
    if (!csrf) {
      return failed("Amazon's location form carried no token");
    }
    const formDocument = documentRef.implementation.createHTMLDocument("");
    formDocument.body.innerHTML = html;
    if (offersCountry(formDocument, target) === false) {
      return { status: "NOT_OFFERED", countryCode: target };
    }

    const response = await fetchRef(new URL(ADDRESS_CHANGE_PATH, origin).href, {
      method: "POST",
      credentials: "same-origin",
      headers: { ...XHR_HEADERS, "Content-Type": "application/json", "anti-csrftoken-a2z": csrf },
      body: JSON.stringify({
        locationType: "COUNTRY",
        district: target,
        countryCode: target,
        storeContext: action.url.searchParams.get("storeContext") ?? undefined,
        deviceType: "web",
        pageType: action.url.searchParams.get("pageType") ?? undefined,
        actionSource: "glow"
      })
    });
    if (!response.ok) {
      return failed(`Amazon answered HTTP ${response.status}`);
    }
    const answer = parseJson(await response.text()) as { successful?: unknown; address?: { countryCode?: unknown } } | undefined;
    return answer?.successful === 1 && asIso(answer.address?.countryCode) === target
      ? { status: "SET", countryCode: target }
      : failed("Amazon did not accept the change");
  } catch (error) {
    return failed(error instanceof Error ? error.message : "Unknown location error");
  }
}

declare global {
  interface Window {
    __ACROSS_AMAZON_LOCATION_REQUEST__?: LocationRequest;
    __ACROSS_AMAZON_LOCATION_RESULT__?: Promise<LocationResult>;
  }
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  const request = window.__ACROSS_AMAZON_LOCATION_REQUEST__;
  if (request) {
    delete window.__ACROSS_AMAZON_LOCATION_REQUEST__;
    window.__ACROSS_AMAZON_LOCATION_RESULT__ = setDeliveryLocation(document, request, location.origin, (url, init) =>
      fetch(url, init)
    );
  }
}
