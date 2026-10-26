import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setDeliveryLocation } from "../../src/content/location-setter";
import { extractProductDataWithOffers } from "../../src/content/product-extractor";
import { extractSearchCandidates } from "../../src/content/search-extractor";
import { extractSourceContext } from "../../src/content/source-extractor";
import { MARKETPLACE_CODES, buildProductUrl, getMarketplaceByDomain } from "../../src/shared/markets";
import {
  CANCEL_COMPARISON,
  LOAD_SOURCE,
  OFFSCREEN_CANCEL_RUN,
  OFFSCREEN_PAGE_JOB,
  OFFSCREEN_TARGET,
  RUN_COMPARISON,
  RUN_COMPARISON_PROGRESS,
  RUN_COMPARISON_RESULT
} from "../../src/shared/messages";
import { buildComparisonCacheKey } from "../../src/shared/storage";
import type {
  CachedComparisonRecord,
  ComparisonPhase,
  ComparisonResult,
  FxTable,
  LoadSourcePayload,
  LocationRequest,
  Marketplace,
  PageJob,
  ProductExtractionRequest,
  RunComparisonProgressPayload,
  RunComparisonResultPayload,
  SearchExtractionRequest,
  SourceContext
} from "../../src/shared/types";
import {
  ADDRESS_CHANGE_PATH,
  LOCATION_FORM_PATH,
  OFFERS_PATH,
  OFFER_SELECTORS,
  PAGE_TOKEN,
  POST_TOKEN,
  applyLocation,
  offerOnlyOtherSellers,
  offersUrl,
  removeElement,
  removeLocationFields
} from "./amazon-pages";

const ACTIVE_TAB_ID = 1;
const SECOND_TAB_ID = 2;
const SOURCE_URL = "https://www.amazon.com/dp/B000000001";
const FIXTURE_ROOT = join(process.cwd(), "tests", "fixtures");
const POPUP_CLOSED_ERROR = "Could not establish connection. Receiving end does not exist.";
const SINGLE_DOCUMENT_ERROR = "Only a single offscreen document may be created.";
const NO_DOCUMENT_ERROR = "No current offscreen document.";
const EXTENSION_ID = "across-amazon-test";
const WORKER_SENDER: chrome.runtime.MessageSender = {
  id: EXTENSION_ID,
  url: `chrome-extension://${EXTENSION_ID}/background/service-worker.js`
};
const TAB_PATH = { offscreen: false } as const;
const PAGE_PATH = /^\/s$|\/dp\/[A-Z0-9]{10}/i;
const CANCELLED_ERROR = "Comparison cancelled by user";
const TAB_CLOSED_ERROR = "The tab was closed.";
const FRAME_REMOVED_ERROR = "Frame with ID 0 was removed.";
const NO_HOST_ACCESS_ERROR =
  "Cannot access contents of the page. Extension manifest must request permission to access the respective host.";
const ERROR_PAGE_ERROR = "Frame with ID 0 is showing error page";
const NOT_ACCEPTED_NOTE = "Delivery location not set: Amazon did not accept the change";
const ROBOT_CHECK_HTML = readFileSync(join(FIXTURE_ROOT, "robot-check.html"), "utf8");
const SERVICE_UNAVAILABLE_HTML = readFileSync(join(FIXTURE_ROOT, "service-unavailable.html"), "utf8");
const CHECKPOINT_PATH = "/checkpoint/continue?token=TEST-CHECKPOINT-TOKEN";
const CHECKPOINT_HTML =
  "<!doctype html><html><head><title>Amazon.com</title></head><body><p>Checking your browser</p></body></html>";
const UNPARSED_DOCUMENT_HTML = "<!doctype html><html><head></head><body></body></html>";
const SHAPELESS_HTML = "<!doctype html><html><head><title>Amazon</title></head><body><div><p>Something went wrong</p></div></body></html>";
const CHANNEL_CLOSED_ERROR =
  "A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received";

const ECB_XML = `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
  <Cube>
    <Cube time='2026-10-16'>
      <Cube currency='USD' rate='1.08'/>
      <Cube currency='JPY' rate='155.52'/>
      <Cube currency='GBP' rate='0.852'/>
      <Cube currency='CAD' rate='1.475'/>
      <Cube currency='AUD' rate='1.655'/>
      <Cube currency='MXN' rate='19.46'/>
      <Cube currency='CHF' rate='0.94'/>
    </Cube>
  </Cube>
</gesmes:Envelope>`;

const EXPECTED_FX_TABLE: FxTable = {
  base: "EUR",
  date: "2026-10-16",
  rates: { EUR: 1, USD: 1.08, JPY: 155.52, GBP: 0.852, CAD: 1.475, AUD: 1.655, MXN: 19.46, CHF: 0.94 },
  source: "ECB"
};

const EXPECTED_SOURCE: SourceContext = {
  marketplace: "US",
  asin: "B000000001",
  title: "Acme Ultra Widget Model X100 2 Pack Blue",
  brand: "Acme",
  variationTokens: ["2 pack", "16 oz", "blue"],
  destinationCountryCode: "US",
  deliverTo: "Deliver to United States",
  sourceUrl: SOURCE_URL,
  imageUrl: "https://m.media-amazon.com/images/I/41acme-widget._AC_SX425_.jpg"
};

const RAW_BASELINE: ComparisonResult = {
  marketplace: "US",
  status: "OK",
  confidence: 1,
  productUrl: SOURCE_URL,
  breakdown: {
    item: { amount: 49.99, currency: "USD" },
    shipping: { amount: 0, currency: "USD" },
    importFees: { amount: 0, currency: "USD" }
  },
  notes: ["Import fees not displayed for destination"]
};

const EXPECTED_BASELINE: ComparisonResult = {
  ...RAW_BASELINE,
  normalizedTotal: { amount: 49.99, currency: "USD" }
};

const EXPECTED_DE_RESULT: ComparisonResult = {
  marketplace: "DE",
  status: "OK",
  confidence: 0.92,
  productUrl: "https://www.amazon.de/dp/B000000005",
  breakdown: {
    item: { amount: 37.2, currency: "EUR" },
    shipping: { amount: 4.5, currency: "EUR" },
    importFees: { amount: 3.2, currency: "EUR" },
    totalDisplayed: { amount: 37.2, currency: "EUR" }
  },
  notes: ["Matched by search", "Match confidence: HIGH"],
  normalizedTotal: { amount: 48.49, currency: "USD" }
};

type FixtureGroup = "source" | "search" | "product" | "missing";
type WindowScope = Record<string, unknown>;
type Prepare = (group: FixtureGroup, market: Marketplace, document: Document) => void;
type SendResponse = (response?: unknown) => void;
type MessageListener = (message: unknown, sender: unknown, sendResponse: SendResponse) => boolean;
type OffscreenListener = (message: unknown, sender: chrome.runtime.MessageSender, sendResponse: SendResponse) => boolean;
type TabUpdatedListener = (tabId: number, changeInfo: { status?: string }) => void;
type TabRemovedListener = (tabId: number) => void;
type DocumentState = "blank" | "loading" | "removed" | "replaced" | "error" | "no-access" | "idle";

interface FakeTab {
  id: number;
  url: string;
  label: string;
  market?: Marketplace;
  dom: JSDOM;
  responseStatus: number;
  scope: WindowScope;
  status: "loading" | "complete";
  document: DocumentState;
  waited: boolean;
  served: boolean;
  idle: Promise<void>;
  reachIdle: () => void;
  closed: Promise<never>;
  close: () => void;
}

interface Injection {
  target: { tabId: number };
  files?: string[];
  func?: (...args: never[]) => unknown;
  args?: unknown[];
  injectImmediately?: boolean;
}

interface NavigationEntries {
  getEntriesByType: (type: string) => Array<{ responseStatus: number }>;
}

interface InjectionFrame {
  frameId: number;
  documentId: string;
  result?: unknown;
}

interface ExtensionMessage {
  type: string;
  payload: unknown;
  target?: string;
}

interface FetchAnswer {
  ok: boolean;
  status: number;
  url?: string;
  headers?: Headers;
  arrayBuffer?: () => Promise<ArrayBuffer>;
  text?: () => Promise<string>;
}

interface ServedPage {
  label: string;
  dom: JSDOM;
  status?: number;
  finalUrl: string;
}

interface PageFetch {
  label: string;
  url: string;
  status: number;
}

interface HarnessOptions {
  offscreen?: boolean;
  offscreenCreateFails?: string;
  offscreenSilent?: boolean;
  offscreenOpenAtStart?: boolean;
  closeOffscreenOn?: string[];
  holdCreate?: Promise<void>;
  secondActiveUrl?: string;
  captchaOn?: string[];
  failFetchOn?: string[];
  holdFetchOn?: string[];
  holdFetch?: Promise<void>;
  shapelessOn?: string[];
  redirectOn?: Record<string, string>;
  rejectLocationFetchOn?: Marketplace[];
  offersStatusOn?: Partial<Record<Marketplace, number>>;
  fetchKeepsLocationOn?: string[];
  fetchShowsLocationOn?: Record<string, string>;
  enabledMarketplaces?: Marketplace[];
  comparisonCurrency?: string;
  activeUrl?: string;
  activeHtml?: string;
  prepare?: Prepare;
  fxAvailable?: boolean;
  failScriptOn?: string;
  popupClosed?: boolean;
  onTabCreated?: (tab: FakeTab, harness: Harness) => void;
  holdFx?: Promise<void>;
  sourceAsinOn?: Marketplace[];
  redirectAsinOn?: Marketplace[];
  variantAsinsOn?: Partial<Record<Marketplace, string[]>>;
  locations?: Partial<Record<Marketplace, string>>;
  rejectLocationOn?: Marketplace[];
  notOfferedOn?: Marketplace[];
  holdLocation?: Promise<void>;
  offersOn?: Partial<Record<Marketplace, string>>;
  holdOffers?: Promise<void>;
  robotCheckOn?: string[];
  serviceUnavailableOn?: string[];
  checkpointOn?: Marketplace[];
  holdScriptOn?: string[];
}

interface Harness {
  chrome: typeof chrome;
  fetch: ReturnType<typeof vi.fn>;
  storage: Record<string, unknown>;
  events: string[];
  eventMarkets: Array<Marketplace | undefined>;
  messages: ExtensionMessage[];
  offscreenMessages: ExtensionMessage[];
  pageFetches: PageFetch[];
  pageFetchUrls: () => string[];
  locationOf: (market: Marketplace) => string | undefined;
  tabsCreate: ReturnType<typeof vi.fn>;
  tabsRemove: ReturnType<typeof vi.fn>;
  executeScript: ReturnType<typeof vi.fn>;
  openTempTabs: () => string[];
  tabListenerCount: () => number;
  documentIdle: (tabId: number) => void;
  silentRemove: (tabId: number) => void;
  dispatch: (message: unknown) => Promise<unknown>;
}

function tabClosing(): { closed: Promise<never>; close: () => void } {
  let close: () => void = () => undefined;
  const closed = new Promise<never>((_resolve, reject) => {
    close = () => reject(new Error(TAB_CLOSED_ERROR));
  });
  closed.catch(() => undefined);
  return { closed, close };
}

function documentLoading(): { idle: Promise<void>; reachIdle: () => void } {
  let reachIdle: () => void = () => undefined;
  const idle = new Promise<void>((resolve) => {
    reachIdle = resolve;
  });
  return { idle, reachIdle };
}

function newTab(id: number, url: string, label: string, dom: JSDOM, responseStatus = 200): FakeTab {
  return {
    id,
    url,
    label,
    market: getMarketplaceByDomain(new URL(url).hostname),
    dom,
    responseStatus,
    scope: {},
    status: "complete",
    document: "idle",
    waited: false,
    served: false,
    ...documentLoading(),
    ...tabClosing()
  };
}

function holdLoading(tab: FakeTab): void {
  tab.status = "loading";
  tab.document = "loading";
}

function holdBlank(tab: FakeTab): void {
  tab.status = "loading";
  tab.document = "blank";
}

function locationFormFile(market: Marketplace): string {
  switch (market) {
    case "US":
      return "US-modal.html";
    case "CA":
    case "MX":
      return "CA-modal.html";
    case "JP":
      return "JP-modal.html";
    default:
      return "DE-modal.html";
  }
}

function readLocationFixture(file: string): string {
  return readFileSync(join(FIXTURE_ROOT, "location", file), "utf8");
}

function readOffersFixture(file: string): string {
  return new JSDOM(readFileSync(join(FIXTURE_ROOT, "offers-live", file), "utf8")).window.document.body.innerHTML;
}

function setPageAsin(document: Document, asin: string): void {
  const input = document.querySelector<HTMLInputElement>("#ASIN");
  if (input) {
    input.setAttribute("value", asin);
  }
  const canonical = document.querySelector<HTMLLinkElement>("link[rel='canonical']");
  if (canonical) {
    canonical.href = new URL(`/dp/${asin}`, canonical.href).href;
  }
}

function loadFixtureDom(group: FixtureGroup, market: Marketplace, url: string, location: string, prepare?: Prepare): JSDOM {
  const file = group === "missing" ? join("product", "not-found.html") : join(group, `${market}.html`);
  const html = readFileSync(join(FIXTURE_ROOT, file), "utf8");
  const dom = new JSDOM(html, { url });
  applyLocation(dom.window.document, location);
  prepare?.(group, market, dom.window.document);
  return dom;
}

const CONTENT_SCRIPTS: Record<string, (tab: FakeTab) => void> = {
  "content/source-extractor.js": (tab) => {
    const { document, location } = tab.dom.window;
    tab.scope.__ACROSS_AMAZON_SOURCE_CONTEXT__ = extractSourceContext(document, location.href, location.hostname);
  },
  "content/search-extractor.js": (tab) => {
    const request = tab.scope.__ACROSS_AMAZON_SEARCH_REQUEST__ as SearchExtractionRequest | undefined;
    if (request) {
      const { document, location } = tab.dom.window;
      tab.scope.__ACROSS_AMAZON_SEARCH_CANDIDATES__ = extractSearchCandidates(document, request, location.origin);
    }
  },
  "content/product-extractor.js": (tab) => {
    const request = tab.scope.__ACROSS_AMAZON_PRODUCT_REQUEST__ as ProductExtractionRequest | undefined;
    if (request) {
      const { document, location } = tab.dom.window;
      tab.scope.__ACROSS_AMAZON_PRODUCT_RESULT__ = extractProductDataWithOffers(document, request, location.href, (url, init) =>
        fetch(url, init)
      );
    }
  },
  "content/location-setter.js": (tab) => {
    const request = tab.scope.__ACROSS_AMAZON_LOCATION_REQUEST__ as LocationRequest | undefined;
    if (request) {
      delete tab.scope.__ACROSS_AMAZON_LOCATION_REQUEST__;
      const { document, location } = tab.dom.window;
      tab.scope.__ACROSS_AMAZON_LOCATION_RESULT__ = setDeliveryLocation(document, request, location.origin, (url, init) =>
        fetch(url, init)
      );
    }
  }
};

function abortError(): DOMException {
  return new DOMException("This operation was aborted", "AbortError");
}

function abortable<T>(signal: AbortSignal | null | undefined, work: Promise<T>): Promise<T> {
  if (!signal) {
    return work;
  }
  if (signal.aborted) {
    return Promise.reject(abortError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

function pageResponse(html: string, url: string, status: number): FetchAnswer {
  const bytes = new TextEncoder().encode(html);
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: new Headers({ "content-type": "text/html;charset=UTF-8" }),
    arrayBuffer: async () => bytes.slice().buffer,
    text: async () => html
  };
}

function isOffscreenMessage(message: ExtensionMessage): boolean {
  return message.target === OFFSCREEN_TARGET;
}

function createHarness(options: HarnessOptions, offscreenListener: OffscreenListener): Harness {
  const storage: Record<string, unknown> = {
    "settings:v1": {
      enabledMarketplaces: options.enabledMarketplaces ?? ["US", "UK", "DE"],
      comparisonCurrency: options.comparisonCurrency ?? "SOURCE"
    }
  };
  const tabs = new Map<number, FakeTab>();
  const events: string[] = [];
  const eventMarkets: Array<Marketplace | undefined> = [];
  const messages: ExtensionMessage[] = [];
  const offscreenMessages: ExtensionMessage[] = [];
  const pageFetches: PageFetch[] = [];
  const refusedOffers = new Set<Marketplace>();
  let offscreenOpen = options.offscreenOpenAtStart === true;
  const listeners: MessageListener[] = [];
  const updatedListeners = new Set<TabUpdatedListener>();
  const removedListeners = new Set<TabRemovedListener>();
  let nextTabId = 100;
  let fxHold = options.holdFx;
  const locations = new Map<Marketplace, string>(MARKETPLACE_CODES.map((market) => [market, options.locations?.[market] ?? "US"]));

  function log(event: string, market?: Marketplace): void {
    events.push(event);
    eventMarkets.push(market);
  }

  function initialLocation(market: Marketplace): string {
    return options.locations?.[market] ?? "US";
  }

  function fixtureDom(group: FixtureGroup, market: Marketplace, url: string, location?: string): JSDOM {
    return loadFixtureDom(group, market, url, location ?? locations.get(market) ?? "US", options.prepare);
  }

  function requireTab(tabId: number): FakeTab {
    const tab = tabs.get(tabId);
    if (!tab) {
      throw new Error(`No tab with id: ${tabId}`);
    }
    return tab;
  }

  function registerActiveTab(tabId: number, url: string): void {
    const market = getMarketplaceByDomain(new URL(url).hostname);
    const dom =
      options.activeHtml !== undefined || !market
        ? new JSDOM(options.activeHtml ?? "<!doctype html><html><body></body></html>", { url })
        : fixtureDom("source", market, url);
    const label = market && options.activeHtml === undefined ? `source/${market}` : "active";
    tabs.set(tabId, { ...newTab(tabId, url, label, dom), served: true });
  }

  function loadProductPage(
    market: Marketplace,
    url: string,
    requestedAsin?: string,
    location?: string
  ): { group: FixtureGroup; dom: JSDOM } {
    const dom = fixtureDom("product", market, url, location);
    const pageAsin = dom.window.document.querySelector<HTMLInputElement>("#ASIN")?.value;
    if (requestedAsin === pageAsin || options.redirectAsinOn?.includes(market)) {
      return { group: "product", dom };
    }
    if (requestedAsin === EXPECTED_SOURCE.asin && options.sourceAsinOn?.includes(market)) {
      setPageAsin(dom.window.document, requestedAsin);
      return { group: "product", dom };
    }
    if (requestedAsin && options.variantAsinsOn?.[market]?.includes(requestedAsin)) {
      setPageAsin(dom.window.document, requestedAsin);
      return { group: "product", dom };
    }
    return { group: "missing", dom: fixtureDom("missing", market, url, location) };
  }

  function servePage(market: Marketplace, url: string, location?: string): ServedPage {
    const parsed = new URL(url);
    if (parsed.pathname === "/s" && options.checkpointOn?.includes(market)) {
      const checkpointUrl = new URL(CHECKPOINT_PATH, url).href;
      return { label: `checkpoint/${market}`, dom: new JSDOM(CHECKPOINT_HTML, { url: checkpointUrl }), finalUrl: checkpointUrl };
    }
    const requestedAsin = /\/dp\/([A-Z0-9]{10})/i.exec(parsed.pathname)?.[1]?.toUpperCase();
    const { group, dom } =
      parsed.pathname === "/s"
        ? { group: "search" as const, dom: fixtureDom("search", market, url, location) }
        : loadProductPage(market, url, requestedAsin, location);
    const label = `${group}/${market}`;
    if (options.robotCheckOn?.includes(label) || options.robotCheckOn?.includes(url)) {
      return { label: `robot-check/${market}`, dom: new JSDOM(ROBOT_CHECK_HTML, { url }), finalUrl: url };
    }
    if (options.serviceUnavailableOn?.includes(label) || options.serviceUnavailableOn?.includes(url)) {
      return { label: `http-503/${market}`, dom: new JSDOM(SERVICE_UNAVAILABLE_HTML, { url }), status: 503, finalUrl: url };
    }
    const pageAsin = dom.window.document.querySelector<HTMLInputElement>("#ASIN")?.value;
    const redirected = group === "product" && pageAsin && pageAsin !== requestedAsin && options.redirectAsinOn?.includes(market);
    return {
      label,
      dom,
      status: group === "missing" ? 404 : 200,
      finalUrl: redirected ? buildProductUrl(market, pageAsin) : url
    };
  }

  function openTempTab(url: string): FakeTab {
    const market = getMarketplaceByDomain(new URL(url).hostname);
    if (!market) {
      throw new Error(`No fixture for ${url}`);
    }
    const { label, dom, status } = servePage(market, url);
    const tab = newTab(nextTabId, url, label, dom, status);
    nextTabId += 1;
    tabs.set(tab.id, tab);
    return tab;
  }

  async function awaitDocument(tab: FakeTab): Promise<"ready" | "replaced"> {
    switch (tab.document) {
      case "blank":
        log(`blank ${tab.label}`, tab.market);
        throw new Error(NO_HOST_ACCESS_ERROR);
      case "error":
        log(`error page ${tab.label}`, tab.market);
        throw new Error(ERROR_PAGE_ERROR);
      case "no-access":
        log(`no access ${tab.label}`, tab.market);
        throw new Error(NO_HOST_ACCESS_ERROR);
      case "removed":
        log(`frame removed ${tab.label}`, tab.market);
        tab.document = "idle";
        throw new Error(FRAME_REMOVED_ERROR);
      case "replaced":
        log(`replaced ${tab.label}`, tab.market);
        tab.document = "idle";
        return "replaced";
      case "loading":
        if (!tab.waited) {
          tab.waited = true;
          log(`loading ${tab.label}`, tab.market);
        }
        await Promise.race([
          tab.idle,
          tab.closed.catch(() => {
            throw new Error(FRAME_REMOVED_ERROR);
          })
        ]);
        break;
      case "idle":
        break;
    }
    if (!tab.served) {
      tab.served = true;
      log(`ready ${tab.label}`, tab.market);
    }
    return "ready";
  }

  async function runInjection(injection: Injection): Promise<InjectionFrame[]> {
    const tab = requireTab(injection.target.tabId);
    if (tab.url.startsWith("chrome://")) {
      throw new Error("Cannot access a chrome:// URL");
    }

    const frame = { frameId: 0, documentId: `doc-${tab.id}` };
    if (injection.injectImmediately && !tab.served) {
      log(`inject immediately ${tab.label}`, tab.market);
      return runInDocument({ ...tab, dom: new JSDOM(UNPARSED_DOCUMENT_HTML, { url: tab.url }) }, injection, frame);
    }
    if ((await awaitDocument(tab)) === "replaced") {
      return [{ ...frame, result: null }];
    }
    return runInDocument(tab, injection, frame);
  }

  async function runInDocument(tab: FakeTab, injection: Injection, frame: InjectionFrame): Promise<InjectionFrame[]> {
    if (injection.files) {
      for (const file of injection.files) {
        log(`inject ${file} ${tab.label}`, tab.market);
        if (options.failScriptOn === tab.label || options.failScriptOn === tab.url) {
          throw new Error(FRAME_REMOVED_ERROR);
        }
        if (file.endsWith("-extractor.js") && options.holdScriptOn?.includes(tab.label)) {
          await tab.closed;
        }
        const script = CONTENT_SCRIPTS[file];
        if (!script) {
          throw new Error(`Could not load file: '${file}'.`);
        }
        script(tab);
      }
      return [frame];
    }

    if (injection.func) {
      const isolatedWorld = new Function(
        "window",
        "document",
        "location",
        "performance",
        "args",
        `return (${injection.func.toString()})(...args);`
      ) as (
        scope: WindowScope,
        document: Document,
        location: Location,
        performance: NavigationEntries,
        args: unknown[]
      ) => unknown;
      const { document, location } = tab.dom.window;
      const navigation = { responseStatus: tab.responseStatus };
      const performance: NavigationEntries = { getEntriesByType: (type) => (type === "navigation" ? [navigation] : []) };
      const result = isolatedWorld(tab.scope, document, location, performance, structuredClone(injection.args ?? []));
      const settled = result instanceof Promise ? await Promise.race([result, tab.closed]) : result;
      return [{ ...frame, result: structuredClone(settled) }];
    }

    throw new Error("Either files or func must be specified");
  }

  const tabsCreate = vi.fn(async ({ url }: { url: string; active?: boolean }) => {
    const tab = openTempTab(url);
    log(`open ${tab.label}`, tab.market);
    options.onTabCreated?.(tab, harness);
    return { id: tab.id, url, active: false, status: "loading" };
  });

  function documentIdle(tabId: number): void {
    const tab = requireTab(tabId);
    tab.document = "idle";
    tab.reachIdle();
  }

  function silentRemove(tabId: number): void {
    const tab = requireTab(tabId);
    tabs.delete(tabId);
    tab.close();
    log(`close ${tab.label}`, tab.market);
  }

  const tabsRemove = vi.fn(async (tabId: number) => {
    silentRemove(tabId);
    for (const listener of [...removedListeners]) {
      listener(tabId);
    }
  });

  const executeScript = vi.fn(async (injection: Injection) => runInjection(injection));

  async function answerAmazon(market: Marketplace, url: URL, init: RequestInit): Promise<FetchAnswer> {
    const headers = (init.headers ?? {}) as Record<string, string>;
    const via = init.credentials === "include" ? "fetch " : "";
    const answer = (status: number, body: string): FetchAnswer => ({
      ok: status >= 200 && status < 300,
      status,
      url: url.href,
      text: async () => body
    });
    const refusesLocation = via !== "" && options.rejectLocationFetchOn?.includes(market) === true;
    if (url.pathname === LOCATION_FORM_PATH) {
      log(`${via}location form ${url.hostname}`, market);
      await options.holdLocation;
      if (refusesLocation) {
        return answer(403, "");
      }
      const form = options.notOfferedOn?.includes(market) ? "AU-modal.html" : locationFormFile(market);
      return answer(200, readLocationFixture(headers["anti-csrftoken-a2z"] === PAGE_TOKEN ? form : "degraded-modal.html"));
    }
    if (url.pathname === ADDRESS_CHANGE_PATH && init.method === "POST") {
      const countryCode = (JSON.parse(String(init.body)) as { countryCode: string }).countryCode;
      log(`${via}location change ${url.hostname} ${countryCode}`, market);
      if (refusesLocation) {
        return answer(403, "");
      }
      const accepted =
        headers["anti-csrftoken-a2z"] === POST_TOKEN &&
        headers["Content-Type"] === "application/json" &&
        !options.rejectLocationOn?.includes(market);
      if (!accepted) {
        return answer(200, "");
      }
      locations.set(market, countryCode);
      const success = JSON.parse(readLocationFixture("address-change-CH.json")) as { address: Record<string, unknown> };
      return answer(200, JSON.stringify({ ...success, address: { ...success.address, countryCode, district: countryCode } }));
    }
    if (url.pathname === OFFERS_PATH) {
      log(`${via}offers ${url.hostname}`, market);
      await options.holdOffers;
      const refusal = options.offersStatusOn?.[market];
      if (via !== "" && refusal !== undefined && !refusedOffers.has(market)) {
        refusedOffers.add(market);
        return answer(refusal, "");
      }
      if (via !== "" && options.captchaOn?.includes(`offers/${market}`)) {
        return answer(200, ROBOT_CHECK_HTML);
      }
      const file = options.offersOn?.[market];
      return file ? answer(200, readOffersFixture(file)) : answer(404, "");
    }
    return answer(404, "");
  }

  function listed(labels: string[] | undefined, label: string, url: string): boolean {
    return labels?.includes(label) === true || labels?.includes(url) === true;
  }

  async function answerPage(market: Marketplace, url: URL): Promise<FetchAnswer> {
    const served = servePage(market, url.href);
    const shown = listed(options.fetchKeepsLocationOn, served.label, url.href)
      ? initialLocation(market)
      : options.fetchShowsLocationOn?.[served.label];
    const page = shown ? servePage(market, url.href, shown) : served;
    if (listed(options.captchaOn, page.label, url.href)) {
      log(`fetch robot-check/${market}`, market);
      pageFetches.push({ label: `robot-check/${market}`, url: url.href, status: 200 });
      return pageResponse(ROBOT_CHECK_HTML, url.href, 200);
    }
    const status = page.status ?? 200;
    log(`fetch ${page.label}`, market);
    pageFetches.push({ label: page.label, url: url.href, status });
    if (listed(options.failFetchOn, page.label, url.href)) {
      throw new TypeError("Failed to fetch");
    }
    if (listed(options.holdFetchOn, page.label, url.href)) {
      await (options.holdFetch ?? new Promise<never>(() => undefined));
    }
    if (listed(options.shapelessOn, page.label, url.href)) {
      return pageResponse(SHAPELESS_HTML, url.href, 200);
    }
    const finalUrl = options.redirectOn?.[page.label] ?? options.redirectOn?.[url.href] ?? page.finalUrl;
    return pageResponse(page.dom.serialize(), finalUrl, status);
  }

  const fetchMock = vi.fn(async (input: string, init: RequestInit = {}): Promise<FetchAnswer> => {
    const url = new URL(input);
    const market = getMarketplaceByDomain(url.hostname);
    if (market) {
      const fetched = init.credentials === "include";
      const answer = fetched && PAGE_PATH.test(url.pathname) ? answerPage(market, url) : answerAmazon(market, url, init);
      return fetched ? abortable(init.signal, answer) : answer;
    }
    const host = url.hostname;
    log(`fx ${host}`);
    const hold = fxHold;
    fxHold = undefined;
    await hold;
    if (options.fxAvailable === false || host !== "www.ecb.europa.eu") {
      return { ok: false, status: 503 };
    }
    return { ok: true, status: 200, text: async () => ECB_XML };
  });

  async function sendToOffscreen(message: ExtensionMessage): Promise<unknown> {
    const copy = JSON.parse(JSON.stringify(message)) as ExtensionMessage;
    offscreenMessages.push(copy);
    if (copy.type === OFFSCREEN_CANCEL_RUN) {
      log("offscreen cancel");
    }
    if (!offscreenOpen) {
      throw new Error(POPUP_CLOSED_ERROR);
    }
    if (copy.type === OFFSCREEN_PAGE_JOB) {
      const { url } = copy.payload as PageJob;
      const market = getMarketplaceByDomain(new URL(url).hostname);
      if (options.offscreenSilent) {
        return new Promise<never>(() => undefined);
      }
      if (market && listed(options.closeOffscreenOn, servePage(market, url).label, url)) {
        offscreenOpen = false;
        log("offscreen crash");
        throw new Error(CHANNEL_CLOSED_ERROR);
      }
    }
    return new Promise((resolve) => {
      let answered = false;
      const keepsChannel = offscreenListener(copy, WORKER_SENDER, (response) => {
        answered = true;
        resolve(response === undefined ? undefined : JSON.parse(JSON.stringify(response)));
      });
      if (!keepsChannel && !answered) {
        resolve(undefined);
      }
    });
  }

  const offscreenMock = {
    createDocument: vi.fn(async () => {
      await options.holdCreate;
      if (options.offscreenCreateFails) {
        throw new Error(options.offscreenCreateFails);
      }
      if (offscreenOpen) {
        throw new Error(SINGLE_DOCUMENT_ERROR);
      }
      offscreenOpen = true;
      log("offscreen create");
    }),
    closeDocument: vi.fn(async () => {
      if (!offscreenOpen) {
        throw new Error(NO_DOCUMENT_ERROR);
      }
      offscreenOpen = false;
      log("offscreen close");
    })
  };

  const chromeMock = {
    ...(options.offscreen === false ? {} : { offscreen: offscreenMock }),
    tabs: {
      create: tabsCreate,
      get: vi.fn(async (tabId: number) => {
        const tab = requireTab(tabId);
        return { id: tab.id, url: tab.url, status: tab.status };
      }),
      remove: tabsRemove,
      onUpdated: {
        addListener: vi.fn((listener: TabUpdatedListener) => updatedListeners.add(listener)),
        removeListener: vi.fn((listener: TabUpdatedListener) => updatedListeners.delete(listener))
      },
      onRemoved: {
        addListener: vi.fn((listener: TabRemovedListener) => removedListeners.add(listener)),
        removeListener: vi.fn((listener: TabRemovedListener) => removedListeners.delete(listener))
      }
    },
    scripting: {
      executeScript
    },
    storage: {
      local: {
        get: vi.fn(async (key: string) => (key in storage ? { [key]: structuredClone(storage[key]) } : {})),
        set: vi.fn(async (items: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(items)) {
            storage[key] = JSON.parse(JSON.stringify(value));
          }
        }),
        remove: vi.fn(async (key: string) => {
          delete storage[key];
        })
      }
    },
    runtime: {
      id: EXTENSION_ID,
      sendMessage: vi.fn(async (message: ExtensionMessage) => {
        if (isOffscreenMessage(message)) {
          return sendToOffscreen(message);
        }
        const copy = structuredClone(message);
        messages.push(copy);
        if (copy.type === RUN_COMPARISON_PROGRESS) {
          const payload = copy.payload as RunComparisonProgressPayload;
          const latest = payload.latest;
          log(latest ? `progress ${latest.phase} ${latest.marketplace}` : "progress DONE", latest?.marketplace);
        }
        if (options.popupClosed) {
          throw new Error(POPUP_CLOSED_ERROR);
        }
      }),
      onMessage: {
        addListener: vi.fn((listener: MessageListener) => {
          listeners.push(listener);
        })
      }
    }
  };

  const harness: Harness = {
    chrome: chromeMock as unknown as typeof chrome,
    fetch: fetchMock,
    storage,
    events,
    eventMarkets,
    messages,
    offscreenMessages,
    tabsCreate,
    tabsRemove,
    executeScript,
    pageFetches,
    pageFetchUrls: () => pageFetches.map((fetched) => fetched.url),
    locationOf: (market) => locations.get(market),
    openTempTabs: () =>
      [...tabs.values()].filter((tab) => tab.id !== ACTIVE_TAB_ID && tab.id !== SECOND_TAB_ID).map((tab) => tab.label),
    tabListenerCount: () => updatedListeners.size + removedListeners.size,
    documentIdle,
    silentRemove,
    dispatch: (message) => {
      const listener = listeners[listeners.length - 1];
      if (!listener) {
        throw new Error("Service worker did not register a message listener");
      }
      return new Promise((resolve) => {
        listener(message, {}, resolve);
      });
    }
  };

  registerActiveTab(ACTIVE_TAB_ID, options.activeUrl ?? SOURCE_URL);
  if (options.secondActiveUrl) {
    registerActiveTab(SECOND_TAB_ID, options.secondActiveUrl);
  }
  return harness;
}

async function bootServiceWorker(options: HarnessOptions = {}): Promise<Harness> {
  vi.resetModules();
  const { handleOffscreenMessage } = await import("../../src/offscreen/page-reader");
  const harness = createHarness(options, handleOffscreenMessage);
  vi.stubGlobal("chrome", harness.chrome);
  vi.stubGlobal("fetch", harness.fetch);
  await import("../../src/background/service-worker");
  return harness;
}

async function loadSourceViaWorker(harness: Harness): Promise<LoadSourcePayload> {
  return (await harness.dispatch({ type: LOAD_SOURCE, payload: { activeTabId: ACTIVE_TAB_ID } })) as LoadSourcePayload;
}

async function runViaWorker(harness: Harness, runId = "run-1", activeTabId = ACTIVE_TAB_ID): Promise<RunComparisonResultPayload> {
  const response = await harness.dispatch({ type: RUN_COMPARISON, payload: { activeTabId, runId } });
  expect(response).toEqual({ ok: true });
  return resultPayloads(harness, runId).at(-1) as RunComparisonResultPayload;
}

function startRunViaWorker(harness: Harness, runId: string, activeTabId = ACTIVE_TAB_ID): Promise<unknown> {
  return harness.dispatch({ type: RUN_COMPARISON, payload: { activeTabId, runId } });
}

function cancelViaWorker(harness: Harness, activeTabId = ACTIVE_TAB_ID): Promise<unknown> {
  return harness.dispatch({ type: CANCEL_COMPARISON, payload: { activeTabId } });
}

function progressPayloads(harness: Harness, runId?: string): RunComparisonProgressPayload[] {
  return harness.messages
    .filter((message) => message.type === RUN_COMPARISON_PROGRESS)
    .map((message) => message.payload as RunComparisonProgressPayload)
    .filter((payload) => runId === undefined || payload.runId === runId);
}

function resultPayloads(harness: Harness, runId?: string): RunComparisonResultPayload[] {
  return harness.messages
    .filter((message) => message.type === RUN_COMPARISON_RESULT)
    .map((message) => message.payload as RunComparisonResultPayload)
    .filter((payload) => runId === undefined || payload.runId === runId);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function cacheKeyFor(targetMarkets: Marketplace[], deliverTo = EXPECTED_SOURCE.deliverTo): string {
  return buildComparisonCacheKey({
    asin: EXPECTED_SOURCE.asin,
    variationTokens: EXPECTED_SOURCE.variationTokens,
    sourceMarketplace: "US",
    destinationCountryCode: "US",
    deliverTo,
    targetMarkets
  });
}

function earlierCacheKeyFor(targetMarkets: Marketplace[], version?: number): string {
  const value = [
    ...(version === undefined ? [] : [version]),
    EXPECTED_SOURCE.asin,
    [...EXPECTED_SOURCE.variationTokens].sort().join("|"),
    "US",
    "US",
    ...(version !== undefined && version >= 4 ? [(EXPECTED_SOURCE.deliverTo ?? "").toLowerCase()] : []),
    [...targetMarkets].sort().join("|")
  ].join("::");
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }
  return `cmp:${Math.abs(hash)}`;
}

function addColourTwister(document: Document, selected: string, options: Array<[asin: string, label: string]>): void {
  const swatches = options
    .map(([asin, label]) => `<li data-asin="${asin}" class="inline-twister-swatch"><img alt="${label}" class="swatch-image"></li>`)
    .join("");
  document.body.insertAdjacentHTML(
    "beforeend",
    `<div id="inline-twister-row-color_name"><span id="inline-twister-expanded-dimension-text-color_name">${selected}</span><ul>${swatches}</ul></div>`
  );
}

function replaceOfferWithLiveBlocks(document: Document, file: string, blocks: string[]): void {
  for (const selector of OFFER_SELECTORS) {
    removeElement(document, selector);
  }
  const live = new JSDOM(readFileSync(join(FIXTURE_ROOT, "product-live", file), "utf8")).window.document;
  for (const block of blocks) {
    const section = live.querySelector(`section[data-live-block='${block}']`);
    if (!section) {
      throw new Error(`No ${block} block in ${file}`);
    }
    document.body.insertAdjacentHTML("beforeend", section.innerHTML);
  }
}

function eventsAfterStartup(harness: Harness): string[] {
  const [first, ...rest] = harness.events;
  const storesStart = rest.findIndex((event) => event.startsWith("progress "));
  expect(first).toBe("inject content/source-extractor.js source/US");
  expect(rest.slice(0, storesStart).sort()).toEqual(["fx www.ecb.europa.eu", "inject content/product-extractor.js source/US"]);
  return rest.slice(storesStart);
}

function marketEvents(harness: Harness, market: Marketplace): string[] {
  return harness.events.filter((_event, index) => harness.eventMarkets[index] === market);
}

function openedOn(harness: Harness, market: Marketplace): string[] {
  return marketEvents(harness, market)
    .filter((event) => event.startsWith("open "))
    .map((event) => event.slice("open ".length));
}

function fetchedOn(harness: Harness, market: Marketplace): string[] {
  return harness.pageFetches.filter((fetched) => fetched.label.endsWith(`/${market}`)).map((fetched) => fetched.label);
}

function pageJobs(harness: Harness): PageJob[] {
  return harness.offscreenMessages
    .filter((message) => message.type === OFFSCREEN_PAGE_JOB)
    .map((message) => message.payload as PageJob);
}

function countOf(harness: Harness, event: string): number {
  return harness.events.filter((logged) => logged === event).length;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("background orchestrator", () => {
  describe("full run", () => {
    const fullRunOptions: HarnessOptions = {
      enabledMarketplaces: ["US", "UK", "DE", "FR", "IT", "ES", "JP"],
      sourceAsinOn: ["UK", "JP"],
      redirectAsinOn: ["ES"],
      locations: { JP: "JP" },
      rejectLocationOn: ["JP"],
      prepare: (group, market, document) => {
        if (group === "search" && market === "FR") {
          removeElement(document, "[data-asin='B000000006']");
        }
      }
    };

    it("LOAD_SOURCE returns the source context with its image and the raw baseline without opening tabs, reading settings or fetching FX", async () => {
      const harness = await bootServiceWorker(fullRunOptions);

      const response = await loadSourceViaWorker(harness);

      expect(response).toEqual({ source: EXPECTED_SOURCE, baseline: RAW_BASELINE });
      expect(response.baseline).not.toHaveProperty("normalizedTotal");
      expect(harness.tabsCreate).not.toHaveBeenCalled();
      expect(harness.fetch).not.toHaveBeenCalled();
      expect(harness.chrome.storage.local.get).not.toHaveBeenCalled();
      expect(harness.events.filter((event) => event.startsWith("inject"))).toEqual([
        "inject content/source-extractor.js source/US",
        "inject content/product-extractor.js source/US"
      ]);
    });

    it("compares every enabled market and returns sorted, normalized results with the baseline and FX table", async () => {
      const harness = await bootServiceWorker(fullRunOptions);

      const payload = await runViaWorker(harness);

      expect(payload.error).toBeUndefined();
      expect(payload.activeTabId).toBe(ACTIVE_TAB_ID);
      expect(payload.runId).toBe("run-1");
      expect(payload.source).toEqual(EXPECTED_SOURCE);
      expect(payload.baseline).toEqual(EXPECTED_BASELINE);
      expect(payload.fxTable).toEqual(EXPECTED_FX_TABLE);
      expect(payload.results.map((result) => [result.marketplace, result.status, result.normalizedTotal?.amount])).toEqual([
        ["ES", "OK", 46.12],
        ["IT", "OK", 47.52],
        ["UK", "OK", 47.79],
        ["DE", "OK", 48.49],
        ["FR", "NO_CONFIDENT_MATCH", undefined],
        ["JP", "DESTINATION_MISMATCH", undefined]
      ]);
      expect(payload.results.find((result) => result.marketplace === "DE")).toEqual(EXPECTED_DE_RESULT);

      for (const result of payload.results.filter((entry) => entry.status === "OK")) {
        expect(result.normalizedTotal?.currency).toBe("USD");
      }

      expect(payload.results.find((result) => result.marketplace === "UK")).toMatchObject({
        confidence: 1,
        productUrl: "https://www.amazon.co.uk/dp/B000000001",
        notes: ["Matched by ASIN"]
      });
      expect(payload.results.find((result) => result.marketplace === "JP")).toEqual({
        marketplace: "JP",
        status: "DESTINATION_MISMATCH",
        confidence: 0.98,
        productUrl: "https://www.amazon.co.jp/dp/B000000001",
        notes: [
          "Matched by ASIN",
          NOT_ACCEPTED_NOTE,
          "Destination mismatch detected (JP)",
          "Destination on product page does not match source destination"
        ]
      });
      expect(payload.results.find((result) => result.marketplace === "ES")).toMatchObject({
        productUrl: "https://www.amazon.es/dp/B000000008",
        notes: ["Matched by search", "Match confidence: HIGH"]
      });

      expect(fetchedOn(harness, "UK")).toEqual(["product/UK"]);
      expect(fetchedOn(harness, "DE")).toEqual(["missing/DE", "search/DE", "product/DE"]);
      expect(fetchedOn(harness, "FR")).toEqual(["missing/FR", "search/FR"]);
      expect(fetchedOn(harness, "IT")).toEqual(["missing/IT", "search/IT", "product/IT"]);
      expect(fetchedOn(harness, "ES")).toEqual(["product/ES", "search/ES", "product/ES"]);
      expect(fetchedOn(harness, "JP")).toEqual(["product/JP"]);
      expect(openedOn(harness, "JP")).toEqual(["product/JP"]);
      for (const market of ["UK", "DE", "FR", "IT", "ES"] as const) {
        expect(openedOn(harness, market)).toEqual([]);
      }
      expect(harness.openTempTabs()).toEqual([]);

      const jpOpen = progressPayloads(harness).find(
        (progress) => progress.latest?.marketplace === "JP" && progress.latest.phase === "OPEN"
      );
      expect(jpOpen?.completed).toBe(5);
      expect(jpOpen?.results?.map((result) => result.marketplace)).toEqual(["ES", "IT", "UK", "DE", "FR"]);
    });

    it("writes the cache record with the baseline and FX table", async () => {
      const harness = await bootServiceWorker(fullRunOptions);

      const payload = await runViaWorker(harness);
      const record = harness.storage[cacheKeyFor(["UK", "DE", "FR", "IT", "ES", "JP"])] as CachedComparisonRecord;

      expect(record).toEqual({
        createdAt: payload.generatedAt,
        source: EXPECTED_SOURCE,
        baseline: EXPECTED_BASELINE,
        results: payload.results,
        fxTable: EXPECTED_FX_TABLE
      });
    });

    it("loads FX rates before fetching any marketplace page", async () => {
      const harness = await bootServiceWorker(fullRunOptions);

      await runViaWorker(harness);

      const fxIndex = harness.events.indexOf("fx www.ecb.europa.eu");
      const firstFetchIndex = harness.events.findIndex((event) => event.startsWith("fetch "));
      expect(fxIndex).toBeGreaterThan(-1);
      expect(fxIndex).toBeLessThan(firstFetchIndex);
    });
  });

  describe("delivered total", () => {
    function withDisplayedTotal(text: string): Prepare {
      return (group, market, document) => {
        const total = document.querySelector("#subtotals-marketplace-table .a-color-price");
        if (group === "product" && market === "DE" && total) {
          total.textContent = text;
        }
      };
    }

    it("ignores a displayed total below the item, shipping and import fees and normalizes their sum", async () => {
      const harness = await bootServiceWorker({ enabledMarketplaces: ["US", "DE"] });

      const payload = await runViaWorker(harness);

      expect(payload.results[0].breakdown?.totalDisplayed).toEqual({ amount: 37.2, currency: "EUR" });
      expect(payload.results[0].normalizedTotal).toEqual({ amount: 48.49, currency: "USD" });
    });

    it("normalizes a displayed total that covers every charge", async () => {
      const harness = await bootServiceWorker({ enabledMarketplaces: ["US", "DE"], prepare: withDisplayedTotal("€46,00") });

      const payload = await runViaWorker(harness);

      expect(payload.results[0].breakdown?.totalDisplayed).toEqual({ amount: 46, currency: "EUR" });
      expect(payload.results[0].normalizedTotal).toEqual({ amount: 49.68, currency: "USD" });
    });
  });

  describe("progress", () => {
    it("emits OPEN, SEARCH, MATCH and READ per market with growing sorted results, then a completion message", async () => {
      const harness = await bootServiceWorker({ enabledMarketplaces: ["US", "UK", "DE"] });

      await runViaWorker(harness);
      const progress = progressPayloads(harness);

      const phaseMessage = (
        completed: number,
        marketplace: Marketplace,
        phase: ComparisonPhase,
        results: Marketplace[]
      ) => ({
        completed,
        total: 2,
        inFlight: [{ marketplace, phase }],
        latest: { marketplace, phase },
        results
      });
      expect(
        progress.map(({ completed, total, inFlight, latest, results }) => ({
          completed,
          total,
          inFlight,
          latest,
          results: results?.map((result) => result.marketplace)
        }))
      ).toEqual([
        phaseMessage(0, "UK", "OPEN", []),
        phaseMessage(0, "UK", "SEARCH", []),
        phaseMessage(0, "UK", "MATCH", []),
        phaseMessage(0, "UK", "READ", []),
        phaseMessage(1, "DE", "OPEN", ["UK"]),
        phaseMessage(1, "DE", "SEARCH", ["UK"]),
        phaseMessage(1, "DE", "MATCH", ["UK"]),
        phaseMessage(1, "DE", "READ", ["UK"]),
        { completed: 2, total: 2, inFlight: [], latest: undefined, results: ["UK", "DE"] }
      ]);

      for (const entry of progress) {
        expect(entry).toMatchObject({ activeTabId: ACTIVE_TAB_ID, runId: "run-1", fxTable: EXPECTED_FX_TABLE });
      }

      const final = progress[progress.length - 1];
      expect(final.inFlight).toEqual([]);
      expect(final).not.toHaveProperty("latest");
      expect(progress[4].results?.[0].normalizedTotal).toEqual({ amount: 47.79, currency: "USD" });
      expect(final.results?.[1]).toEqual(EXPECTED_DE_RESULT);
    });

    it("emits each phase at the right point of the tab lifecycle", async () => {
      const harness = await bootServiceWorker({ ...TAB_PATH, enabledMarketplaces: ["US", "DE"] });

      await runViaWorker(harness);

      expect(eventsAfterStartup(harness)).toEqual([
        "progress OPEN DE",
        "open missing/DE",
        "ready missing/DE",
        "inject content/location-setter.js missing/DE",
        "inject content/product-extractor.js missing/DE",
        "close missing/DE",
        "open search/DE",
        "ready search/DE",
        "progress SEARCH DE",
        "inject content/search-extractor.js search/DE",
        "close search/DE",
        "progress MATCH DE",
        "open product/DE",
        "ready product/DE",
        "progress READ DE",
        "inject content/product-extractor.js product/DE",
        "close product/DE",
        "progress DONE"
      ]);
    });

    it("emits each phase at the right point of the fetch path", async () => {
      const harness = await bootServiceWorker({ enabledMarketplaces: ["US", "DE"] });

      await runViaWorker(harness);

      expect(eventsAfterStartup(harness)).toEqual([
        "progress OPEN DE",
        "offscreen create",
        "fetch missing/DE",
        "progress SEARCH DE",
        "fetch search/DE",
        "progress MATCH DE",
        "progress READ DE",
        "fetch product/DE",
        "progress DONE",
        "offscreen close"
      ]);
      expect(harness.tabsCreate).not.toHaveBeenCalled();
    });
  });

  describe("parallel reads", () => {
    const offersOnSourcePage: HarnessOptions = {
      enabledMarketplaces: ["DE", "US"],
      activeUrl: "https://www.amazon.de/dp/B000000005",
      offersOn: { DE: "DE-four-new-offers.html" },
      prepare: (group, _market, document) => {
        if (group === "source") {
          offerOnlyOtherSellers(document);
        }
      }
    };

    function storeEvents(harness: Harness): string[] {
      return harness.events.filter((event) => event.startsWith("open ") || event.startsWith("progress "));
    }

    it("asks for the exchange rates while the baseline is still being read", async () => {
      const offers = deferred();
      const harness = await bootServiceWorker({ ...offersOnSourcePage, holdOffers: offers.promise });

      const run = runViaWorker(harness);
      await vi.waitFor(() => expect(harness.events).toEqual(expect.arrayContaining(["offers www.amazon.de", "fx www.ecb.europa.eu"])));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(storeEvents(harness)).toEqual([]);
      offers.resolve();
      const payload = await run;

      expect(payload.error).toBeUndefined();
      expect(payload.baseline).toMatchObject({ marketplace: "DE", status: "OK", otherSeller: { seller: "Star Brick City" } });
      expect(payload.results.map((result) => [result.marketplace, result.status])).toEqual([["US", "OK"]]);
    });

    it("starts no store before both the baseline and the exchange rates are in", async () => {
      const fx = deferred();
      const harness = await bootServiceWorker({ enabledMarketplaces: ["US", "DE"], holdFx: fx.promise });

      const run = runViaWorker(harness);
      await vi.waitFor(() =>
        expect(harness.events).toEqual(expect.arrayContaining(["inject content/product-extractor.js source/US", "fx www.ecb.europa.eu"]))
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(storeEvents(harness)).toEqual([]);
      fx.resolve();
      const payload = await run;

      expect(payload.error).toBeUndefined();
      expect(payload.baseline).toEqual(EXPECTED_BASELINE);
      expect(payload.results).toEqual([EXPECTED_DE_RESULT]);
    });

    it("keeps the raw baseline in the error payload when the rates fail while the baseline is still being read", async () => {
      const unhandled: unknown[] = [];
      const recordUnhandled = (reason: unknown) => {
        unhandled.push(reason);
      };
      process.on("unhandledRejection", recordUnhandled);

      try {
        const offers = deferred();
        const harness = await bootServiceWorker({ ...offersOnSourcePage, fxAvailable: false, holdOffers: offers.promise });

        const run = runViaWorker(harness);
        await vi.waitFor(() => expect(harness.fetch).toHaveBeenCalledTimes(3));
        await new Promise((resolve) => setTimeout(resolve, 10));
        offers.resolve();
        const payload = await run;

        expect(payload.error).toBe("Unable to load FX reference rates from ECB or Frankfurter");
        expect(payload.results).toEqual([]);
        expect(payload.fxTable).toBeUndefined();
        expect(payload.baseline).toMatchObject({ marketplace: "DE", status: "OK", otherSeller: { seller: "Star Brick City" } });
        expect(payload.baseline).not.toHaveProperty("normalizedTotal");
        expect(storeEvents(harness)).toEqual([]);
        expect(unhandled).toEqual([]);
      } finally {
        process.off("unhandledRejection", recordUnhandled);
      }
    });
  });

  describe("ASIN lookup", () => {
    const ASIN_DE_RESULT: ComparisonResult = {
      ...EXPECTED_DE_RESULT,
      confidence: 1,
      productUrl: "https://www.amazon.de/dp/B000000001",
      notes: ["Matched by ASIN"]
    };

    it("reads a marketplace that carries the source ASIN straight from its product page, in one page read", async () => {
      const harness = await bootServiceWorker({ enabledMarketplaces: ["US", "DE"], sourceAsinOn: ["DE"] });

      const payload = await runViaWorker(harness);

      expect(payload.error).toBeUndefined();
      expect(payload.results).toEqual([ASIN_DE_RESULT]);
      expect(harness.pageFetchUrls()).toEqual(["https://www.amazon.de/dp/B000000001"]);
      expect(eventsAfterStartup(harness)).toEqual([
        "progress OPEN DE",
        "offscreen create",
        "fetch product/DE",
        "progress READ DE",
        "progress DONE",
        "offscreen close"
      ]);
      expect(harness.tabsCreate).not.toHaveBeenCalled();
    });

    it("reports OPEN then READ for a marketplace matched by ASIN and the full search phases for the others", async () => {
      const harness = await bootServiceWorker({ enabledMarketplaces: ["US", "UK", "DE"], sourceAsinOn: ["UK"] });

      await runViaWorker(harness);

      expect(progressPayloads(harness).map(({ latest }) => [latest?.marketplace, latest?.phase])).toEqual([
        ["UK", "OPEN"],
        ["UK", "READ"],
        ["DE", "OPEN"],
        ["DE", "SEARCH"],
        ["DE", "MATCH"],
        ["DE", "READ"],
        [undefined, undefined]
      ]);
    });

    it("searches a marketplace that has no page for the source ASIN", async () => {
      const harness = await bootServiceWorker({ enabledMarketplaces: ["US", "DE"] });

      const payload = await runViaWorker(harness);

      expect(payload.results).toEqual([EXPECTED_DE_RESULT]);
      expect(harness.pageFetchUrls()).toEqual([
        "https://www.amazon.de/dp/B000000001",
        "https://www.amazon.de/s?k=Acme%20Ultra%20Widget%20Model%20X100%202%20Pack%20Blue%20Acme%202%20pack%2016%20oz%20blue",
        "https://www.amazon.de/dp/B000000005"
      ]);
    });

    it("searches by brand and model number when the source title carries a distinctive one", async () => {
      const harness = await bootServiceWorker({
        enabledMarketplaces: ["US", "DE"],
        prepare: (_group, _market, document) => {
          for (const element of document.querySelectorAll("#productTitle, h2 span")) {
            element.textContent = element.textContent?.replace("Model X100", "AW-2400X") ?? null;
          }
        }
      });

      const payload = await runViaWorker(harness);

      expect(harness.pageFetchUrls()).toEqual([
        "https://www.amazon.de/dp/B000000001",
        "https://www.amazon.de/s?k=Acme%20AW-2400X",
        "https://www.amazon.de/dp/B000000005"
      ]);
      expect(payload.results).toMatchObject([{ marketplace: "DE", status: "OK", productUrl: "https://www.amazon.de/dp/B000000005" }]);
    });

    it("searches by the title when the brand and model number search lists no match", async () => {
      const modelQueryUrl = "https://www.amazon.de/s?k=Acme%20AW-2400X";
      const harness = await bootServiceWorker({
        enabledMarketplaces: ["US", "DE"],
        prepare: (group, _market, document) => {
          for (const element of document.querySelectorAll("#productTitle, h2 span")) {
            element.textContent = element.textContent?.replace("Model X100", "AW-2400X") ?? null;
          }
          if (group === "search" && document.URL === modelQueryUrl) {
            document.querySelector("[data-asin='B000000005']")?.remove();
          }
        }
      });

      const payload = await runViaWorker(harness);

      expect(harness.pageFetchUrls()).toEqual([
        "https://www.amazon.de/dp/B000000001",
        modelQueryUrl,
        "https://www.amazon.de/s?k=Acme%20Ultra%20Widget%20AW-2400X%202%20Pack%20Blue%20Acme%202%20pack%2016%20oz%20blue",
        "https://www.amazon.de/dp/B000000005"
      ]);
      expect(progressPayloads(harness).map((progress) => progress.latest?.phase)).toEqual([
        "OPEN",
        "SEARCH",
        "MATCH",
        "SEARCH",
        "MATCH",
        "READ",
        undefined
      ]);
      expect(payload.results).toMatchObject([{ marketplace: "DE", status: "OK", productUrl: "https://www.amazon.de/dp/B000000005" }]);
      expect(harness.openTempTabs()).toEqual([]);
    });

    it("searches a marketplace whose page for the source ASIN shows another product", async () => {
      const harness = await bootServiceWorker({ enabledMarketplaces: ["US", "DE"], redirectAsinOn: ["DE"] });

      const payload = await runViaWorker(harness);

      expect(payload.results).toEqual([EXPECTED_DE_RESULT]);
      expect(fetchedOn(harness, "DE")).toEqual(["product/DE", "search/DE", "product/DE"]);
      expect(harness.tabsCreate).not.toHaveBeenCalled();
    });

    it("does not trust the source ASIN on a page whose title has nothing in common with the source", async () => {
      const harness = await bootServiceWorker({
        enabledMarketplaces: ["US", "DE"],
        sourceAsinOn: ["DE"],
        prepare: (group, _market, document) => {
          const title = document.querySelector("#productTitle");
          if (group === "product" && title) {
            title.textContent = "Garden Hose Reel Wall Mounted";
          }
        }
      });

      const payload = await runViaWorker(harness);

      expect(payload.results).toEqual([EXPECTED_DE_RESULT]);
      expect(harness.events).toContain("fetch search/DE");
    });

    it("reports a page for the source ASIN that shows no price as unavailable, with Amazon's reason, instead of searching", async () => {
      const harness = await bootServiceWorker({
        enabledMarketplaces: ["US", "DE"],
        sourceAsinOn: ["DE"],
        prepare: (group, _market, document) => {
          if (group !== "product") {
            return;
          }
          for (const selector of [
            "#corePriceDisplay_desktop_feature_div",
            "#deliveryBlockMessage",
            "#exports_desktop_feature_div",
            "#subtotals-marketplace-table"
          ]) {
            removeElement(document, selector);
          }
          document.body.insertAdjacentHTML(
            "beforeend",
            '<div id="availability"><span class="primary-availability-message">This item cannot be shipped to your selected delivery location.</span></div>'
          );
        }
      });

      const payload = await runViaWorker(harness);

      expect(payload.results).toEqual([
        {
          marketplace: "DE",
          status: "UNAVAILABLE",
          confidence: 0.82,
          productUrl: "https://www.amazon.de/dp/B000000001",
          notes: [
            "Matched by ASIN",
            "Price not displayed for destination",
            "Amazon says: This item cannot be shipped to your selected delivery location.",
            "Shipping not displayed for destination",
            "Import fees not displayed for destination"
          ]
        }
      ]);
      expect(harness.events).not.toContain("fetch search/DE");
      expect(harness.pageFetchUrls()).toHaveLength(1);
      expect(harness.tabsCreate).not.toHaveBeenCalled();
      expect(progressPayloads(harness).map((progress) => progress.latest?.phase)).toEqual(["OPEN", "READ", undefined]);
    });

    describe("dead listings", () => {
      const SOURCE_ASIN_URL = "https://www.amazon.de/dp/B000000001";
      const TITLE_QUERY_URL =
        "https://www.amazon.de/s?k=Acme%20Ultra%20Widget%20Model%20X100%202%20Pack%20Blue%20Acme%202%20pack%2016%20oz%20blue";

      function onSourceAsinPage(file: string, blocks: string[]): Prepare {
        return (group, _market, document) => {
          if (group === "product" && document.URL === SOURCE_ASIN_URL) {
            replaceOfferWithLiveBlocks(document, file, blocks);
          }
        };
      }

      it("searches a marketplace whose page for the source ASIN is a dead listing and quotes the listing the search finds", async () => {
        const harness = await bootServiceWorker({
          enabledMarketplaces: ["US", "DE"],
          sourceAsinOn: ["DE"],
          prepare: onSourceAsinPage("DE-currently-unavailable.html", ["availability", "buybox"])
        });

        const payload = await runViaWorker(harness);

        expect(payload.error).toBeUndefined();
        expect(payload.results).toEqual([EXPECTED_DE_RESULT]);
        expect(harness.pageFetchUrls()).toEqual([
          SOURCE_ASIN_URL,
          TITLE_QUERY_URL,
          "https://www.amazon.de/dp/B000000005"
        ]);
        expect(progressPayloads(harness).map((progress) => progress.latest?.phase)).toEqual(["OPEN", "SEARCH", "MATCH", "READ", undefined]);
        expect(harness.openTempTabs()).toEqual([]);
      });

      it("searches a marketplace whose dead listing shows priced sponsored items, instead of quoting their price", async () => {
        const harness = await bootServiceWorker({
          enabledMarketplaces: ["US", "DE"],
          sourceAsinOn: ["DE"],
          prepare: onSourceAsinPage("US-currently-unavailable-sponsored.html", ["sponsored", "availability", "buybox"])
        });

        const payload = await runViaWorker(harness);

        expect(payload.results).toEqual([EXPECTED_DE_RESULT]);
        expect(progressPayloads(harness).map((progress) => progress.latest?.phase)).toEqual(["OPEN", "SEARCH", "MATCH", "READ", undefined]);
      });

      it("skips the dead listing's own card in the search results", async () => {
        const deadListingPage = onSourceAsinPage("DE-currently-unavailable.html", ["availability", "buybox"]);
        const harness = await bootServiceWorker({
          enabledMarketplaces: ["US", "DE"],
          sourceAsinOn: ["DE"],
          prepare: (group, market, document) => {
            deadListingPage(group, market, document);
            if (group === "search") {
              document.body.insertAdjacentHTML(
                "afterbegin",
                '<div class="s-result-item" data-component-type="s-search-result" data-asin="B000000001"><h2><a href="/dp/B000000001"><span>Acme Ultra Widget Model X100 2 Pack Blue</span></a></h2><div class="a-row a-size-base a-color-secondary"><span class="a-size-base-plus">Acme</span></div></div>'
              );
            }
          }
        });

        const payload = await runViaWorker(harness);

        expect(payload.results).toEqual([EXPECTED_DE_RESULT]);
        expect(harness.pageFetchUrls()).toEqual([
          SOURCE_ASIN_URL,
          TITLE_QUERY_URL,
          "https://www.amazon.de/dp/B000000005"
        ]);
      });

      it("quotes a page for the source ASIN that cannot be dispatched to the address in one page read, without searching", async () => {
        const harness = await bootServiceWorker({
          enabledMarketplaces: ["US", "DE"],
          sourceAsinOn: ["DE"],
          prepare: onSourceAsinPage("UK-other-colour.html", ["availability"])
        });

        const payload = await runViaWorker(harness);

        expect(payload.results).toEqual([
          {
            marketplace: "DE",
            status: "UNAVAILABLE",
            confidence: 0.82,
            productUrl: SOURCE_ASIN_URL,
            notes: [
              "Matched by ASIN",
              "Price not displayed for destination",
              "Amazon says: This item cannot be dispatched to your selected delivery location. Please choose a different delivery location.",
              "Shipping not displayed for destination",
              "Import fees not displayed for destination"
            ]
          }
        ]);
        expect(harness.pageFetchUrls()).toEqual([SOURCE_ASIN_URL]);
        expect(harness.tabsCreate).not.toHaveBeenCalled();
        expect(progressPayloads(harness).map((progress) => progress.latest?.phase)).toEqual(["OPEN", "READ", undefined]);
        expect(harness.openTempTabs()).toEqual([]);
      });
    });

    it("searches when the page for the source ASIN cannot be scripted", async () => {
      const harness = await bootServiceWorker({ ...TAB_PATH, enabledMarketplaces: ["US", "DE"], failScriptOn: "missing/DE" });

      const payload = await runViaWorker(harness);

      expect(payload.error).toBeUndefined();
      expect(payload.results).toEqual([EXPECTED_DE_RESULT]);
      expect(harness.openTempTabs()).toEqual([]);
    });

    it("searches when the page for the source ASIN is closed while it loads", async () => {
      const harness = await bootServiceWorker({
        ...TAB_PATH,
        enabledMarketplaces: ["US", "DE"],
        onTabCreated: (tab, self) => {
          if (tab.label === "missing/DE") {
            holdLoading(tab);
            setTimeout(() => void self.chrome.tabs.remove(tab.id), 0);
          }
        }
      });

      const payload = await runViaWorker(harness);

      expect(payload.error).toBeUndefined();
      expect(payload.results).toEqual([EXPECTED_DE_RESULT]);
      expect(harness.openTempTabs()).toEqual([]);
      expect(harness.tabListenerCount()).toBe(0);
    });

    it("stops without searching when Stop arrives while the page for the source ASIN loads", async () => {
      const harness = await bootServiceWorker({
        ...TAB_PATH,
        enabledMarketplaces: ["US", "DE", "UK"],
        sourceAsinOn: ["DE"],
        onTabCreated: (tab) => {
          if (tab.label === "product/DE") {
            holdLoading(tab);
          }
        }
      });

      const run = startRunViaWorker(harness, "run-1");
      await vi.waitFor(() => expect(harness.events).toContain("loading product/DE"));
      await expect(cancelViaWorker(harness)).resolves.toEqual({ ok: true, type: CANCEL_COMPARISON });
      await run;

      expect(resultPayloads(harness, "run-1")).toEqual([
        expect.objectContaining({ error: CANCELLED_ERROR, results: [], runId: "run-1" })
      ]);
      expect(harness.events.slice(harness.events.indexOf("progress OPEN DE"))).toEqual([
        "progress OPEN DE",
        "open product/DE",
        "loading product/DE",
        "close product/DE"
      ]);
      expect(harness.openTempTabs()).toEqual([]);
      expect(harness.tabListenerCount()).toBe(0);
    });

    it("stops without searching when Stop arrives while the page for the source ASIN downloads", async () => {
      const harness = await bootServiceWorker({
        enabledMarketplaces: ["US", "DE", "UK"],
        sourceAsinOn: ["DE"],
        holdFetchOn: ["product/DE"]
      });

      const run = startRunViaWorker(harness, "run-1");
      await vi.waitFor(() => expect(harness.events).toContain("fetch product/DE"));
      await expect(cancelViaWorker(harness)).resolves.toEqual({ ok: true, type: CANCEL_COMPARISON });
      await run;

      expect(resultPayloads(harness, "run-1")).toEqual([
        expect.objectContaining({ error: CANCELLED_ERROR, results: [], runId: "run-1" })
      ]);
      expect(marketEvents(harness, "DE")).toEqual(["progress OPEN DE", "fetch product/DE"]);
      expect(harness.events.slice(harness.events.indexOf("fetch product/DE"))).toEqual([
        "fetch product/DE",
        "offscreen cancel",
        "offscreen close"
      ]);
      expect(harness.tabsCreate).not.toHaveBeenCalled();
    });
  });

  describe("delivery address", () => {
    const switzerlandSource: HarnessOptions = { enabledMarketplaces: ["US", "DE"], locations: { US: "CH", DE: "DE" } };
    const SEARCH_URL =
      "https://www.amazon.de/s?k=Acme%20Ultra%20Widget%20Model%20X100%202%20Pack%20Blue%20Acme%202%20pack%2016%20oz%20blue";

    it("sets a market that delivers to an address in its own country to the source's destination, then compares it", async () => {
      const harness = await bootServiceWorker(switzerlandSource);

      const payload = await runViaWorker(harness);

      expect(payload.source?.destinationCountryCode).toBe("CH");
      expect(payload.results).toEqual([
        { ...EXPECTED_DE_RESULT, notes: ["Matched by search", "Match confidence: HIGH", "Delivery location set to Switzerland"] }
      ]);
      expect(marketEvents(harness, "DE")).toEqual([
        "progress OPEN DE",
        "fetch missing/DE",
        "progress SEARCH DE",
        "fetch search/DE",
        "fetch location form www.amazon.de",
        "fetch location change www.amazon.de CH",
        "fetch search/DE",
        "progress MATCH DE",
        "progress READ DE",
        "fetch product/DE"
      ]);
      expect(harness.pageFetchUrls()).toEqual([
        "https://www.amazon.de/dp/B000000001",
        SEARCH_URL,
        SEARCH_URL,
        "https://www.amazon.de/dp/B000000005"
      ]);
      expect(harness.tabsCreate).not.toHaveBeenCalled();
    });

    it("reports a market whose location could not be set and whose page still quotes its own country", async () => {
      const harness = await bootServiceWorker({ ...switzerlandSource, rejectLocationOn: ["DE"] });

      const payload = await runViaWorker(harness);

      expect(payload.results).toEqual([
        {
          marketplace: "DE",
          status: "DESTINATION_MISMATCH",
          confidence: 0.9,
          productUrl: "https://www.amazon.de/dp/B000000005",
          notes: [
            "Matched by search",
            "Match confidence: HIGH",
            NOT_ACCEPTED_NOTE,
            "Destination mismatch detected (DE)",
            "Destination on product page does not match source destination"
          ]
        }
      ]);
      expect(harness.events.filter((event) => event.includes("location change "))).toEqual([
        "fetch location change www.amazon.de CH",
        "location change www.amazon.de CH"
      ]);
      expect(fetchedOn(harness, "DE")).toEqual(["missing/DE", "search/DE", "product/DE"]);
      expect(openedOn(harness, "DE")).toEqual(["search/DE"]);
      expect(harness.events.filter((event) => event.startsWith("inject content/location-setter.js"))).toEqual([
        "inject content/location-setter.js search/DE"
      ]);
      expect(harness.openTempTabs()).toEqual([]);
    });

    it("compares a market whose page shows the same town and postcode as the source page", async () => {
      const harness = await bootServiceWorker({
        enabledMarketplaces: ["US", "DE"],
        prepare: (_group, _market, document) => {
          const line = document.querySelector("#glow-ingress-line2");
          if (line) {
            line.textContent = "Paris 75001";
          }
        }
      });

      const payload = await runViaWorker(harness);

      expect(payload.source?.deliverTo).toBe("Paris 75001");
      expect(payload.results).toEqual([EXPECTED_DE_RESULT]);
    });
  });

  describe("delivery location", () => {
    const SET_NOTE = "Delivery location set to Switzerland";

    function locationEvents(harness: Harness): string[] {
      return harness.events.filter(
        (event) =>
          event.startsWith("location ") ||
          event.startsWith("fetch location ") ||
          event.startsWith("inject content/location-setter.js")
      );
    }

    it("leaves a store that already delivers to the destination untouched", async () => {
      const harness = await bootServiceWorker({ enabledMarketplaces: ["US", "UK", "DE"], locations: { US: "CH", UK: "CH", DE: "CH" } });

      const payload = await runViaWorker(harness);

      expect(payload.source?.destinationCountryCode).toBe("CH");
      expect(payload.results.map((result) => [result.marketplace, result.status])).toEqual([
        ["UK", "OK"],
        ["DE", "OK"]
      ]);
      expect(payload.results.flatMap((result) => result.notes ?? []).filter((note) => note.startsWith("Delivery location"))).toEqual([]);
      expect(harness.events.filter((event) => event.includes("location "))).toEqual([]);
      expect(harness.tabsCreate).not.toHaveBeenCalled();
      expect(harness.fetch.mock.calls.map(([url]) => url as string).filter((url) => !harness.pageFetchUrls().includes(url))).toEqual([
        "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml"
      ]);
    });

    it("sets each store once per run, on the first of its pages that has the location widget, and reads that page again", async () => {
      const harness = await bootServiceWorker({
        enabledMarketplaces: ["US", "DE"],
        locations: { US: "CH" },
        redirectAsinOn: ["DE"],
        prepare: (group, _market, document) => {
          if (group === "product" && document.URL === "https://www.amazon.de/dp/B000000001") {
            removeLocationFields(document);
          }
        }
      });

      const payload = await runViaWorker(harness);

      expect(payload.results).toEqual([
        { ...EXPECTED_DE_RESULT, notes: ["Matched by search", "Match confidence: HIGH", SET_NOTE] }
      ]);
      expect(marketEvents(harness, "DE")).toEqual([
        "progress OPEN DE",
        "fetch product/DE",
        "progress SEARCH DE",
        "fetch search/DE",
        "fetch location form www.amazon.de",
        "fetch location change www.amazon.de CH",
        "fetch search/DE",
        "progress MATCH DE",
        "progress READ DE",
        "fetch product/DE"
      ]);
      expect(pageJobs(harness).map((job) => [job.location?.countryCode, job.expectDestination])).toEqual([
        ["CH", undefined],
        ["CH", undefined],
        [undefined, "CH"],
        [undefined, "CH"]
      ]);
      expect(harness.tabsCreate).not.toHaveBeenCalled();
    });

    it("sets the location from a tab when the store refuses the extension's request, then downloads the page again", async () => {
      const harness = await bootServiceWorker({ enabledMarketplaces: ["US", "DE"], locations: { US: "CH" }, rejectLocationFetchOn: ["DE"] });

      const payload = await runViaWorker(harness);

      expect(payload.results).toEqual([
        { ...EXPECTED_DE_RESULT, notes: ["Matched by search", "Match confidence: HIGH", SET_NOTE] }
      ]);
      expect(locationEvents(harness)).toEqual([
        "fetch location form www.amazon.de",
        "inject content/location-setter.js search/DE",
        "location form www.amazon.de",
        "location change www.amazon.de CH"
      ]);
      expect(fetchedOn(harness, "DE")).toEqual(["missing/DE", "search/DE", "search/DE", "product/DE"]);
      expect(openedOn(harness, "DE")).toEqual(["search/DE"]);
      expect(harness.openTempTabs()).toEqual([]);
    });

    it("keeps the refused location step on record when the tab that should redo it cannot be scripted, so later pages do not ask again", async () => {
      const harness = await bootServiceWorker({
        enabledMarketplaces: ["US", "DE"],
        locations: { US: "CH" },
        rejectLocationFetchOn: ["DE"],
        onTabCreated: (tab) => {
          if (tab.label === "search/DE") {
            tab.document = "no-access";
          }
        }
      });

      const payload = await runViaWorker(harness);

      expect(payload.error).toBeUndefined();
      expect(payload.results).toEqual([
        {
          marketplace: "DE",
          status: "DESTINATION_MISMATCH",
          confidence: 0.9,
          productUrl: "https://www.amazon.de/dp/B000000005",
          notes: [
            "Matched by search",
            "Match confidence: HIGH",
            "Delivery location not set: Amazon answered HTTP 403",
            "Destination mismatch detected (US)",
            "Destination on product page does not match source destination"
          ]
        }
      ]);
      expect(locationEvents(harness)).toEqual(["fetch location form www.amazon.de"]);
      expect(openedOn(harness, "DE")).toEqual(["search/DE"]);
      expect(harness.events).toContain("no access search/DE");
      expect(pageJobs(harness).map((job) => [job.url, job.location?.countryCode])).toEqual([
        ["https://www.amazon.de/dp/B000000001", "CH"],
        [expect.stringContaining("https://www.amazon.de/s?k="), "CH"],
        ["https://www.amazon.de/dp/B000000005", undefined]
      ]);
      expect(harness.openTempTabs()).toEqual([]);
    });

    it("reads a page in a tab when its download still shows another destination after the location was set", async () => {
      const harness = await bootServiceWorker({
        enabledMarketplaces: ["US", "DE"],
        locations: { US: "CH" },
        fetchKeepsLocationOn: ["search/DE"]
      });

      const payload = await runViaWorker(harness);

      expect(payload.results).toEqual([
        { ...EXPECTED_DE_RESULT, notes: ["Matched by search", "Match confidence: HIGH", SET_NOTE] }
      ]);
      expect(fetchedOn(harness, "DE")).toEqual(["missing/DE", "search/DE", "search/DE", "product/DE"]);
      expect(openedOn(harness, "DE")).toEqual(["search/DE"]);
      expect(harness.events).not.toContain("inject content/location-setter.js search/DE");
    });

    it("expects the set destination on every later page of the store and reads one that shows another in a tab", async () => {
      const harness = await bootServiceWorker({
        enabledMarketplaces: ["US", "DE"],
        locations: { US: "CH" },
        fetchKeepsLocationOn: ["product/DE"]
      });

      const payload = await runViaWorker(harness);

      expect(payload.results).toEqual([
        { ...EXPECTED_DE_RESULT, notes: ["Matched by search", "Match confidence: HIGH", SET_NOTE] }
      ]);
      expect(fetchedOn(harness, "DE")).toEqual(["missing/DE", "search/DE", "search/DE", "product/DE"]);
      expect(pageJobs(harness).at(-1)).toMatchObject({ url: "https://www.amazon.de/dp/B000000005", expectDestination: "CH" });
      expect(openedOn(harness, "DE")).toEqual(["product/DE"]);
      expect(harness.events).not.toContain("inject content/location-setter.js product/DE");
    });

    it("expects the destination a store already delivers to on its later pages and reads one that shows another in a tab", async () => {
      const harness = await bootServiceWorker({
        enabledMarketplaces: ["US", "DE"],
        locations: { US: "CH", DE: "CH" },
        fetchShowsLocationOn: { "product/DE": "FR" }
      });

      const payload = await runViaWorker(harness);

      expect(payload.results).toEqual([EXPECTED_DE_RESULT]);
      expect(fetchedOn(harness, "DE")).toEqual(["missing/DE", "search/DE", "product/DE"]);
      expect(pageJobs(harness).map((job) => [job.location?.countryCode, job.expectDestination])).toEqual([
        ["CH", undefined],
        ["CH", undefined],
        [undefined, "CH"]
      ]);
      expect(openedOn(harness, "DE")).toEqual(["product/DE"]);
      expect(locationEvents(harness)).toEqual([]);
    });

    it("does not post a destination the store does not offer", async () => {
      const harness = await bootServiceWorker({
        enabledMarketplaces: ["US", "AU"],
        locations: { US: "CH", AU: "NZ" },
        notOfferedOn: ["AU"]
      });

      const payload = await runViaWorker(harness);

      expect(locationEvents(harness)).toEqual(["fetch location form www.amazon.com.au"]);
      expect(payload.results).toHaveLength(1);
      expect(payload.results[0]).toMatchObject({ marketplace: "AU", status: "DESTINATION_MISMATCH" });
      expect(payload.results[0].notes).toEqual(
        expect.arrayContaining(["Delivery location not offered: CH", "Destination mismatch detected (NZ)"])
      );
    });

    it("does not try to set a store to its own country", async () => {
      const harness = await bootServiceWorker({ enabledMarketplaces: ["US", "DE"], locations: { US: "DE", DE: "US" } });

      const payload = await runViaWorker(harness);

      expect(locationEvents(harness)).toEqual([]);
      expect(payload.results[0]).toMatchObject({ marketplace: "DE", status: "DESTINATION_MISMATCH" });
      expect(payload.results[0].notes).toEqual([
        "Matched by search",
        "Match confidence: HIGH",
        "Delivery location not set: a postcode is needed for an address in the store's own country",
        "Destination mismatch detected (US)",
        "Destination on product page does not match source destination"
      ]);
    });

    it("treats a page whose destination cannot be read as unconfirmed after a failed change", async () => {
      const harness = await bootServiceWorker({
        enabledMarketplaces: ["US", "DE"],
        locations: { US: "CH" },
        rejectLocationOn: ["DE"],
        prepare: (group, _market, document) => {
          if (group === "product") {
            removeElement(document, "#countryCode");
            removeElement(document, "#glow-ingress-line2");
          }
        }
      });

      const payload = await runViaWorker(harness);

      expect(payload.results[0]).toMatchObject({ marketplace: "DE", status: "DESTINATION_MISMATCH" });
      expect(payload.results[0].notes).toEqual([
        "Matched by search",
        "Match confidence: HIGH",
        NOT_ACCEPTED_NOTE,
        "Destination on product page does not match source destination"
      ]);
      expect(openedOn(harness, "DE")).toEqual(["search/DE"]);
    });

    it("stops when the run is cancelled during a location change", async () => {
      const harness = await bootServiceWorker({
        enabledMarketplaces: ["US", "DE", "UK"],
        locations: { US: "CH" },
        holdLocation: deferred().promise
      });

      const run = startRunViaWorker(harness, "run-1");
      await vi.waitFor(() => expect(harness.events).toContain("fetch location form www.amazon.de"));
      await expect(cancelViaWorker(harness)).resolves.toEqual({ ok: true, type: CANCEL_COMPARISON });
      await run;

      expect(resultPayloads(harness, "run-1")).toEqual([
        expect.objectContaining({ error: CANCELLED_ERROR, results: [], runId: "run-1" })
      ]);
      expect(harness.events.slice(harness.events.indexOf("fetch location form www.amazon.de"))).toEqual([
        "fetch location form www.amazon.de",
        "offscreen cancel",
        "offscreen close"
      ]);
      expect(harness.tabsCreate).not.toHaveBeenCalled();
    });

    it("sends no address change when the location form answers after Stop", async () => {
      const form = deferred();
      const harness = await bootServiceWorker({
        enabledMarketplaces: ["US", "DE"],
        locations: { US: "CH" },
        holdLocation: form.promise
      });

      const run = startRunViaWorker(harness, "run-1");
      await vi.waitFor(() => expect(harness.events).toContain("fetch location form www.amazon.de"));
      await expect(cancelViaWorker(harness)).resolves.toEqual({ ok: true, type: CANCEL_COMPARISON });
      await run;
      form.resolve();
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(resultPayloads(harness, "run-1")).toEqual([
        expect.objectContaining({ error: CANCELLED_ERROR, results: [], runId: "run-1" })
      ]);
      expect(locationEvents(harness)).toEqual(["fetch location form www.amazon.de"]);
      expect(harness.locationOf("DE")).toBe("US");
    });

    it("stops when the run is cancelled during a location change in a tab", async () => {
      const harness = await bootServiceWorker({
        ...TAB_PATH,
        enabledMarketplaces: ["US", "DE", "UK"],
        locations: { US: "CH" },
        holdLocation: deferred().promise
      });

      const run = startRunViaWorker(harness, "run-1");
      await vi.waitFor(() => expect(harness.events).toContain("location form www.amazon.de"));
      await expect(cancelViaWorker(harness)).resolves.toEqual({ ok: true, type: CANCEL_COMPARISON });
      await run;

      expect(resultPayloads(harness, "run-1")).toEqual([
        expect.objectContaining({ error: CANCELLED_ERROR, results: [], runId: "run-1" })
      ]);
      expect(harness.events.slice(harness.events.indexOf("location form www.amazon.de"))).toEqual([
        "location form www.amazon.de",
        "close missing/DE"
      ]);
      expect(harness.openTempTabs()).toEqual([]);
      expect(harness.tabListenerCount()).toBe(0);
    });

    it("times out a location change that never answers, tries it once in a tab and reads the page as it is", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const harness = await bootServiceWorker({
          enabledMarketplaces: ["US", "DE"],
          locations: { US: "CH" },
          holdLocation: deferred().promise
        });

        const run = runViaWorker(harness);
        await vi.waitFor(() => expect(harness.events).toContain("fetch location form www.amazon.de"));
        await vi.advanceTimersByTimeAsync(10_000);
        await vi.waitFor(() => expect(harness.events).toContain("location form www.amazon.de"));
        await vi.advanceTimersByTimeAsync(20_000);
        const payload = await run;

        expect(payload.error).toBeUndefined();
        expect(payload.results).toEqual([
          {
            marketplace: "DE",
            status: "DESTINATION_MISMATCH",
            confidence: 0.9,
            productUrl: "https://www.amazon.de/dp/B000000005",
            notes: [
              "Matched by search",
              "Match confidence: HIGH",
              "Delivery location not set: timed out after 20 seconds",
              "Destination mismatch detected (US)",
              "Destination on product page does not match source destination"
            ]
          }
        ]);
        expect(locationEvents(harness)).toEqual([
          "fetch location form www.amazon.de",
          "inject content/location-setter.js search/DE",
          "location form www.amazon.de"
        ]);
        expect(openedOn(harness, "DE")).toEqual(["search/DE"]);
        expect(harness.openTempTabs()).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("times out a location change in a tab that never answers and reads the page as it is", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const harness = await bootServiceWorker({
          ...TAB_PATH,
          enabledMarketplaces: ["US", "DE"],
          locations: { US: "CH" },
          holdLocation: deferred().promise
        });

        const run = runViaWorker(harness);
        await vi.waitFor(() => expect(harness.events).toContain("location form www.amazon.de"));
        await vi.advanceTimersByTimeAsync(20_000);
        const payload = await run;

        expect(payload.error).toBeUndefined();
        expect(payload.results).toEqual([
          {
            marketplace: "DE",
            status: "DESTINATION_MISMATCH",
            confidence: 0.9,
            productUrl: "https://www.amazon.de/dp/B000000005",
            notes: [
              "Matched by search",
              "Match confidence: HIGH",
              "Delivery location not set: timed out after 20 seconds",
              "Destination mismatch detected (US)",
              "Destination on product page does not match source destination"
            ]
          }
        ]);
        expect(locationEvents(harness)).toEqual(["inject content/location-setter.js missing/DE", "location form www.amazon.de"]);
        expect(harness.openTempTabs()).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("never changes the source store", async () => {
      const harness = await bootServiceWorker({ enabledMarketplaces: ["US", "UK", "DE"], locations: { US: "CH" } });

      await runViaWorker(harness);

      expect(harness.events.filter((event) => event.includes("location change "))).toEqual([
        "fetch location change www.amazon.co.uk CH",
        "fetch location change www.amazon.de CH"
      ]);
      expect(harness.events.filter((event) => event.split(" ").some((word) => word === "www.amazon.com"))).toEqual([]);
      expect(harness.events.filter((event) => event.includes("source/US"))).toEqual([
        "inject content/source-extractor.js source/US",
        "inject content/product-extractor.js source/US"
      ]);
    });

    it("LOAD_SOURCE reads the source destination from the page fields without setting anything", async () => {
      const harness = await bootServiceWorker({ enabledMarketplaces: ["US", "DE"], locations: { US: "CH" } });

      const response = await loadSourceViaWorker(harness);

      expect(response.source).toEqual({ ...EXPECTED_SOURCE, destinationCountryCode: "CH", deliverTo: "Deliver to Switzerland" });
      expect(response.baseline).toEqual(RAW_BASELINE);
      expect(locationEvents(harness)).toEqual([]);
      expect(harness.fetch).not.toHaveBeenCalled();
    });
  });

  describe("pages that quote no import fees", () => {
    it("quotes item and shipping when the page shows delivery but no import fees", async () => {
      const harness = await bootServiceWorker({
        enabledMarketplaces: ["US", "DE"],
        prepare: (group, market, document) => {
          if (group === "product" && market === "DE") {
            removeElement(document, "#exports_desktop_feature_div");
          }
        }
      });

      const payload = await runViaWorker(harness);

      expect(payload.results).toEqual([
        {
          ...EXPECTED_DE_RESULT,
          confidence: 0.88,
          breakdown: {
            item: { amount: 37.2, currency: "EUR" },
            shipping: { amount: 4.5, currency: "EUR" },
            totalDisplayed: { amount: 37.2, currency: "EUR" }
          },
          notes: ["Matched by search", "Match confidence: HIGH", "Import fees not displayed for destination"],
          normalizedTotal: { amount: 45.04, currency: "USD" }
        }
      ]);
    });

    it("quotes the live amazon.de page of a cable that ships to an address in Switzerland", async () => {
      const liveHtml = readFileSync(join(FIXTURE_ROOT, "product-live", "DE-ships-to-switzerland.html"), "utf8");
      const harness = await bootServiceWorker({
        enabledMarketplaces: ["US", "DE"],
        prepare: (group, market, document) => {
          if (group === "product" && market === "DE") {
            for (const selector of [
              "#glow-ingress-line2",
              "#corePriceDisplay_desktop_feature_div",
              "#deliveryBlockMessage",
              "#exports_desktop_feature_div",
              "#subtotals-marketplace-table"
            ]) {
              removeElement(document, selector);
            }
            document.body.insertAdjacentHTML("beforeend", new JSDOM(liveHtml).window.document.body.innerHTML);
          }
        }
      });

      const payload = await runViaWorker(harness);

      expect(payload.results).toEqual([
        {
          marketplace: "DE",
          status: "OK",
          confidence: 0.88,
          productUrl: "https://www.amazon.de/dp/B000000005",
          breakdown: { item: { amount: 78.27, currency: "CHF" }, shipping: { amount: 41.36, currency: "CHF" } },
          notes: ["Matched by search", "Match confidence: HIGH", "Import fees not displayed for destination"],
          normalizedTotal: { amount: 137.45, currency: "USD" }
        }
      ]);
    });

    it("still reports a page that quotes no shipping as not quotable", async () => {
      const harness = await bootServiceWorker({
        enabledMarketplaces: ["US", "DE"],
        prepare: (group, market, document) => {
          if (group === "product" && market === "DE") {
            removeElement(document, "#deliveryBlockMessage");
            removeElement(document, "#exports_desktop_feature_div");
          }
        }
      });

      const payload = await runViaWorker(harness);

      expect(payload.results).toMatchObject([
        {
          marketplace: "DE",
          status: "UNAVAILABLE",
          notes: [
            "Matched by search",
            "Match confidence: HIGH",
            "Shipping not displayed for destination",
            "Import fees not displayed for destination"
          ]
        }
      ]);
      expect(payload.results[0]).not.toHaveProperty("normalizedTotal");
    });
  });

  describe("other sellers' offers", () => {
    const DE_SOURCE_ASIN_URL = "https://www.amazon.de/dp/B000000001";
    const STAR_BRICK_CITY = {
      seller: "Star Brick City",
      dispatcher: "Amazon",
      fulfilledByAmazon: true,
      offerCount: 4,
      readCount: 4,
      readComplete: true,
      deliveringNewCount: 4,
      unreadableCount: 0,
      comparedCount: 4
    };

    function onlyOtherSellersOn(market: Marketplace): Prepare {
      return (group, pageMarket, document) => {
        if (group === "product" && pageMarket === market) {
          offerOnlyOtherSellers(document);
        }
      };
    }

    it("quotes the first new offer that delivers on a store whose page shows no price, with its seller", async () => {
      const harness = await bootServiceWorker({
        enabledMarketplaces: ["US", "DE"],
        sourceAsinOn: ["DE"],
        locations: { US: "CH", DE: "CH" },
        offersOn: { DE: "DE-four-new-offers.html" },
        prepare: onlyOtherSellersOn("DE")
      });

      const payload = await runViaWorker(harness);

      expect(payload.error).toBeUndefined();
      expect(payload.results).toEqual([
        {
          marketplace: "DE",
          status: "OK",
          confidence: 0.96,
          productUrl: DE_SOURCE_ASIN_URL,
          breakdown: { item: { amount: 651.25, currency: "EUR" }, shipping: { amount: 55.26, currency: "EUR" } },
          otherSeller: STAR_BRICK_CITY,
          notes: ["Matched by ASIN", "Quoted another seller's offer", "Import fees not displayed for destination"],
          normalizedTotal: { amount: 763.03, currency: "USD" }
        }
      ]);
      expect(harness.fetch).toHaveBeenCalledWith(
        offersUrl("https://www.amazon.de", "B000000001"),
        expect.objectContaining({ credentials: "include" })
      );
      expect(harness.events.filter((event) => event.includes("offers "))).toEqual(["fetch offers www.amazon.de"]);
      expect(harness.tabsCreate).not.toHaveBeenCalled();
    });

    it.each([
      ["answers the extension's first request with HTTP 403", { offersStatusOn: { DE: 403 } }],
      ["answers the extension's first request with a robot check", { captchaOn: ["offers/DE"] }]
    ] as Array<[string, HarnessOptions]>)(
      "reads the offers from the product page in a tab when the store %s, without setting its location again",
      async (_case, refusal) => {
        const harness = await bootServiceWorker({
          enabledMarketplaces: ["US", "DE"],
          sourceAsinOn: ["DE"],
          locations: { US: "CH", DE: "CH" },
          offersOn: { DE: "DE-four-new-offers.html" },
          prepare: onlyOtherSellersOn("DE"),
          ...refusal
        });

        const payload = await runViaWorker(harness);

        expect(payload.error).toBeUndefined();
        expect(payload.results).toMatchObject([
          { marketplace: "DE", status: "OK", otherSeller: STAR_BRICK_CITY, normalizedTotal: { amount: 763.03, currency: "USD" } }
        ]);
        expect(harness.events.filter((event) => event.includes("offers "))).toEqual(["fetch offers www.amazon.de", "offers www.amazon.de"]);
        expect(openedOn(harness, "DE")).toEqual(["product/DE"]);
        expect(harness.events).not.toContain("inject content/location-setter.js product/DE");
        expect(harness.openTempTabs()).toEqual([]);
      }
    );

    it("quotes the amazon.co.uk offer that is cheapest delivered in the comparison currency, not Amazon's first", async () => {
      const harness = await bootServiceWorker({
        enabledMarketplaces: ["US", "UK"],
        sourceAsinOn: ["UK"],
        locations: { US: "CH", UK: "CH" },
        offersOn: { UK: "UK-item-in-pounds-delivery-in-francs.html" },
        prepare: onlyOtherSellersOn("UK")
      });

      const payload = await runViaWorker(harness);

      expect(payload.results).toEqual([
        {
          marketplace: "UK",
          status: "OK",
          confidence: 0.96,
          productUrl: "https://www.amazon.co.uk/dp/B000000001",
          breakdown: { item: { amount: 699, currency: "GBP" }, shipping: { amount: 40.86, currency: "CHF" } },
          otherSeller: {
            seller: "RamanDz",
            dispatcher: "RamanDz",
            fulfilledByAmazon: false,
            offerCount: 2,
            readCount: 2,
            readComplete: true,
            deliveringNewCount: 2,
            unreadableCount: 0,
            comparedCount: 2
          },
          notes: ["Matched by ASIN", "Quoted another seller's offer", "Import fees not displayed for destination"],
          normalizedTotal: { amount: 933.01, currency: "USD" }
        }
      ]);
    });

    it("reports a store whose other offers cannot ship there as unavailable, saying no other seller delivers", async () => {
      const harness = await bootServiceWorker({
        enabledMarketplaces: ["US", "MX"],
        sourceAsinOn: ["MX"],
        offersOn: { MX: "MX-one-offer-not-shippable.html" },
        prepare: onlyOtherSellersOn("MX")
      });

      const payload = await runViaWorker(harness);

      expect(payload.results).toEqual([
        {
          marketplace: "MX",
          status: "UNAVAILABLE",
          confidence: 0.82,
          productUrl: "https://www.amazon.com.mx/dp/B000000001",
          notes: [
            "Matched by ASIN",
            "Price not displayed for destination",
            "Shipping not displayed for destination",
            "Import fees not displayed for destination",
            "No other seller delivers the item new to the destination"
          ]
        }
      ]);
      expect(harness.events).not.toContain("open search/MX");
    });

    it("reports a store as unavailable with the reason when its other offers cannot be read", async () => {
      const harness = await bootServiceWorker({
        enabledMarketplaces: ["US", "DE"],
        sourceAsinOn: ["DE"],
        prepare: onlyOtherSellersOn("DE")
      });

      const payload = await runViaWorker(harness);

      expect(payload.results).toMatchObject([
        {
          marketplace: "DE",
          status: "UNAVAILABLE",
          notes: [
            "Matched by ASIN",
            "Price not displayed for destination",
            "Shipping not displayed for destination",
            "Import fees not displayed for destination",
            "Other offers could not be read: Amazon answered HTTP 404"
          ]
        }
      ]);
      expect(payload.results[0]).not.toHaveProperty("otherSeller");
      expect(harness.events.filter((event) => event.includes("offers "))).toEqual(["fetch offers www.amazon.de", "offers www.amazon.de"]);
      expect(openedOn(harness, "DE")).toEqual(["product/DE"]);
    });

    it("sets the location in the offers tab when the extension's location request on that page was refused too", async () => {
      const harness = await bootServiceWorker({
        enabledMarketplaces: ["US", "DE"],
        sourceAsinOn: ["DE"],
        locations: { US: "CH" },
        rejectLocationFetchOn: ["DE"],
        offersStatusOn: { DE: 403 },
        offersOn: { DE: "DE-four-new-offers.html" },
        prepare: (group, market, document) => {
          if (group === "product" && market === "DE") {
            offerOnlyOtherSellers(document);
            removeElement(document, "#countryCode");
            removeElement(document, "#glow-ingress-line2");
          }
        }
      });

      const payload = await runViaWorker(harness);

      expect(payload.error).toBeUndefined();
      expect(payload.results).toMatchObject([
        {
          marketplace: "DE",
          status: "OK",
          otherSeller: STAR_BRICK_CITY,
          notes: ["Matched by ASIN", "Delivery location set to Switzerland", "Quoted another seller's offer", "Import fees not displayed for destination"]
        }
      ]);
      expect(harness.events.filter((event) => event.includes("location ") || event.includes("offers "))).toEqual([
        "fetch location form www.amazon.de",
        "fetch offers www.amazon.de",
        "location form www.amazon.de",
        "location change www.amazon.de CH",
        "offers www.amazon.de"
      ]);
      expect(openedOn(harness, "DE")).toEqual(["product/DE", "product/DE"]);
      expect(harness.openTempTabs()).toEqual([]);
    });

    it("keeps the refused location step on record when the tab that should redo it fails, so later pages do not ask again", async () => {
      const harness = await bootServiceWorker({
        enabledMarketplaces: ["US", "DE"],
        sourceAsinOn: ["DE"],
        locations: { US: "CH" },
        rejectLocationFetchOn: ["DE"],
        offersStatusOn: { DE: 403 },
        offersOn: { DE: "DE-four-new-offers.html" },
        failScriptOn: "product/DE",
        prepare: (group, market, document) => {
          if (group === "product" && market === "DE") {
            offerOnlyOtherSellers(document);
            removeElement(document, "#countryCode");
            removeElement(document, "#glow-ingress-line2");
          }
        }
      });

      const payload = await runViaWorker(harness);

      expect(payload.error).toBeUndefined();
      expect(payload.results).toMatchObject([{ marketplace: "DE", status: "DESTINATION_MISMATCH" }]);
      expect(payload.results[0].notes).toContain("Delivery location not set: Amazon answered HTTP 403");
      expect(openedOn(harness, "DE")).toEqual(["product/DE"]);
      expect(pageJobs(harness).map((job) => [job.url, job.location?.countryCode])).toEqual([
        ["https://www.amazon.de/dp/B000000001", "CH"],
        [expect.stringContaining("https://www.amazon.de/s?k="), undefined],
        ["https://www.amazon.de/dp/B000000005", undefined]
      ]);
      expect(harness.events.filter((event) => event.includes("location "))).toEqual(["fetch location form www.amazon.de"]);
    });

    it("times out an offers request that never answers after 15 seconds and reports the store unavailable", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const harness = await bootServiceWorker({
          enabledMarketplaces: ["US", "DE"],
          holdOffers: deferred().promise,
          prepare: onlyOtherSellersOn("DE")
        });

        const run = runViaWorker(harness);
        await vi.waitFor(() => expect(harness.events).toContain("fetch offers www.amazon.de"));
        await vi.advanceTimersByTimeAsync(15_000);
        const payload = await run;

        expect(payload.error).toBeUndefined();
        expect(payload.results).toMatchObject([{ marketplace: "DE", status: "UNAVAILABLE" }]);
        expect(payload.results[0].notes).toContain("Other offers could not be read: timed out after 15 seconds");
        expect(harness.tabsCreate).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("times out a product read that never answers, as it does the location step, and closes the tab", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const harness = await bootServiceWorker({
          ...TAB_PATH,
          enabledMarketplaces: ["US", "DE"],
          holdOffers: deferred().promise,
          prepare: onlyOtherSellersOn("DE")
        });

        const run = runViaWorker(harness);
        await vi.waitFor(() => expect(harness.events).toContain("offers www.amazon.de"));
        await vi.advanceTimersByTimeAsync(20_000);
        expect(harness.openTempTabs()).toEqual(["product/DE"]);
        await vi.advanceTimersByTimeAsync(5_000);
        const payload = await run;

        expect(payload.error).toBeUndefined();
        expect(payload.results).toEqual([
          {
            marketplace: "DE",
            status: "PARSE_FAILED",
            confidence: 0,
            notes: ["Timed out reading the product page after 25 seconds"]
          }
        ]);
        expect(harness.openTempTabs()).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("keeps the offer list out of the baseline of a run that cannot load exchange rates", async () => {
      const harness = await bootServiceWorker({
        enabledMarketplaces: ["DE", "US"],
        activeUrl: "https://www.amazon.de/dp/B000000005",
        offersOn: { DE: "DE-four-new-offers.html" },
        fxAvailable: false,
        prepare: (group, _market, document) => {
          if (group === "source") {
            offerOnlyOtherSellers(document);
          }
        }
      });

      const payload = await runViaWorker(harness);

      expect(payload.error).toBe("Unable to load FX reference rates from ECB or Frankfurter");
      expect(payload.baseline).toEqual({
        marketplace: "DE",
        status: "OK",
        confidence: 1,
        productUrl: "https://www.amazon.de/dp/B000000005",
        breakdown: { item: { amount: 651.25, currency: "EUR" }, shipping: { amount: 55.26, currency: "EUR" } },
        otherSeller: {
          seller: "Star Brick City",
          dispatcher: "Amazon",
          fulfilledByAmazon: true,
          offerCount: 4,
          readCount: 4,
          readComplete: true,
          deliveringNewCount: 4,
          unreadableCount: 0
        },
        notes: ["Quoted another seller's offer", "Import fees not displayed for destination"]
      });
      expect(payload.baseline).not.toHaveProperty("otherOffers");
    });

    it("reads the page you are on without its other offers when the popup opens, and quotes them for the run's baseline", async () => {
      const harness = await bootServiceWorker({
        enabledMarketplaces: ["DE", "US"],
        activeUrl: "https://www.amazon.de/dp/B000000005",
        offersOn: { DE: "DE-four-new-offers.html" },
        prepare: (group, _market, document) => {
          if (group === "source") {
            offerOnlyOtherSellers(document);
          }
        }
      });

      const response = await loadSourceViaWorker(harness);

      expect(response.source).toMatchObject({ marketplace: "DE", asin: "B000000005" });
      expect(response.baseline).toBeUndefined();
      expect(harness.fetch).not.toHaveBeenCalled();

      const payload = await runViaWorker(harness);

      expect(payload.baseline).toEqual({
        marketplace: "DE",
        status: "OK",
        confidence: 1,
        productUrl: "https://www.amazon.de/dp/B000000005",
        breakdown: { item: { amount: 651.25, currency: "EUR" }, shipping: { amount: 55.26, currency: "EUR" } },
        otherSeller: STAR_BRICK_CITY,
        notes: ["Quoted another seller's offer", "Import fees not displayed for destination"],
        normalizedTotal: { amount: 706.51, currency: "EUR" }
      });
      expect(harness.fetch).toHaveBeenCalledWith(
        offersUrl("https://www.amazon.de", "B000000005"),
        expect.objectContaining({ credentials: "same-origin" })
      );
    });
  });

  describe("variant check", () => {
    const BLUE_VARIANT_ASIN = "B0000000B5";
    const RED_LISTING_URL = "https://www.amazon.de/dp/B000000005";

    function colourPages(colourAt: (url: string) => string | undefined, options: Array<[string, string]>): Prepare {
      return (group, market, document) => {
        const colour = colourAt(document.URL);
        if (group === "product" && market === "DE" && colour) {
          addColourTwister(document, colour, options);
        }
      };
    }

    it("switches a search match shown in another colour to the source colour from its twister", async () => {
      const harness = await bootServiceWorker({
        enabledMarketplaces: ["US", "DE"],
        variantAsinsOn: { DE: [BLUE_VARIANT_ASIN] },
        prepare: colourPages((url) => (url === RED_LISTING_URL ? "Red" : "Blue"), [
          ["B000000005", "Red"],
          [BLUE_VARIANT_ASIN, "Blue"]
        ])
      });

      const payload = await runViaWorker(harness);

      expect(payload.results).toEqual([
        {
          ...EXPECTED_DE_RESULT,
          productUrl: `https://www.amazon.de/dp/${BLUE_VARIANT_ASIN}`,
          notes: ["Matched by search", "Match confidence: HIGH", "Switched to the Blue variant"]
        }
      ]);
      expect(harness.pageFetchUrls().slice(-2)).toEqual([RED_LISTING_URL, `https://www.amazon.de/dp/${BLUE_VARIANT_ASIN}`]);
      expect(harness.tabsCreate).not.toHaveBeenCalled();
    });

    it("reports no confident match when the listing's twister does not offer the source colour", async () => {
      const harness = await bootServiceWorker({
        enabledMarketplaces: ["US", "DE"],
        prepare: colourPages(() => "Red", [
          ["B000000005", "Red"],
          ["B0000000S5", "Silver"]
        ])
      });

      const payload = await runViaWorker(harness);

      expect(payload.results).toEqual([
        {
          marketplace: "DE",
          status: "NO_CONFIDENT_MATCH",
          confidence: 0,
          notes: ["Matched by search", "Closest listing is another variant: Red"]
        }
      ]);
      expect(fetchedOn(harness, "DE")).toEqual(["missing/DE", "search/DE", "product/DE"]);
      expect(harness.tabsCreate).not.toHaveBeenCalled();
    });

    it("reports no confident match, as a tab would, when the page for the source colour answers HTTP 404", async () => {
      const variantOptions: HarnessOptions = {
        enabledMarketplaces: ["US", "DE"],
        prepare: colourPages((url) => (url === RED_LISTING_URL ? "Red" : "Blue"), [
          ["B000000005", "Red"],
          [BLUE_VARIANT_ASIN, "Blue"]
        ])
      };
      const inTabs = await runViaWorker(await bootServiceWorker({ ...TAB_PATH, ...variantOptions }));
      const harness = await bootServiceWorker(variantOptions);

      const payload = await runViaWorker(harness);

      expect(payload.results).toEqual([
        {
          marketplace: "DE",
          status: "NO_CONFIDENT_MATCH",
          confidence: 0,
          notes: ["Matched by search", "Closest listing is another variant: Red"]
        }
      ]);
      expect(payload.results).toEqual(inTabs.results);
      expect(harness.pageFetches.at(-1)).toEqual({
        label: "missing/DE",
        url: `https://www.amazon.de/dp/${BLUE_VARIANT_ASIN}`,
        status: 404
      });
      expect(harness.tabsCreate).not.toHaveBeenCalled();
    });

    it("reports no confident match when the page for the source colour shows another colour too", async () => {
      const harness = await bootServiceWorker({
        enabledMarketplaces: ["US", "DE"],
        variantAsinsOn: { DE: [BLUE_VARIANT_ASIN] },
        prepare: colourPages(() => "Red", [
          ["B000000005", "Red"],
          [BLUE_VARIANT_ASIN, "Blue"]
        ])
      });

      const payload = await runViaWorker(harness);

      expect(payload.results).toMatchObject([{ marketplace: "DE", status: "NO_CONFIDENT_MATCH" }]);
      expect(harness.openTempTabs()).toEqual([]);
    });

    describe("when the page for the source colour cannot be read", () => {
      const BLUE_VARIANT_URL = `https://www.amazon.de/dp/${BLUE_VARIANT_ASIN}`;
      const switchingOptions: HarnessOptions = {
        ...TAB_PATH,
        enabledMarketplaces: ["US", "DE"],
        variantAsinsOn: { DE: [BLUE_VARIANT_ASIN] },
        prepare: colourPages((url) => (url === RED_LISTING_URL ? "Red" : "Blue"), [
          ["B000000005", "Red"],
          [BLUE_VARIANT_ASIN, "Blue"]
        ])
      };

      function keptRedListing(reason: string): ComparisonResult {
        return {
          ...EXPECTED_DE_RESULT,
          notes: [
            "Matched by search",
            "Match confidence: HIGH",
            `Could not read the Blue variant: ${reason}`,
            "Quoted listing is another variant: Red"
          ]
        };
      }

      it("keeps the search match with a note when the page cannot be scripted", async () => {
        const harness = await bootServiceWorker({ ...switchingOptions, failScriptOn: BLUE_VARIANT_URL });

        const payload = await runViaWorker(harness);

        expect(payload.error).toBeUndefined();
        expect(payload.results).toEqual([keptRedListing("Frame with ID 0 was removed.")]);
        expect(harness.tabsCreate.mock.calls.map(([options]) => (options as { url: string }).url).slice(-2)).toEqual([
          RED_LISTING_URL,
          BLUE_VARIANT_URL
        ]);
        expect(harness.openTempTabs()).toEqual([]);
      });

      it("keeps the search match with a note when the page does not load within 20 seconds", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        try {
          let stalledTabId: number | undefined;
          const harness = await bootServiceWorker({
            ...switchingOptions,
            onTabCreated: (tab) => {
              if (tab.url === BLUE_VARIANT_URL) {
                stalledTabId = tab.id;
                holdLoading(tab);
              }
            }
          });

          const run = runViaWorker(harness);
          await vi.waitFor(() => expect(harness.events).toContain("loading product/DE"));
          await vi.advanceTimersByTimeAsync(20_000);
          const payload = await run;

          expect(payload.error).toBeUndefined();
          expect(payload.results).toEqual([keptRedListing(`Timed out waiting for tab ${stalledTabId} to load`)]);
          expect(harness.openTempTabs()).toEqual([]);
          expect(harness.tabListenerCount()).toBe(0);
        } finally {
          vi.useRealTimers();
        }
      });

      it("stops without keeping the search match when Stop arrives while the page loads", async () => {
        const harness = await bootServiceWorker({
          ...switchingOptions,
          onTabCreated: (tab) => {
            if (tab.url === BLUE_VARIANT_URL) {
              holdLoading(tab);
            }
          }
        });

        const run = startRunViaWorker(harness, "run-1");
        await vi.waitFor(() => expect(harness.events).toContain("loading product/DE"));
        await expect(cancelViaWorker(harness)).resolves.toEqual({ ok: true, type: CANCEL_COMPARISON });
        await run;

        expect(resultPayloads(harness, "run-1")).toEqual([
          expect.objectContaining({ error: CANCELLED_ERROR, results: [], runId: "run-1" })
        ]);
        expect(harness.openTempTabs()).toEqual([]);
        expect(harness.tabListenerCount()).toBe(0);
      });
    });

    it("keeps a search match whose page shows the source colour among others", async () => {
      const harness = await bootServiceWorker({
        enabledMarketplaces: ["US", "DE"],
        prepare: colourPages(() => "Blue/White", [["B000000005", "Blue/White"]])
      });

      const payload = await runViaWorker(harness);

      expect(payload.results).toEqual([EXPECTED_DE_RESULT]);
    });
  });

  describe("cache", () => {
    it("answers a repeat run from the cache with the baseline and FX table, fetches no page and opens no tabs", async () => {
      const harness = await bootServiceWorker({ enabledMarketplaces: ["US", "UK", "DE"] });
      const first = await runViaWorker(harness);

      harness.tabsCreate.mockClear();
      harness.executeScript.mockClear();
      harness.fetch.mockClear();
      const progressBefore = progressPayloads(harness).length;

      const second = await runViaWorker(harness, "run-2");

      expect(second).toEqual({ ...first, runId: "run-2" });
      expect(second.activeTabId).toBe(ACTIVE_TAB_ID);
      expect(second.baseline).toEqual(EXPECTED_BASELINE);
      expect(second.fxTable).toEqual(EXPECTED_FX_TABLE);
      expect(harness.tabsCreate).not.toHaveBeenCalled();
      expect(harness.fetch).not.toHaveBeenCalled();
      expect(harness.executeScript.mock.calls.flatMap(([injection]) => (injection as Injection).files ?? [])).toEqual([
        "content/source-extractor.js"
      ]);
      expect(progressPayloads(harness)).toHaveLength(progressBefore);
      expect(countOf(harness, "offscreen create")).toBe(1);
    });

    it.each([
      ["the unversioned key of the first builds", undefined],
      ["the key of version 2, before variant checks and import-free quotes", 2],
      ["the key of version 3, before model-number matching and the delivery address", 3],
      ["the key of version 4, before dead listings fell back to a search", 4],
      ["the key of version 5, before target stores were set to the destination", 5],
      ["the key of version 6, before other sellers' offers were read", 6],
      ["the key of version 7, before robot checks were recognised", 7]
    ])("ignores a comparison cached under %s", async (_key, version) => {
      const harness = await bootServiceWorker({ enabledMarketplaces: ["US", "DE"] });
      const staleKey = earlierCacheKeyFor(["DE"], version);
      harness.storage[staleKey] = {
        createdAt: new Date().toISOString(),
        source: EXPECTED_SOURCE,
        results: [
          { marketplace: "DE", status: "NO_CONFIDENT_MATCH", confidence: 0, notes: ["No candidate passed conservative confidence threshold"] }
        ]
      };

      const payload = await runViaWorker(harness);

      expect(staleKey).not.toBe(cacheKeyFor(["DE"]));
      expect(payload.results).toEqual([EXPECTED_DE_RESULT]);
      expect(harness.pageFetchUrls()).not.toEqual([]);
      expect(harness.storage[cacheKeyFor(["DE"])]).toMatchObject({ results: [EXPECTED_DE_RESULT] });
    });

    it("ignores a comparison cached for another delivery address with the same destination country", async () => {
      const harness = await bootServiceWorker({ enabledMarketplaces: ["US", "DE"] });
      const otherAddress = cacheKeyFor(["DE"], "Deliver to Switzerland");
      harness.storage[otherAddress] = {
        createdAt: new Date().toISOString(),
        source: { ...EXPECTED_SOURCE, deliverTo: "Deliver to Switzerland" },
        results: [{ marketplace: "DE", status: "UNAVAILABLE", confidence: 0.82, notes: ["Price not displayed for destination"] }]
      };

      const payload = await runViaWorker(harness);

      expect(otherAddress).not.toBe(cacheKeyFor(["DE"]));
      expect(payload.results).toEqual([EXPECTED_DE_RESULT]);
      expect(harness.pageFetchUrls()).not.toEqual([]);
    });

    it("tolerates cache records written before baseline and FX were stored", async () => {
      const legacyResult: ComparisonResult = {
        marketplace: "UK",
        status: "OK",
        confidence: 0.9,
        productUrl: "https://www.amazon.co.uk/dp/B000000004",
        normalizedTotal: { amount: 41.2, currency: "USD" }
      };
      const harness = await bootServiceWorker({ enabledMarketplaces: ["US", "UK", "DE"] });
      harness.storage[cacheKeyFor(["UK", "DE"])] = {
        createdAt: new Date().toISOString(),
        source: EXPECTED_SOURCE,
        results: [legacyResult]
      };

      const payload = await runViaWorker(harness);

      expect(payload.error).toBeUndefined();
      expect(payload.results).toEqual([legacyResult]);
      expect(payload.baseline).toBeUndefined();
      expect(payload.fxTable).toBeUndefined();
      expect(harness.tabsCreate).not.toHaveBeenCalled();
      expect(harness.pageFetchUrls()).toEqual([]);
    });
  });

  describe("cancellation", () => {
    it("stops mid-run, closes a tab opened after Stop at once and returns partial results with source, baseline and FX", async () => {
      let cancelResponse: unknown;
      const harness = await bootServiceWorker({
        ...TAB_PATH,
        enabledMarketplaces: ["US", "DE", "UK"],
        onTabCreated: (tab, self) => {
          if (tab.label === "search/UK") {
            void self
              .dispatch({ type: CANCEL_COMPARISON, payload: { activeTabId: ACTIVE_TAB_ID } })
              .then((response) => {
                cancelResponse = response;
              });
          }
        }
      });

      const payload = await runViaWorker(harness);

      expect(cancelResponse).toEqual({ ok: true, type: CANCEL_COMPARISON });
      expect(payload.error).toBe(CANCELLED_ERROR);
      expect(payload.activeTabId).toBe(ACTIVE_TAB_ID);
      expect(payload.runId).toBe("run-1");
      expect(payload.results).toEqual([EXPECTED_DE_RESULT]);
      expect(payload.source).toEqual(EXPECTED_SOURCE);
      expect(payload.baseline).toEqual(EXPECTED_BASELINE);
      expect(payload.fxTable).toEqual(EXPECTED_FX_TABLE);

      expect(harness.events.slice(harness.events.indexOf("open search/UK"))).toEqual(["open search/UK", "close search/UK"]);
      expect(harness.openTempTabs()).toEqual([]);
      expect(Object.keys(harness.storage).some((key) => key.startsWith("cmp:"))).toBe(false);
    });

    it("closes the stopped run's tabs at once, ends it with the cancellation error and lets a new run on the same tab complete", async () => {
      let held: FakeTab | undefined;
      const harness = await bootServiceWorker({
        ...TAB_PATH,
        enabledMarketplaces: ["US", "DE", "UK"],
        onTabCreated: (tab) => {
          if (!held) {
            holdLoading(tab);
            held = tab;
          }
        }
      });

      const firstRun = startRunViaWorker(harness, "run-1");
      await vi.waitFor(() => expect(harness.events).toContain("loading missing/DE"));
      const progressBeforeCancel = progressPayloads(harness, "run-1");

      await expect(cancelViaWorker(harness)).resolves.toEqual({ ok: true, type: CANCEL_COMPARISON });
      expect(harness.openTempTabs()).toEqual([]);
      expect(harness.events).toContain("close missing/DE");

      const second = await runViaWorker(harness, "run-2");
      await firstRun;

      expect(progressBeforeCancel.map(({ latest }) => [latest?.phase, latest?.marketplace])).toEqual([["OPEN", "DE"]]);
      expect(progressPayloads(harness, "run-1")).toEqual(progressBeforeCancel);
      expect(resultPayloads(harness, "run-1")).toEqual([
        expect.objectContaining({ error: CANCELLED_ERROR, results: [], activeTabId: ACTIVE_TAB_ID, runId: "run-1" })
      ]);
      expect(second.error).toBeUndefined();
      expect(second.activeTabId).toBe(ACTIVE_TAB_ID);
      expect(second.results.map((result) => [result.marketplace, result.status])).toEqual([
        ["UK", "OK"],
        ["DE", "OK"]
      ]);
      expect(harness.events.filter((event) => event === "open search/DE")).toHaveLength(1);
      expect(harness.openTempTabs()).toEqual([]);
    });

    it("keeps a new run's tabs when the stopped run cleans up later, so a second Stop still stops the new run", async () => {
      const fx = deferred();
      let held: FakeTab | undefined;
      const harness = await bootServiceWorker({
        ...TAB_PATH,
        enabledMarketplaces: ["US", "DE", "UK"],
        holdFx: fx.promise,
        onTabCreated: (tab) => {
          if (!held) {
            holdLoading(tab);
            held = tab;
          }
        }
      });

      const firstRun = startRunViaWorker(harness, "run-1");
      await vi.waitFor(() => expect(harness.events).toContain("fx www.ecb.europa.eu"));
      await expect(cancelViaWorker(harness)).resolves.toEqual({ ok: true, type: CANCEL_COMPARISON });

      const secondRun = startRunViaWorker(harness, "run-2");
      await vi.waitFor(() => expect(harness.events).toContain("loading missing/DE"));

      fx.resolve();
      await firstRun;

      expect(resultPayloads(harness, "run-1")).toEqual([
        expect.objectContaining({ error: CANCELLED_ERROR, results: [], activeTabId: ACTIVE_TAB_ID, runId: "run-1" })
      ]);
      expect(progressPayloads(harness, "run-1")).toEqual([]);
      expect(harness.openTempTabs()).toEqual(["missing/DE"]);

      await expect(cancelViaWorker(harness)).resolves.toEqual({ ok: true, type: CANCEL_COMPARISON });
      await secondRun;

      expect(resultPayloads(harness, "run-2")).toEqual([
        expect.objectContaining({ error: CANCELLED_ERROR, results: [], activeTabId: ACTIVE_TAB_ID, runId: "run-2" })
      ]);
      expect(progressPayloads(harness, "run-2").map((progress) => progress.latest?.phase)).toEqual(["OPEN"]);
      expect(harness.openTempTabs()).toEqual([]);
      expect(Object.keys(harness.storage).some((key) => key.startsWith("cmp:"))).toBe(false);
    });

    it("stops a run that is still going when a new run starts on the same tab", async () => {
      let held: FakeTab | undefined;
      const harness = await bootServiceWorker({
        ...TAB_PATH,
        enabledMarketplaces: ["US", "DE", "UK"],
        onTabCreated: (tab) => {
          if (!held) {
            holdLoading(tab);
            held = tab;
          }
        }
      });

      const firstRun = startRunViaWorker(harness, "run-1");
      await vi.waitFor(() => expect(harness.events).toContain("loading missing/DE"));

      const second = await runViaWorker(harness, "run-2");
      await firstRun;

      expect(resultPayloads(harness, "run-1")).toEqual([expect.objectContaining({ error: CANCELLED_ERROR, runId: "run-1" })]);
      expect(second.error).toBeUndefined();
      expect(second.results.map((result) => result.marketplace)).toEqual(["UK", "DE"]);
      expect(harness.openTempTabs()).toEqual([]);
    });
  });

  describe("cancellation of downloads", () => {
    it("aborts the download in progress, tells the offscreen document once and opens no tab", async () => {
      const harness = await bootServiceWorker({ enabledMarketplaces: ["US", "DE", "UK"], holdFetchOn: ["missing/DE"] });

      const run = runViaWorker(harness);
      await vi.waitFor(() => expect(harness.events).toContain("fetch missing/DE"));
      const download = harness.fetch.mock.results.at(-1)?.value as Promise<unknown>;
      await expect(cancelViaWorker(harness)).resolves.toEqual({ ok: true, type: CANCEL_COMPARISON });
      const payload = await run;

      await expect(download).rejects.toMatchObject({ name: "AbortError" });
      expect(payload.error).toBe(CANCELLED_ERROR);
      expect(payload.results).toEqual([]);
      expect(harness.offscreenMessages.filter((message) => message.type === OFFSCREEN_CANCEL_RUN)).toEqual([
        { target: OFFSCREEN_TARGET, type: OFFSCREEN_CANCEL_RUN, payload: { runKey: pageJobs(harness)[0].runKey } }
      ]);
      expect(harness.events.slice(harness.events.indexOf("fetch missing/DE"))).toEqual([
        "fetch missing/DE",
        "offscreen cancel",
        "offscreen close"
      ]);
      expect(harness.tabsCreate).not.toHaveBeenCalled();
    });

    it("closes a tab opened for a page whose download showed a robot check", async () => {
      const harness = await bootServiceWorker({
        enabledMarketplaces: ["US", "DE", "UK"],
        captchaOn: ["missing/DE"],
        onTabCreated: (tab) => holdLoading(tab)
      });

      const run = runViaWorker(harness);
      await vi.waitFor(() => expect(harness.events).toContain("loading missing/DE"));
      await expect(cancelViaWorker(harness)).resolves.toEqual({ ok: true, type: CANCEL_COMPARISON });
      const payload = await run;

      expect(payload.error).toBe(CANCELLED_ERROR);
      expect(marketEvents(harness, "DE")).toEqual([
        "progress OPEN DE",
        "fetch robot-check/DE",
        "open missing/DE",
        "loading missing/DE",
        "close missing/DE"
      ]);
      expect(harness.openTempTabs()).toEqual([]);
      expect(harness.tabListenerCount()).toBe(0);
    });

    it("refuses a page job of a stopped run that reaches the document later, while another tab's run goes on", async () => {
      const release = deferred();
      const harness = await bootServiceWorker({
        enabledMarketplaces: ["US", "DE"],
        secondActiveUrl: SOURCE_URL,
        holdFetchOn: ["missing/DE"],
        holdFetch: release.promise
      });

      const stopped = runViaWorker(harness, "run-1");
      const going = runViaWorker(harness, "run-2", SECOND_TAB_ID);
      await vi.waitFor(() => expect(countOf(harness, "fetch missing/DE")).toBe(2));
      const [stoppedJob] = pageJobs(harness);
      await cancelViaWorker(harness);
      expect((await stopped).error).toBe(CANCELLED_ERROR);

      const pagesBefore = harness.pageFetches.length;
      const late = await harness.chrome.runtime.sendMessage({ target: OFFSCREEN_TARGET, type: OFFSCREEN_PAGE_JOB, payload: stoppedJob });
      expect(late).toEqual({ outcome: "cancelled" });
      expect(harness.pageFetches).toHaveLength(pagesBefore);

      release.resolve();
      const payload = await going;
      expect(payload.error).toBeUndefined();
      expect(payload.results).toEqual([EXPECTED_DE_RESULT]);
    });

    it("sends no page job when Stop arrives while the first offscreen document is still being created", async () => {
      const create = deferred();
      const harness = await bootServiceWorker({
        enabledMarketplaces: ["US", "DE"],
        locations: { US: "CH" },
        sourceAsinOn: ["DE"],
        holdCreate: create.promise
      });

      const run = runViaWorker(harness);
      await vi.waitFor(() => expect(harness.chrome.offscreen.createDocument).toHaveBeenCalled());
      const cancel = cancelViaWorker(harness);
      create.resolve();
      await expect(cancel).resolves.toEqual({ ok: true, type: CANCEL_COMPARISON });
      const payload = await run;

      expect(payload.error).toBe(CANCELLED_ERROR);
      expect(pageJobs(harness)).toEqual([]);
      expect(harness.events.filter((event) => event.startsWith("offscreen "))).toEqual([
        "offscreen create",
        "offscreen cancel",
        "offscreen close"
      ]);
      expect(harness.pageFetchUrls()).toEqual([]);
      expect(harness.events.filter((event) => event.includes("location "))).toEqual([]);
      expect(harness.tabsCreate).not.toHaveBeenCalled();
    });
  });

  describe("offscreen document", () => {
    it("creates one document on the first page and closes it once after the run", async () => {
      const harness = await bootServiceWorker({ enabledMarketplaces: ["US", "UK", "DE"] });

      await runViaWorker(harness);

      expect(harness.chrome.offscreen.createDocument).toHaveBeenCalledTimes(1);
      expect(harness.chrome.offscreen.createDocument).toHaveBeenCalledWith(
        expect.objectContaining({ url: "offscreen.html", reasons: ["DOM_PARSER"] })
      );
      expect(harness.events.filter((event) => event.startsWith("offscreen "))).toEqual(["offscreen create", "offscreen close"]);
      expect(harness.events.indexOf("offscreen create")).toBeLessThan(harness.events.findIndex((event) => event.startsWith("fetch ")));
      expect(harness.events.at(-1)).toBe("offscreen close");
    });

    it("closes a document an earlier worker left open when it starts, then opens its own for the run", async () => {
      const harness = await bootServiceWorker({ enabledMarketplaces: ["US", "DE"], offscreenOpenAtStart: true });
      await vi.waitFor(() => expect(harness.events).toEqual(["offscreen close"]));

      const payload = await runViaWorker(harness);

      expect(payload.results).toEqual([EXPECTED_DE_RESULT]);
      expect(harness.events.filter((event) => event.startsWith("offscreen "))).toEqual([
        "offscreen close",
        "offscreen create",
        "offscreen close"
      ]);
    });

    it("opens no document for a run answered from the cache", async () => {
      const harness = await bootServiceWorker({ enabledMarketplaces: ["US", "DE"] });
      await runViaWorker(harness);

      await runViaWorker(harness, "run-2");

      expect(countOf(harness, "offscreen create")).toBe(1);
      expect(countOf(harness, "offscreen close")).toBe(1);
    });

    it("shares one document between runs on two tabs and closes it only after the second ends", async () => {
      const release = deferred();
      const harness = await bootServiceWorker({
        enabledMarketplaces: ["US", "DE"],
        secondActiveUrl: "https://www.amazon.de/dp/B000000005",
        holdFetchOn: ["missing/US"],
        holdFetch: release.promise
      });

      const usSource = runViaWorker(harness, "run-1");
      const deSource = runViaWorker(harness, "run-2", SECOND_TAB_ID);
      expect((await usSource).results.map((result) => result.marketplace)).toEqual(["DE"]);
      expect(countOf(harness, "offscreen close")).toBe(0);
      release.resolve();
      expect((await deSource).results.map((result) => result.marketplace)).toEqual(["US"]);

      expect(harness.events.filter((event) => event.startsWith("offscreen "))).toEqual(["offscreen create", "offscreen close"]);
      expect(harness.events.at(-1)).toBe("offscreen close");
    });

    it("sends every Amazon page, location and offers request of a run with the user's cookies", async () => {
      const harness = await bootServiceWorker({
        enabledMarketplaces: ["US", "DE"],
        sourceAsinOn: ["DE"],
        locations: { US: "CH" },
        offersOn: { DE: "DE-four-new-offers.html" },
        prepare: (group, market, document) => {
          if (group === "product" && market === "DE") {
            offerOnlyOtherSellers(document);
          }
        }
      });

      const payload = await runViaWorker(harness);

      expect(payload.results).toMatchObject([{ marketplace: "DE", status: "OK", otherSeller: { seller: "Star Brick City" } }]);
      const amazonRequests = harness.fetch.mock.calls
        .map(([url, init]) => [new URL(url as string), init as RequestInit] as const)
        .filter(([url]) => getMarketplaceByDomain(url.hostname) !== undefined);
      expect(amazonRequests.map(([url]) => url.pathname)).toEqual([
        "/dp/B000000001",
        LOCATION_FORM_PATH,
        ADDRESS_CHANGE_PATH,
        "/dp/B000000001",
        OFFERS_PATH
      ]);
      for (const [, init] of amazonRequests) {
        expect(init.credentials).toBe("include");
        expect(init.signal).toBeInstanceOf(AbortSignal);
      }
    });

    it("reads a search result that links its product over plain HTTP in a tab, without downloading it", async () => {
      const insecure = "http://www.amazon.de/dp/B000000005";
      const harness = await bootServiceWorker({
        enabledMarketplaces: ["US", "DE"],
        prepare: (group, market, document) => {
          if (group === "search" && market === "DE") {
            document.querySelector("a[href='/dp/B000000005']")?.setAttribute("href", insecure);
          }
        }
      });

      const payload = await runViaWorker(harness);

      expect(payload.results).toEqual([EXPECTED_DE_RESULT]);
      expect(pageJobs(harness).map((job) => job.url)).toContain(insecure);
      expect(harness.pageFetchUrls()).not.toContain(insecure);
      expect(fetchedOn(harness, "DE")).toEqual(["missing/DE", "search/DE"]);
      expect(openedOn(harness, "DE")).toEqual(["product/DE"]);
      expect(harness.openTempTabs()).toEqual([]);
    });
  });

  describe("tab loading", () => {
    function tabEvents(harness: Harness, label: string): string[] {
      const start = harness.events.indexOf(`open ${label}`);
      const end = harness.events.indexOf(`close ${label}`, start);
      return harness.events.slice(start, end + 1);
    }

    it("reads each page as soon as its document is idle, without waiting for the tab to finish loading", async () => {
      const opened: FakeTab[] = [];
      const harness = await bootServiceWorker({
        ...TAB_PATH,
        enabledMarketplaces: ["US", "DE"],
        onTabCreated: (tab) => {
          tab.status = "loading";
          opened.push(tab);
        }
      });

      const payload = await runViaWorker(harness);

      expect(payload.error).toBeUndefined();
      expect(payload.results).toEqual([EXPECTED_DE_RESULT]);
      expect(opened.map((tab) => [tab.label, tab.status])).toEqual([
        ["missing/DE", "loading"],
        ["search/DE", "loading"],
        ["product/DE", "loading"]
      ]);
      expect(harness.tabListenerCount()).toBe(0);
    });

    it("waits for a page that is still loading and reads it once its document is idle", async () => {
      const harness = await bootServiceWorker({
        ...TAB_PATH,
        enabledMarketplaces: ["US", "DE"],
        onTabCreated: (tab, self) => {
          holdLoading(tab);
          setTimeout(() => self.documentIdle(tab.id), 0);
        }
      });

      const payload = await runViaWorker(harness);

      expect(payload.results).toEqual([EXPECTED_DE_RESULT]);
      expect(harness.events.slice(harness.events.indexOf("open search/DE"), harness.events.indexOf("progress SEARCH DE") + 1)).toEqual([
        "open search/DE",
        "loading search/DE",
        "ready search/DE",
        "progress SEARCH DE"
      ]);
      expect(harness.tabListenerCount()).toBe(0);
    });

    it("tries again while a new tab still shows about:blank, which Chrome does not let it script", async () => {
      const harness = await bootServiceWorker({
        ...TAB_PATH,
        enabledMarketplaces: ["US", "DE"],
        onTabCreated: (tab, self) => {
          if (tab.label === "missing/DE") {
            holdBlank(tab);
            setTimeout(() => self.documentIdle(tab.id), 0);
          }
        }
      });

      const payload = await runViaWorker(harness);

      expect(payload.error).toBeUndefined();
      expect(payload.results).toEqual([EXPECTED_DE_RESULT]);
      expect(tabEvents(harness, "missing/DE")).toEqual([
        "open missing/DE",
        "blank missing/DE",
        "ready missing/DE",
        "inject content/location-setter.js missing/DE",
        "inject content/product-extractor.js missing/DE",
        "close missing/DE"
      ]);
    });

    it("inspects a page again when Chrome answers for a document a navigation replaced", async () => {
      const harness = await bootServiceWorker({
        ...TAB_PATH,
        enabledMarketplaces: ["US", "DE"],
        onTabCreated: (tab) => {
          if (tab.label === "search/DE") {
            tab.document = "replaced";
          }
        }
      });

      const payload = await runViaWorker(harness);

      expect(payload.results).toEqual([EXPECTED_DE_RESULT]);
      expect(tabEvents(harness, "search/DE")).toEqual([
        "open search/DE",
        "replaced search/DE",
        "ready search/DE",
        "progress SEARCH DE",
        "inject content/search-extractor.js search/DE",
        "close search/DE"
      ]);
    });

    it("inspects a page again when a navigation removes the frame it was injecting into", async () => {
      const harness = await bootServiceWorker({
        ...TAB_PATH,
        enabledMarketplaces: ["US", "DE"],
        onTabCreated: (tab) => {
          if (tab.label === "missing/DE") {
            tab.document = "removed";
          }
        }
      });

      const payload = await runViaWorker(harness);

      expect(payload.results).toEqual([EXPECTED_DE_RESULT]);
      expect(tabEvents(harness, "missing/DE")).toEqual([
        "open missing/DE",
        "frame removed missing/DE",
        "ready missing/DE",
        "inject content/location-setter.js missing/DE",
        "inject content/product-extractor.js missing/DE",
        "close missing/DE"
      ]);
    });

    it("gives up on an error page at once and searches instead of waiting for the deadline", async () => {
      const harness = await bootServiceWorker({
        ...TAB_PATH,
        enabledMarketplaces: ["US", "DE"],
        onTabCreated: (tab) => {
          if (tab.label === "missing/DE") {
            tab.document = "error";
          }
        }
      });

      const payload = await runViaWorker(harness);

      expect(payload.results).toEqual([EXPECTED_DE_RESULT]);
      expect(tabEvents(harness, "missing/DE")).toEqual(["open missing/DE", "error page missing/DE", "close missing/DE"]);
    });

    it("records a market whose tab is closed while loading as PARSE_FAILED without waiting for the timeout", async () => {
      let closedTabId: number | undefined;
      const harness = await bootServiceWorker({
        ...TAB_PATH,
        enabledMarketplaces: ["US", "DE", "UK"],
        onTabCreated: (tab, self) => {
          if (tab.label === "search/DE") {
            closedTabId = tab.id;
            holdLoading(tab);
            setTimeout(() => void self.chrome.tabs.remove(tab.id), 0);
          }
        }
      });

      const payload = await runViaWorker(harness);

      expect(payload.error).toBeUndefined();
      expect(payload.results.map((result) => [result.marketplace, result.status])).toEqual([
        ["UK", "OK"],
        ["DE", "PARSE_FAILED"]
      ]);
      expect(payload.results[1].notes).toEqual([`Tab ${closedTabId} was closed before it finished loading`]);
      expect(harness.openTempTabs()).toEqual([]);
      expect(harness.tabListenerCount()).toBe(0);
    });

    describe("with fake timers", () => {
      const SIGN_IN_HTML = "<!doctype html><html><head><title>Amazon Sign-In</title></head><body></body></html>";

      beforeEach(() => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      });

      afterEach(() => {
        vi.useRealTimers();
      });

      it("gives up on a tab that never leaves about:blank after 20 seconds", async () => {
        let blankTabId: number | undefined;
        const harness = await bootServiceWorker({
          ...TAB_PATH,
          enabledMarketplaces: ["US", "DE", "UK"],
          onTabCreated: (tab) => {
            if (tab.label === "search/DE") {
              blankTabId = tab.id;
              holdBlank(tab);
            }
          }
        });

        const run = runViaWorker(harness);
        await vi.waitFor(() => expect(harness.events).toContain("blank search/DE"));
        await vi.advanceTimersByTimeAsync(19_000);
        expect(harness.openTempTabs()).toEqual(["search/DE"]);
        await vi.advanceTimersByTimeAsync(1_000);
        const payload = await run;

        expect(payload.results.map((result) => [result.marketplace, result.status, result.notes])).toEqual([
          ["UK", "OK", ["Matched by search", "Match confidence: HIGH"]],
          ["DE", "PARSE_FAILED", [`Timed out waiting for tab ${blankTabId} to load`]]
        ]);
        expect(harness.events.filter((event) => event === "blank search/DE").length).toBeGreaterThan(5);
        expect(harness.openTempTabs()).toEqual([]);
        expect(harness.tabListenerCount()).toBe(0);
      });

      it("gives up at once on a tab that finished loading on a host Chrome does not let it script", async () => {
        const harness = await bootServiceWorker({
          ...TAB_PATH,
          enabledMarketplaces: ["US", "DE", "UK"],
          onTabCreated: (tab) => {
            if (tab.label.endsWith("/DE")) {
              tab.document = "no-access";
            }
          }
        });

        let finished = false;
        const run = runViaWorker(harness).finally(() => {
          finished = true;
        });
        await vi.advanceTimersByTimeAsync(1_000);
        expect(finished).toBe(true);
        const payload = await run;

        expect(payload.results.map((result) => [result.marketplace, result.status, result.notes])).toEqual([
          ["UK", "OK", ["Matched by search", "Match confidence: HIGH"]],
          ["DE", "PARSE_FAILED", [NO_HOST_ACCESS_ERROR]]
        ]);
        expect(tabEvents(harness, "missing/DE")).toEqual(["open missing/DE", "no access missing/DE", "close missing/DE"]);
        expect(tabEvents(harness, "search/DE")).toEqual(["open search/DE", "no access search/DE", "close search/DE"]);
        expect(harness.openTempTabs()).toEqual([]);
        expect(harness.tabListenerCount()).toBe(0);
      });

      it("ends the wait as a closed tab when Chrome reports the tab gone before it sends onRemoved", async () => {
        let closedTabId = 0;
        const harness = await bootServiceWorker({
          ...TAB_PATH,
          enabledMarketplaces: ["US", "DE", "UK"],
          onTabCreated: (tab) => {
            if (tab.label === "search/DE") {
              closedTabId = tab.id;
              holdBlank(tab);
            }
          }
        });
        const injectionsInto = (tabId: number): number =>
          harness.executeScript.mock.calls.filter(([injection]) => (injection as Injection).target.tabId === tabId).length;

        let finished = false;
        const run = runViaWorker(harness).finally(() => {
          finished = true;
        });
        await vi.waitFor(() => expect(harness.events).toContain("blank search/DE"));
        harness.silentRemove(closedTabId);
        const injectionsAtRemoval = injectionsInto(closedTabId);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(finished).toBe(true);
        const payload = await run;

        expect(payload.results.map((result) => [result.marketplace, result.status, result.notes])).toEqual([
          ["UK", "OK", ["Matched by search", "Match confidence: HIGH"]],
          ["DE", "PARSE_FAILED", [`Tab ${closedTabId} was closed before it finished loading`]]
        ]);
        expect(injectionsInto(closedTabId)).toBe(injectionsAtRemoval + 1);
        await vi.advanceTimersByTimeAsync(5_000);
        expect(injectionsInto(closedTabId)).toBe(injectionsAtRemoval + 1);
        expect(harness.tabListenerCount()).toBe(0);
      });

      it("ends the wait as a closed tab when the tab is gone by the time it asks whether the tab is still loading", async () => {
        let closedTabId = 0;
        const harness = await bootServiceWorker({
          ...TAB_PATH,
          enabledMarketplaces: ["US", "DE", "UK"],
          onTabCreated: (tab, self) => {
            if (tab.label === "search/DE") {
              closedTabId = tab.id;
              holdBlank(tab);
              self.executeScript.mockImplementationOnce(async () => {
                self.silentRemove(tab.id);
                throw new Error(NO_HOST_ACCESS_ERROR);
              });
            }
          }
        });

        let finished = false;
        const run = runViaWorker(harness).finally(() => {
          finished = true;
        });
        await vi.advanceTimersByTimeAsync(50);
        expect(finished).toBe(true);
        const payload = await run;

        expect(payload.results.map((result) => [result.marketplace, result.status, result.notes])).toEqual([
          ["UK", "OK", ["Matched by search", "Match confidence: HIGH"]],
          ["DE", "PARSE_FAILED", [`Tab ${closedTabId} was closed before it finished loading`]]
        ]);
        expect(harness.chrome.tabs.get).toHaveBeenCalledWith(closedTabId);
        expect(harness.tabListenerCount()).toBe(0);
      });

      it("does not read a page that landed on another store's host and searches after 20 seconds", async () => {
        const harness = await bootServiceWorker({
          ...TAB_PATH,
          enabledMarketplaces: ["US", "DE"],
          onTabCreated: (tab) => {
            if (tab.label === "missing/DE") {
              tab.dom = new JSDOM(SIGN_IN_HTML, { url: "https://www.amazon.com/ap/signin" });
            }
          }
        });

        const run = runViaWorker(harness);
        await vi.waitFor(() => expect(harness.events).toContain("ready missing/DE"));
        await vi.advanceTimersByTimeAsync(19_000);
        expect(harness.openTempTabs()).toEqual(["missing/DE"]);
        await vi.advanceTimersByTimeAsync(1_000);
        const payload = await run;

        expect(payload.results).toEqual([EXPECTED_DE_RESULT]);
        expect(tabEvents(harness, "missing/DE")).toEqual(["open missing/DE", "ready missing/DE", "close missing/DE"]);
      });

      it("reads the store's page once a tab that answered from another host lands on it", async () => {
        const harness = await bootServiceWorker({
          ...TAB_PATH,
          enabledMarketplaces: ["US", "DE"],
          sourceAsinOn: ["DE"],
          onTabCreated: (tab) => {
            const storeDom = tab.dom;
            tab.dom = new JSDOM(SIGN_IN_HTML, { url: "https://www.amazon.com/ap/signin" });
            setTimeout(() => {
              tab.dom = storeDom;
            }, 500);
          }
        });

        const run = runViaWorker(harness);
        await vi.waitFor(() => expect(harness.events).toContain("ready product/DE"));
        await vi.advanceTimersByTimeAsync(400);
        expect(harness.openTempTabs()).toEqual(["product/DE"]);
        expect(harness.events.slice(harness.events.indexOf("open product/DE"))).toEqual(["open product/DE", "ready product/DE"]);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(harness.events).toContain("inject content/product-extractor.js product/DE");
        const payload = await run;

        expect(payload.results.map((result) => [result.marketplace, result.status, result.notes])).toEqual([
          ["DE", "OK", ["Matched by ASIN"]]
        ]);
        expect(tabEvents(harness, "product/DE")).toEqual([
          "open product/DE",
          "ready product/DE",
          "inject content/location-setter.js product/DE",
          "inject content/product-extractor.js product/DE",
          "close product/DE"
        ]);
        expect(harness.tabsCreate).toHaveBeenCalledTimes(1);
      });

      it("gives up on a search page whose read never answers after 25 seconds and checks the next store", async () => {
        const harness = await bootServiceWorker({ ...TAB_PATH, enabledMarketplaces: ["US", "DE", "UK"], holdScriptOn: ["search/DE"] });

        const run = runViaWorker(harness);
        await vi.waitFor(() => expect(harness.events).toContain("inject content/search-extractor.js search/DE"));
        await vi.advanceTimersByTimeAsync(24_000);
        expect(harness.openTempTabs()).toEqual(["search/DE"]);
        await vi.advanceTimersByTimeAsync(1_000);
        const payload = await run;

        expect(payload.error).toBeUndefined();
        expect(payload.results.map((result) => [result.marketplace, result.status, result.notes])).toEqual([
          ["UK", "OK", ["Matched by search", "Match confidence: HIGH"]],
          ["DE", "PARSE_FAILED", ["Timed out reading the search page after 25 seconds"]]
        ]);
        expect(tabEvents(harness, "search/DE")).toEqual([
          "open search/DE",
          "ready search/DE",
          "progress SEARCH DE",
          "inject content/search-extractor.js search/DE",
          "close search/DE"
        ]);
        expect(harness.openTempTabs()).toEqual([]);
        expect(harness.tabListenerCount()).toBe(0);
      });

      it("stops trying again once Stop closes a tab that still shows about:blank", async () => {
        const harness = await bootServiceWorker({
          ...TAB_PATH,
          enabledMarketplaces: ["US", "DE", "UK"],
          onTabCreated: (tab) => {
            holdBlank(tab);
          }
        });

        const run = startRunViaWorker(harness, "run-1");
        await vi.waitFor(() => expect(harness.events).toContain("blank missing/DE"));
        await expect(cancelViaWorker(harness)).resolves.toEqual({ ok: true, type: CANCEL_COMPARISON });
        await run;
        const injectionsAtStop = harness.executeScript.mock.calls.length;
        await vi.advanceTimersByTimeAsync(5_000);

        expect(resultPayloads(harness, "run-1")).toEqual([
          expect.objectContaining({ error: CANCELLED_ERROR, results: [], runId: "run-1" })
        ]);
        expect(harness.events.at(-1)).toBe("close missing/DE");
        expect(harness.executeScript.mock.calls.length).toBe(injectionsAtStop);
        expect(harness.tabsCreate).toHaveBeenCalledTimes(1);
        expect(harness.tabListenerCount()).toBe(0);
      });
    });
  });

  describe("robot check", () => {
    const DE_ROBOT_CHECK: ComparisonResult = {
      marketplace: "DE",
      status: "PARSE_FAILED",
      confidence: 0,
      notes: ["Amazon showed a robot check on amazon.de"]
    };

    function hasCachedComparison(harness: Harness): boolean {
      return Object.keys(harness.storage).some((key) => key.startsWith("cmp:"));
    }

    it("reports a store whose page for the source ASIN is a robot check as PARSE_FAILED without searching it", async () => {
      const harness = await bootServiceWorker({ enabledMarketplaces: ["US", "DE", "UK"], robotCheckOn: ["missing/DE"] });

      const payload = await runViaWorker(harness);

      expect(payload.error).toBeUndefined();
      expect(payload.results.map((result) => [result.marketplace, result.status])).toEqual([
        ["UK", "OK"],
        ["DE", "PARSE_FAILED"]
      ]);
      expect(payload.results[1]).toEqual(DE_ROBOT_CHECK);
      expect(marketEvents(harness, "DE")).toEqual([
        "progress OPEN DE",
        "fetch robot-check/DE",
        "open robot-check/DE",
        "ready robot-check/DE",
        "close robot-check/DE"
      ]);
      expect(fetchedOn(harness, "UK")).toEqual(["missing/UK", "search/UK", "product/UK"]);
      expect(openedOn(harness, "UK")).toEqual([]);
      expect(harness.openTempTabs()).toEqual([]);
    });

    it("reports a store whose search page is a robot check as PARSE_FAILED without reading another of its pages", async () => {
      const harness = await bootServiceWorker({ enabledMarketplaces: ["US", "DE"], robotCheckOn: ["search/DE"] });

      const payload = await runViaWorker(harness);

      expect(payload.results).toEqual([DE_ROBOT_CHECK]);
      expect(marketEvents(harness, "DE")).toEqual([
        "progress OPEN DE",
        "fetch missing/DE",
        "progress SEARCH DE",
        "fetch robot-check/DE",
        "open robot-check/DE",
        "ready robot-check/DE",
        "close robot-check/DE"
      ]);
    });

    it("reads amazon.com's checkpoint page as a robot check, not as a search without results", async () => {
      const harness = await bootServiceWorker({
        enabledMarketplaces: ["DE", "US"],
        activeUrl: "https://www.amazon.de/dp/B000000005",
        checkpointOn: ["US"]
      });

      const payload = await runViaWorker(harness);

      expect(payload.results).toEqual([
        { marketplace: "US", status: "PARSE_FAILED", confidence: 0, notes: ["Amazon showed a robot check on amazon.com"] }
      ]);
      expect(fetchedOn(harness, "US")).toEqual(["missing/US", "checkpoint/US"]);
      expect(openedOn(harness, "US")).toEqual(["checkpoint/US"]);
      expect(harness.events).not.toContain("inject content/search-extractor.js checkpoint/US");
    });

    it("reads the error page Amazon serves with HTTP 503 as a robot check, not as a search without results", async () => {
      const harness = await bootServiceWorker({ enabledMarketplaces: ["US", "DE"], serviceUnavailableOn: ["search/DE"] });

      const payload = await runViaWorker(harness);

      expect(payload.results).toEqual([DE_ROBOT_CHECK]);
      expect(fetchedOn(harness, "DE")).toEqual(["missing/DE", "http-503/DE"]);
      expect(openedOn(harness, "DE")).toEqual(["http-503/DE"]);
      expect(harness.events).not.toContain("inject content/search-extractor.js http-503/DE");
      expect(hasCachedComparison(harness)).toBe(false);
    });

    it("does not search a store that answers the source ASIN with the HTTP 503 error page", async () => {
      const harness = await bootServiceWorker({ enabledMarketplaces: ["US", "DE"], serviceUnavailableOn: ["missing/DE"] });

      const payload = await runViaWorker(harness);

      expect(payload.results).toEqual([DE_ROBOT_CHECK]);
      expect(marketEvents(harness, "DE")).toEqual([
        "progress OPEN DE",
        "fetch http-503/DE",
        "open http-503/DE",
        "ready http-503/DE",
        "close http-503/DE"
      ]);
    });

    it("reports a store as a robot check, not the search match, when the page of the source's variant is one", async () => {
      const blueVariantUrl = "https://www.amazon.de/dp/B0000000B5";
      const harness = await bootServiceWorker({
        enabledMarketplaces: ["US", "DE"],
        variantAsinsOn: { DE: ["B0000000B5"] },
        robotCheckOn: [blueVariantUrl],
        prepare: (group, market, document) => {
          if (group === "product" && market === "DE") {
            addColourTwister(document, "Red", [
              ["B000000005", "Red"],
              ["B0000000B5", "Blue"]
            ]);
          }
        }
      });

      const payload = await runViaWorker(harness);

      expect(payload.results).toEqual([DE_ROBOT_CHECK]);
      expect(fetchedOn(harness, "DE")).toEqual(["missing/DE", "search/DE", "product/DE", "robot-check/DE"]);
      expect(openedOn(harness, "DE")).toEqual(["robot-check/DE"]);
    });

    it("reports a store as a robot check without downloading another of its pages when the tab that sets its location shows one", async () => {
      const harness = await bootServiceWorker({
        enabledMarketplaces: ["US", "DE"],
        locations: { US: "CH" },
        rejectLocationFetchOn: ["DE"],
        onTabCreated: (tab) => {
          tab.dom = new JSDOM(ROBOT_CHECK_HTML, { url: tab.url });
        }
      });

      const payload = await runViaWorker(harness);

      expect(payload.error).toBeUndefined();
      expect(payload.results).toEqual([DE_ROBOT_CHECK]);
      expect(fetchedOn(harness, "DE")).toEqual(["missing/DE", "search/DE"]);
      expect(marketEvents(harness, "DE").slice(-3)).toEqual(["open search/DE", "ready search/DE", "close search/DE"]);
      expect(harness.events).not.toContain("inject content/location-setter.js search/DE");
      expect(hasCachedComparison(harness)).toBe(false);
      expect(harness.openTempTabs()).toEqual([]);
    });

    it("leaves a run with a robot check out of the cache, so the next run checks again", async () => {
      const harness = await bootServiceWorker({ enabledMarketplaces: ["US", "DE", "UK"], robotCheckOn: ["missing/DE"] });

      await runViaWorker(harness);
      expect(hasCachedComparison(harness)).toBe(false);

      const pagesBefore = harness.pageFetches.length;
      await runViaWorker(harness, "run-2");

      expect(harness.pageFetches.length).toBeGreaterThan(pagesBefore);
      expect(hasCachedComparison(harness)).toBe(false);
    });

    it("checks and reads every other store after robot checks on two of them", async () => {
      const markets: Marketplace[] = ["US", "UK", "DE", "FR", "IT"];
      const clean = await runViaWorker(await bootServiceWorker({ enabledMarketplaces: markets }));
      const harness = await bootServiceWorker({ enabledMarketplaces: markets, robotCheckOn: ["missing/UK", "missing/DE"] });

      const payload = await runViaWorker(harness);

      expect(payload.error).toBeUndefined();
      expect(payload.results).toEqual([
        ...clean.results.filter((result) => result.marketplace === "FR" || result.marketplace === "IT"),
        DE_ROBOT_CHECK,
        { marketplace: "UK", status: "PARSE_FAILED", confidence: 0, notes: ["Amazon showed a robot check on amazon.co.uk"] }
      ]);
      for (const market of ["UK", "DE"] as const) {
        expect(fetchedOn(harness, market)).toEqual([`robot-check/${market}`]);
        expect(openedOn(harness, market)).toEqual([`robot-check/${market}`]);
      }
      for (const market of ["FR", "IT"] as const) {
        expect(fetchedOn(harness, market)).toEqual([`missing/${market}`, `search/${market}`, `product/${market}`]);
        expect(openedOn(harness, market)).toEqual([]);
      }
      expect(hasCachedComparison(harness)).toBe(false);
      expect(harness.openTempTabs()).toEqual([]);
    });

    it("checks and reads every other store after three robot checks, two of them the HTTP 503 error page", async () => {
      const markets: Marketplace[] = ["US", "UK", "DE", "FR", "IT"];
      const clean = await runViaWorker(await bootServiceWorker({ enabledMarketplaces: markets }));
      const harness = await bootServiceWorker({
        enabledMarketplaces: markets,
        robotCheckOn: ["missing/UK"],
        serviceUnavailableOn: ["search/DE", "missing/FR"]
      });

      const payload = await runViaWorker(harness);

      expect(payload.results).toEqual([
        ...clean.results.filter((result) => result.marketplace === "IT"),
        DE_ROBOT_CHECK,
        { marketplace: "FR", status: "PARSE_FAILED", confidence: 0, notes: ["Amazon showed a robot check on amazon.fr"] },
        { marketplace: "UK", status: "PARSE_FAILED", confidence: 0, notes: ["Amazon showed a robot check on amazon.co.uk"] }
      ]);
      expect(fetchedOn(harness, "DE")).toEqual(["missing/DE", "http-503/DE"]);
      expect(openedOn(harness, "DE")).toEqual(["http-503/DE"]);
      expect(openedOn(harness, "FR")).toEqual(["http-503/FR"]);
      expect(fetchedOn(harness, "IT")).toEqual(["missing/IT", "search/IT", "product/IT"]);
      expect(openedOn(harness, "IT")).toEqual([]);
      expect(hasCachedComparison(harness)).toBe(false);
    });

    it("keeps checking and caches the run when two stores fail without a robot check", async () => {
      const closedTabIds: number[] = [];
      const harness = await bootServiceWorker({
        ...TAB_PATH,
        enabledMarketplaces: ["US", "UK", "DE", "FR"],
        onTabCreated: (tab, self) => {
          if (tab.label === "search/UK" || tab.label === "search/DE") {
            closedTabIds.push(tab.id);
            holdLoading(tab);
            setTimeout(() => void self.chrome.tabs.remove(tab.id), 0);
          }
        }
      });

      const payload = await runViaWorker(harness);

      expect(payload.error).toBeUndefined();
      expect(payload.results.map((result) => [result.marketplace, result.status])).toEqual([
        ["FR", "OK"],
        ["DE", "PARSE_FAILED"],
        ["UK", "PARSE_FAILED"]
      ]);
      expect(payload.results.slice(1).map((result) => result.notes)).toEqual([
        [`Tab ${closedTabIds[1]} was closed before it finished loading`],
        [`Tab ${closedTabIds[0]} was closed before it finished loading`]
      ]);
      expect(openedOn(harness, "FR")).toEqual(["missing/FR", "search/FR", "product/FR"]);
      expect(hasCachedComparison(harness)).toBe(true);
    });

    it("keeps checking after one robot check", async () => {
      const harness = await bootServiceWorker({
        enabledMarketplaces: ["US", "UK", "DE", "FR"],
        robotCheckOn: ["missing/UK"],
        prepare: (group, market, document) => {
          if (group === "search" && market === "FR") {
            removeElement(document, "[data-asin='B000000006']");
          }
        }
      });

      const payload = await runViaWorker(harness);

      expect(payload.results.map((result) => [result.marketplace, result.status])).toEqual([
        ["DE", "OK"],
        ["FR", "NO_CONFIDENT_MATCH"],
        ["UK", "PARSE_FAILED"]
      ]);
    });

    it("searches every store that answers with Amazon's not-found page, its HTTP 404 and its automated access notice", async () => {
      const harness = await bootServiceWorker({ enabledMarketplaces: ["US", "UK", "DE", "FR", "IT"] });

      const payload = await runViaWorker(harness);

      expect(harness.pageFetches.filter((fetched) => fetched.label.startsWith("missing/")).map((fetched) => fetched.status)).toEqual([
        404, 404, 404, 404
      ]);
      expect(harness.tabsCreate).not.toHaveBeenCalled();
      expect(readFileSync(join(FIXTURE_ROOT, "product", "not-found.html"), "utf8")).toContain("api-services-support@amazon.com");
      expect(payload.results.map((result) => result.status)).not.toContain("PARSE_FAILED");
      for (const market of ["UK", "DE", "FR", "IT"] as const) {
        expect(fetchedOn(harness, market).slice(0, 2)).toEqual([`missing/${market}`, `search/${market}`]);
      }
      expect(hasCachedComparison(harness)).toBe(true);
    });

    it("stops when Stop arrives after a robot check and returns it among the partial results", async () => {
      const harness = await bootServiceWorker({
        enabledMarketplaces: ["US", "DE", "UK"],
        robotCheckOn: ["missing/DE"],
        holdFetchOn: ["missing/UK"]
      });

      const run = runViaWorker(harness);
      await vi.waitFor(() => expect(harness.events).toContain("fetch missing/UK"));
      await cancelViaWorker(harness);
      const payload = await run;

      expect(payload.error).toBe(CANCELLED_ERROR);
      expect(payload.results).toEqual([DE_ROBOT_CHECK]);
      expect(harness.events.slice(harness.events.indexOf("fetch missing/UK"))).toEqual([
        "fetch missing/UK",
        "offscreen cancel",
        "offscreen close"
      ]);
      expect(openedOn(harness, "UK")).toEqual([]);
      expect(hasCachedComparison(harness)).toBe(false);
      expect(harness.openTempTabs()).toEqual([]);
    });

    it("reads a page in a tab when only its download shows a robot check, then checks the store as usual and caches the run", async () => {
      const harness = await bootServiceWorker({ enabledMarketplaces: ["US", "DE"], captchaOn: ["missing/DE"] });

      const payload = await runViaWorker(harness);

      expect(payload.error).toBeUndefined();
      expect(payload.results).toEqual([EXPECTED_DE_RESULT]);
      expect(fetchedOn(harness, "DE")).toEqual(["robot-check/DE", "search/DE", "product/DE"]);
      expect(openedOn(harness, "DE")).toEqual(["missing/DE"]);
      expect(hasCachedComparison(harness)).toBe(true);
      expect(harness.openTempTabs()).toEqual([]);
    });

    it("never inspects the page you are on for a robot check", async () => {
      const harness = await bootServiceWorker({ enabledMarketplaces: ["US", "DE"] });

      await loadSourceViaWorker(harness);
      await runViaWorker(harness);

      const sourceInjections = harness.executeScript.mock.calls
        .map(([injection]) => injection as Injection)
        .filter((injection) => injection.target.tabId === ACTIVE_TAB_ID);
      expect(sourceInjections.some((injection) => injection.func?.toString().includes("robotCheck"))).toBe(false);
    });
  });

  describe("failures", () => {
    it("fails before reading any store when FX rates cannot be loaded", async () => {
      const harness = await bootServiceWorker({ enabledMarketplaces: ["US", "UK", "DE"], fxAvailable: false });

      const payload = await runViaWorker(harness);

      expect(payload.error).toBe("Unable to load FX reference rates from ECB or Frankfurter");
      expect(payload.activeTabId).toBe(ACTIVE_TAB_ID);
      expect(payload.runId).toBe("run-1");
      expect(payload.results).toEqual([]);
      expect(payload.source).toEqual(EXPECTED_SOURCE);
      expect(payload.baseline).toEqual(RAW_BASELINE);
      expect(payload.baseline).not.toHaveProperty("normalizedTotal");
      expect(payload.fxTable).toBeUndefined();
      expect(harness.fetch).toHaveBeenCalledTimes(2);
      expect(harness.pageFetchUrls()).toEqual([]);
      expect(harness.events).not.toContain("offscreen create");
      expect(harness.tabsCreate).not.toHaveBeenCalled();
      expect(progressPayloads(harness)).toEqual([]);
    });

    it.each([
      ["fails to download", { failFetchOn: ["search/DE"] }],
      ["is not a page it knows", { shapelessOn: ["search/DE"] }]
    ] as Array<[string, HarnessOptions]>)("reads a search page that %s in one tab, with the same result", async (_case, fault) => {
      const harness = await bootServiceWorker({ enabledMarketplaces: ["US", "DE"], ...fault });

      const payload = await runViaWorker(harness);

      expect(payload.error).toBeUndefined();
      expect(payload.results).toEqual([EXPECTED_DE_RESULT]);
      expect(fetchedOn(harness, "DE")).toEqual(["missing/DE", "search/DE", "product/DE"]);
      expect(openedOn(harness, "DE")).toEqual(["search/DE"]);
      expect(progressPayloads(harness).map((progress) => progress.latest?.phase)).toEqual(["OPEN", "SEARCH", "MATCH", "READ", undefined]);
      expect(harness.openTempTabs()).toEqual([]);
    });

    it("reads every page in a tab when the offscreen document cannot be created", async () => {
      const harness = await bootServiceWorker({ enabledMarketplaces: ["US", "DE"], offscreenCreateFails: "Offscreen is not available" });

      const payload = await runViaWorker(harness);

      expect(payload.error).toBeUndefined();
      expect(payload.results).toEqual([EXPECTED_DE_RESULT]);
      expect(harness.chrome.offscreen.createDocument).toHaveBeenCalledTimes(3);
      expect(harness.pageFetchUrls()).toEqual([]);
      expect(openedOn(harness, "DE")).toEqual(["missing/DE", "search/DE", "product/DE"]);
      expect(harness.openTempTabs()).toEqual([]);
    });

    it("reads a page in a tab, and creates the document again for the next page, when the document goes away during a job", async () => {
      const harness = await bootServiceWorker({ enabledMarketplaces: ["US", "DE"], closeOffscreenOn: ["missing/DE"] });

      const payload = await runViaWorker(harness);

      expect(payload.error).toBeUndefined();
      expect(payload.results).toEqual([EXPECTED_DE_RESULT]);
      expect(openedOn(harness, "DE")).toEqual(["missing/DE"]);
      expect(fetchedOn(harness, "DE")).toEqual(["search/DE", "product/DE"]);
      expect(harness.events.filter((event) => event.startsWith("offscreen "))).toEqual([
        "offscreen create",
        "offscreen crash",
        "offscreen create",
        "offscreen close"
      ]);
    });

    describe("with fake timers", () => {
      beforeEach(() => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      });

      afterEach(() => {
        vi.useRealTimers();
      });

      it("reads a search page whose download has not answered after 15 seconds in one tab, with the same result", async () => {
        const harness = await bootServiceWorker({ enabledMarketplaces: ["US", "DE"], holdFetchOn: ["search/DE"] });

        const run = runViaWorker(harness);
        await vi.waitFor(() => expect(harness.events).toContain("fetch search/DE"));
        await vi.advanceTimersByTimeAsync(14_000);
        expect(harness.tabsCreate).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1_000);
        const payload = await run;

        expect(payload.error).toBeUndefined();
        expect(payload.results).toEqual([EXPECTED_DE_RESULT]);
        expect(openedOn(harness, "DE")).toEqual(["search/DE"]);
        expect(harness.openTempTabs()).toEqual([]);
      });

      it("reads a search page that is redirected to another store in a tab, which lands there too and gives up after 20 seconds", async () => {
        const redirected = "https://www.amazon.co.uk/s?k=Acme";
        const harness = await bootServiceWorker({
          enabledMarketplaces: ["US", "DE"],
          redirectOn: { "search/DE": redirected },
          onTabCreated: (tab) => {
            if (tab.label === "search/DE") {
              tab.dom = new JSDOM(tab.dom.serialize(), { url: redirected });
            }
          }
        });

        const run = runViaWorker(harness);
        await vi.waitFor(() => expect(harness.events).toContain("ready search/DE"));
        await vi.advanceTimersByTimeAsync(19_000);
        expect(harness.openTempTabs()).toEqual(["search/DE"]);
        await vi.advanceTimersByTimeAsync(1_000);
        const payload = await run;

        expect(payload.error).toBeUndefined();
        expect(payload.results).toEqual([
          { marketplace: "DE", status: "PARSE_FAILED", confidence: 0, notes: ["Timed out waiting for tab 100 to load"] }
        ]);
        expect(fetchedOn(harness, "DE")).toEqual(["missing/DE", "search/DE"]);
        expect(openedOn(harness, "DE")).toEqual(["search/DE"]);
        expect(harness.openTempTabs()).toEqual([]);
      });

      it("reads a page in a tab when the offscreen document has not answered after 27 seconds", async () => {
        const harness = await bootServiceWorker({ enabledMarketplaces: ["US", "DE"], sourceAsinOn: ["DE"], offscreenSilent: true });

        const run = runViaWorker(harness);
        await vi.waitFor(() => expect(pageJobs(harness)).toHaveLength(1));
        await vi.advanceTimersByTimeAsync(26_000);
        expect(harness.tabsCreate).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1_000);
        const payload = await run;

        expect(payload.error).toBeUndefined();
        expect(payload.results).toMatchObject([{ marketplace: "DE", status: "OK", notes: ["Matched by ASIN"] }]);
        expect(openedOn(harness, "DE")).toEqual(["product/DE"]);
        expect(harness.openTempTabs()).toEqual([]);
      });

      const neverCreated: HarnessOptions = {
        enabledMarketplaces: ["US", "DE"],
        sourceAsinOn: ["DE"],
        holdCreate: new Promise<void>(() => undefined)
      };

      it("reads a page in a tab and answers the run when the offscreen document's creation never settles", async () => {
        const harness = await bootServiceWorker(neverCreated);

        const run = runViaWorker(harness);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(resultPayloads(harness)).toHaveLength(1);
        const payload = await run;

        expect(payload.error).toBeUndefined();
        expect(payload.results).toMatchObject([{ marketplace: "DE", status: "OK", notes: ["Matched by ASIN"] }]);
        expect(pageJobs(harness)).toEqual([]);
        expect(openedOn(harness, "DE")).toEqual(["product/DE"]);
        expect(harness.chrome.offscreen.createDocument).toHaveBeenCalledTimes(1);
        expect(harness.openTempTabs()).toEqual([]);
      });

      it("answers Stop while the offscreen document's creation never settles, and creates the document again for the next run", async () => {
        const harness = await bootServiceWorker(neverCreated);

        const stopped = runViaWorker(harness);
        await vi.waitFor(() => expect(harness.chrome.offscreen.createDocument).toHaveBeenCalledTimes(1));
        const cancelAnswers: unknown[] = [];
        void cancelViaWorker(harness).then((answer) => cancelAnswers.push(answer));
        await vi.advanceTimersByTimeAsync(10_000);
        expect(cancelAnswers).toEqual([{ ok: true, type: CANCEL_COMPARISON }]);
        expect(resultPayloads(harness, "run-1")).toHaveLength(1);
        expect((await stopped).error).toBe(CANCELLED_ERROR);
        expect(harness.offscreenMessages.filter((message) => message.type === OFFSCREEN_CANCEL_RUN)).toHaveLength(1);

        const next = runViaWorker(harness, "run-2");
        await vi.advanceTimersByTimeAsync(30_000);
        expect(resultPayloads(harness, "run-2")).toHaveLength(1);
        const payload = await next;

        expect(payload.error).toBeUndefined();
        expect(payload.results).toMatchObject([{ marketplace: "DE", status: "OK", notes: ["Matched by ASIN"] }]);
        expect(harness.chrome.offscreen.createDocument).toHaveBeenCalledTimes(2);
        expect(pageJobs(harness)).toEqual([]);
        expect(openedOn(harness, "DE")).toEqual(["product/DE"]);
        expect(harness.openTempTabs()).toEqual([]);
      });
    });

    it.each([
      ["search/DE", "content/search-extractor.js"],
      ["product/DE", "content/product-extractor.js"]
    ])(
      "records a market whose %s page cannot be scripted as PARSE_FAILED and closes its tab before the next market starts",
      async (label, script) => {
        const harness = await bootServiceWorker({ ...TAB_PATH, enabledMarketplaces: ["US", "DE", "UK"], failScriptOn: label });

        const payload = await runViaWorker(harness);

        expect(payload.error).toBeUndefined();
        expect(payload.results.map((result) => [result.marketplace, result.status])).toEqual([
          ["UK", "OK"],
          ["DE", "PARSE_FAILED"]
        ]);
        expect(payload.results[1].notes).toEqual(["Frame with ID 0 was removed."]);
        expect(marketEvents(harness, "DE").slice(-2)).toEqual([`inject ${script} ${label}`, `close ${label}`]);
        expect(harness.openTempTabs()).toEqual([]);
      }
    );

    it.each(["search/DE", "product/DE"])(
      "records a market whose %s page does not load within 20 seconds as PARSE_FAILED and closes its tab before the next market starts",
      async (label) => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        try {
          let stalledTabId: number | undefined;
          const harness = await bootServiceWorker({
            ...TAB_PATH,
            enabledMarketplaces: ["US", "DE", "UK"],
            onTabCreated: (tab) => {
              if (tab.label === label) {
                stalledTabId = tab.id;
                holdLoading(tab);
              }
            }
          });

          const run = runViaWorker(harness);
          await vi.waitFor(() => expect(harness.events).toContain(`loading ${label}`));
          expect(harness.events).not.toContain("progress OPEN UK");
          await vi.advanceTimersByTimeAsync(15_000);
          expect(harness.openTempTabs()).toEqual([label]);
          expect(harness.events).not.toContain("progress OPEN UK");
          await vi.advanceTimersByTimeAsync(5_000);
          const payload = await run;

          expect(payload.error).toBeUndefined();
          expect(payload.results.map((result) => [result.marketplace, result.status])).toEqual([
            ["UK", "OK"],
            ["DE", "PARSE_FAILED"]
          ]);
          expect(payload.results[1].notes).toEqual([`Timed out waiting for tab ${stalledTabId} to load`]);
          expect(marketEvents(harness, "DE").slice(-2)).toEqual([`loading ${label}`, `close ${label}`]);
          expect(harness.openTempTabs()).toEqual([]);
          expect(harness.tabListenerCount()).toBe(0);
        } finally {
          vi.useRealTimers();
        }
      }
    );
  });

  describe("baseline", () => {
    const noPriceOptions: HarnessOptions = {
      enabledMarketplaces: ["US", "DE"],
      prepare: (group, _market, document) => {
        if (group === "source") {
          removeElement(document, "#corePriceDisplay_desktop_feature_div");
        }
      }
    };

    it("LOAD_SOURCE omits the baseline when the source page shows no price", async () => {
      const harness = await bootServiceWorker(noPriceOptions);

      const response = await loadSourceViaWorker(harness);

      expect(response.error).toBeUndefined();
      expect(response.source).toEqual(EXPECTED_SOURCE);
      expect(response.baseline).toBeUndefined();
    });

    it("still runs the comparison without a baseline", async () => {
      const harness = await bootServiceWorker(noPriceOptions);

      const payload = await runViaWorker(harness);

      expect(payload.error).toBeUndefined();
      expect(payload.baseline).toBeUndefined();
      expect(payload.results).toEqual([EXPECTED_DE_RESULT]);
      expect(harness.storage[cacheKeyFor(["DE"])]).not.toHaveProperty("baseline");
    });

    describe("on the live amazon.com page of a cable that ships to an address in Switzerland", () => {
      const LIVE_SOURCE_URL = "https://www.amazon.com/dp/B09LCMVB3F";
      const LIVE_BASELINE: ComparisonResult = {
        marketplace: "US",
        status: "OK",
        confidence: 1,
        productUrl: LIVE_SOURCE_URL,
        breakdown: {
          item: { amount: 18.99, currency: "USD" },
          shipping: { amount: 17.88, currency: "USD" },
          importFees: { amount: 0, currency: "USD" },
          totalDisplayed: { amount: 36.87, currency: "USD" }
        },
        notes: []
      };

      function livePage(prepare?: (document: Document) => void): string {
        const dom = new JSDOM(readFileSync(join(FIXTURE_ROOT, "product-live", "US-no-import-charges.html"), "utf8"));
        prepare?.(dom.window.document);
        return dom.serialize();
      }

      it.each([
        ["as captured", livePage()],
        [
          "without its buy box price",
          livePage((document) => document.querySelectorAll("#corePrice_feature_div").forEach((element) => element.remove()))
        ]
      ])("LOAD_SOURCE reads the item, shipping and zero import fees of the page %s", async (_label, activeHtml) => {
        const harness = await bootServiceWorker({ enabledMarketplaces: ["US"], activeUrl: LIVE_SOURCE_URL, activeHtml });

        const response = await loadSourceViaWorker(harness);

        expect(response.error).toBeUndefined();
        expect(response.source?.asin).toBe("B09LCMVB3F");
        expect(response.baseline).toEqual(LIVE_BASELINE);
      });

      it("totals the run's baseline at the displayed $36.87", async () => {
        const harness = await bootServiceWorker({ enabledMarketplaces: ["US"], activeUrl: LIVE_SOURCE_URL, activeHtml: livePage() });

        const payload = await runViaWorker(harness);

        expect(payload.error).toBeUndefined();
        expect(payload.baseline).toEqual({ ...LIVE_BASELINE, normalizedTotal: { amount: 36.87, currency: "USD" } });
        expect(payload.results).toEqual([]);
      });
    });

    it("normalizes the run's baseline and results into a fixed comparison currency while LOAD_SOURCE stays raw", async () => {
      const harness = await bootServiceWorker({ enabledMarketplaces: ["US", "UK", "DE"], comparisonCurrency: "EUR" });

      const loaded = await loadSourceViaWorker(harness);
      const payload = await runViaWorker(harness);

      expect(loaded.baseline).toEqual(RAW_BASELINE);
      expect(payload.baseline?.normalizedTotal).toEqual({ amount: 46.29, currency: "EUR" });
      expect(payload.results.map((result) => [result.marketplace, result.normalizedTotal])).toEqual([
        ["UK", { amount: 44.25, currency: "EUR" }],
        ["DE", { amount: 44.9, currency: "EUR" }]
      ]);
    });
  });

  describe("popup closed", () => {
    it("answers RUN_COMPARISON without an unhandled rejection when the popup has closed", async () => {
      const unhandled: unknown[] = [];
      const recordUnhandled = (reason: unknown) => {
        unhandled.push(reason);
      };
      process.on("unhandledRejection", recordUnhandled);

      try {
        const harness = await bootServiceWorker({ enabledMarketplaces: ["US", "DE"], popupClosed: true });

        const response = await startRunViaWorker(harness, "run-closed");
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(response).toEqual({ ok: true });
        expect(
          resultPayloads(harness).map(({ error, activeTabId, runId }) => ({ error, activeTabId, runId }))
        ).toEqual([
          { error: undefined, activeTabId: ACTIVE_TAB_ID, runId: "run-closed" },
          { error: POPUP_CLOSED_ERROR, activeTabId: ACTIVE_TAB_ID, runId: "run-closed" }
        ]);
        expect(unhandled).toEqual([]);
      } finally {
        process.off("unhandledRejection", recordUnhandled);
      }
    });
  });

  describe("LOAD_SOURCE errors", () => {
    it("reports an unsupported marketplace on a non-Amazon page", async () => {
      const harness = await bootServiceWorker({
        activeUrl: "https://www.example.com/products/widget",
        activeHtml: "<!doctype html><html><body><h1><span>Widget</span></h1></body></html>"
      });

      const response = await loadSourceViaWorker(harness);

      expect(response).toEqual({ error: "Unsupported marketplace hostname: www.example.com" });
      expect(harness.tabsCreate).not.toHaveBeenCalled();
      expect(harness.events).not.toContain("offscreen create");
    });

    it("reports missing product metadata on an Amazon page that is not a product page", async () => {
      const harness = await bootServiceWorker({
        activeUrl: "https://www.amazon.com/gp/help/customer/display.html",
        activeHtml: "<!doctype html><html><body><h1>Help</h1></body></html>"
      });

      const response = await loadSourceViaWorker(harness);

      expect(response).toEqual({ error: "Unable to extract required source product metadata" });
      expect(harness.events).not.toContain("offscreen create");
    });

    it("reports the scripting error on a page the extension cannot access", async () => {
      const harness = await bootServiceWorker({ activeUrl: "chrome://newtab/", activeHtml: "" });

      const response = await loadSourceViaWorker(harness);

      expect(response).toEqual({ error: "Cannot access a chrome:// URL" });
      expect(harness.events).not.toContain("offscreen create");
    });

    it("returns an error result without opening tabs when a run starts on a non-Amazon page", async () => {
      const harness = await bootServiceWorker({
        activeUrl: "https://www.example.com/",
        activeHtml: "<!doctype html><html><body></body></html>"
      });

      const payload = await runViaWorker(harness);

      expect(payload.error).toBe("Unsupported marketplace hostname: www.example.com");
      expect(payload.activeTabId).toBe(ACTIVE_TAB_ID);
      expect(payload.runId).toBe("run-1");
      expect(payload.results).toEqual([]);
      expect(payload.source).toBeUndefined();
      expect(harness.tabsCreate).not.toHaveBeenCalled();
      expect(harness.events).not.toContain("offscreen create");
    });

    it("rejects unsupported messages", async () => {
      const harness = await bootServiceWorker();

      await expect(harness.dispatch({ type: "UNKNOWN" })).resolves.toEqual({ ok: false, error: "Unsupported message" });
    });
  });
});
