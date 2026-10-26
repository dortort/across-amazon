import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setDeliveryLocation } from "../../src/content/location-setter";
import { extractProductDataWithOffers } from "../../src/content/product-extractor";
import { extractSearchCandidates } from "../../src/content/search-extractor";
import { extractSourceContext } from "../../src/content/source-extractor";
import { MARKETPLACE_CODES, getMarketplaceByDomain } from "../../src/shared/markets";
import {
  CANCEL_COMPARISON,
  LOAD_SOURCE,
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
const SOURCE_URL = "https://www.amazon.com/dp/B000000001";
const FIXTURE_ROOT = join(process.cwd(), "tests", "fixtures");
const POPUP_CLOSED_ERROR = "Could not establish connection. Receiving end does not exist.";
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
type TabUpdatedListener = (tabId: number, changeInfo: { status?: string }) => void;
type TabRemovedListener = (tabId: number) => void;
type DocumentState = "blank" | "loading" | "removed" | "replaced" | "error" | "no-access" | "idle";

interface FakeTab {
  id: number;
  url: string;
  label: string;
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
}

interface HarnessOptions {
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
  messages: ExtensionMessage[];
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
    input.value = asin;
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

function createHarness(options: HarnessOptions): Harness {
  const storage: Record<string, unknown> = {
    "settings:v1": {
      enabledMarketplaces: options.enabledMarketplaces ?? ["US", "UK", "DE"],
      comparisonCurrency: options.comparisonCurrency ?? "SOURCE"
    }
  };
  const tabs = new Map<number, FakeTab>();
  const events: string[] = [];
  const messages: ExtensionMessage[] = [];
  const listeners: MessageListener[] = [];
  const updatedListeners = new Set<TabUpdatedListener>();
  const removedListeners = new Set<TabRemovedListener>();
  let nextTabId = 100;
  let fxHold = options.holdFx;
  const locations = new Map<Marketplace, string>(MARKETPLACE_CODES.map((market) => [market, options.locations?.[market] ?? "US"]));

  function fixtureDom(group: FixtureGroup, market: Marketplace, url: string): JSDOM {
    return loadFixtureDom(group, market, url, locations.get(market) ?? "US", options.prepare);
  }

  function requireTab(tabId: number): FakeTab {
    const tab = tabs.get(tabId);
    if (!tab) {
      throw new Error(`No tab with id: ${tabId}`);
    }
    return tab;
  }

  function registerActiveTab(): void {
    const url = options.activeUrl ?? SOURCE_URL;
    const market = getMarketplaceByDomain(new URL(url).hostname);
    const dom =
      options.activeHtml !== undefined || !market
        ? new JSDOM(options.activeHtml ?? "<!doctype html><html><body></body></html>", { url })
        : fixtureDom("source", market, url);
    const label = market && options.activeHtml === undefined ? `source/${market}` : "active";
    tabs.set(ACTIVE_TAB_ID, { ...newTab(ACTIVE_TAB_ID, url, label, dom), served: true });
  }

  function loadProductPage(market: Marketplace, url: string, requestedAsin?: string): { group: FixtureGroup; dom: JSDOM } {
    const dom = fixtureDom("product", market, url);
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
    return { group: "missing", dom: fixtureDom("missing", market, url) };
  }

  function servePage(market: Marketplace, url: string): { label: string; dom: JSDOM; status?: number } {
    const parsed = new URL(url);
    if (parsed.pathname === "/s" && options.checkpointOn?.includes(market)) {
      const checkpointUrl = new URL(CHECKPOINT_PATH, url).href;
      return { label: `checkpoint/${market}`, dom: new JSDOM(CHECKPOINT_HTML, { url: checkpointUrl }) };
    }
    const requestedAsin = /\/dp\/([A-Z0-9]{10})/i.exec(parsed.pathname)?.[1]?.toUpperCase();
    const { group, dom } =
      parsed.pathname === "/s"
        ? { group: "search" as const, dom: fixtureDom("search", market, url) }
        : loadProductPage(market, url, requestedAsin);
    const label = `${group}/${market}`;
    if (options.robotCheckOn?.includes(label) || options.robotCheckOn?.includes(url)) {
      return { label: `robot-check/${market}`, dom: new JSDOM(ROBOT_CHECK_HTML, { url }) };
    }
    if (options.serviceUnavailableOn?.includes(label) || options.serviceUnavailableOn?.includes(url)) {
      return { label: `http-503/${market}`, dom: new JSDOM(SERVICE_UNAVAILABLE_HTML, { url }), status: 503 };
    }
    return { label, dom, status: group === "missing" ? 404 : 200 };
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
        events.push(`blank ${tab.label}`);
        throw new Error(NO_HOST_ACCESS_ERROR);
      case "error":
        events.push(`error page ${tab.label}`);
        throw new Error(ERROR_PAGE_ERROR);
      case "no-access":
        events.push(`no access ${tab.label}`);
        throw new Error(NO_HOST_ACCESS_ERROR);
      case "removed":
        events.push(`frame removed ${tab.label}`);
        tab.document = "idle";
        throw new Error(FRAME_REMOVED_ERROR);
      case "replaced":
        events.push(`replaced ${tab.label}`);
        tab.document = "idle";
        return "replaced";
      case "loading":
        if (!tab.waited) {
          tab.waited = true;
          events.push(`loading ${tab.label}`);
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
      events.push(`ready ${tab.label}`);
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
      events.push(`inject immediately ${tab.label}`);
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
        events.push(`inject ${file} ${tab.label}`);
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
    events.push(`open ${tab.label}`);
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
    events.push(`close ${tab.label}`);
  }

  const tabsRemove = vi.fn(async (tabId: number) => {
    silentRemove(tabId);
    for (const listener of [...removedListeners]) {
      listener(tabId);
    }
  });

  const executeScript = vi.fn(async (injection: Injection) => runInjection(injection));

  async function answerAmazon(market: Marketplace, url: URL, init: RequestInit) {
    const headers = (init.headers ?? {}) as Record<string, string>;
    if (url.pathname === LOCATION_FORM_PATH) {
      events.push(`location form ${url.hostname}`);
      await options.holdLocation;
      const form = options.notOfferedOn?.includes(market) ? "AU-modal.html" : locationFormFile(market);
      const body = headers["anti-csrftoken-a2z"] === PAGE_TOKEN ? readLocationFixture(form) : readLocationFixture("degraded-modal.html");
      return { ok: true, status: 200, text: async () => body };
    }
    if (url.pathname === ADDRESS_CHANGE_PATH && init.method === "POST") {
      const countryCode = (JSON.parse(String(init.body)) as { countryCode: string }).countryCode;
      events.push(`location change ${url.hostname} ${countryCode}`);
      const accepted =
        headers["anti-csrftoken-a2z"] === POST_TOKEN &&
        headers["Content-Type"] === "application/json" &&
        !options.rejectLocationOn?.includes(market);
      if (!accepted) {
        return { ok: true, status: 200, text: async () => "" };
      }
      locations.set(market, countryCode);
      const success = JSON.parse(readLocationFixture("address-change-CH.json")) as { address: Record<string, unknown> };
      const body = JSON.stringify({ ...success, address: { ...success.address, countryCode, district: countryCode } });
      return { ok: true, status: 200, text: async () => body };
    }
    if (url.pathname === OFFERS_PATH) {
      events.push(`offers ${url.hostname}`);
      await options.holdOffers;
      const file = options.offersOn?.[market];
      return file ? { ok: true, status: 200, text: async () => readOffersFixture(file) } : { ok: false, status: 404, text: async () => "" };
    }
    return { ok: false, status: 404, text: async () => "" };
  }

  const fetchMock = vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const market = getMarketplaceByDomain(url.hostname);
    if (market) {
      return answerAmazon(market, url, init);
    }
    const host = url.hostname;
    events.push(`fx ${host}`);
    const hold = fxHold;
    fxHold = undefined;
    await hold;
    if (options.fxAvailable === false || host !== "www.ecb.europa.eu") {
      return { ok: false, status: 503 };
    }
    return { ok: true, status: 200, text: async () => ECB_XML };
  });

  const chromeMock = {
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
      sendMessage: vi.fn(async (message: ExtensionMessage) => {
        const copy = structuredClone(message);
        messages.push(copy);
        if (copy.type === RUN_COMPARISON_PROGRESS) {
          const payload = copy.payload as RunComparisonProgressPayload;
          events.push(payload.latest ? `progress ${payload.latest.phase} ${payload.latest.marketplace}` : "progress DONE");
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
    messages,
    tabsCreate,
    tabsRemove,
    executeScript,
    openTempTabs: () => [...tabs.values()].filter((tab) => tab.id !== ACTIVE_TAB_ID).map((tab) => tab.label),
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

  registerActiveTab();
  return harness;
}

async function bootServiceWorker(options: HarnessOptions = {}): Promise<Harness> {
  const harness = createHarness(options);
  vi.stubGlobal("chrome", harness.chrome);
  vi.stubGlobal("fetch", harness.fetch);
  vi.resetModules();
  await import("../../src/background/service-worker");
  return harness;
}

async function loadSourceViaWorker(harness: Harness): Promise<LoadSourcePayload> {
  return (await harness.dispatch({ type: LOAD_SOURCE, payload: { activeTabId: ACTIVE_TAB_ID } })) as LoadSourcePayload;
}

async function runViaWorker(harness: Harness, runId = "run-1"): Promise<RunComparisonResultPayload> {
  const response = await harness.dispatch({ type: RUN_COMPARISON, payload: { activeTabId: ACTIVE_TAB_ID, runId } });
  expect(response).toEqual({ ok: true });
  return resultPayloads(harness, runId).at(-1) as RunComparisonResultPayload;
}

function startRunViaWorker(harness: Harness, runId: string): Promise<unknown> {
  return harness.dispatch({ type: RUN_COMPARISON, payload: { activeTabId: ACTIVE_TAB_ID, runId } });
}

function cancelViaWorker(harness: Harness): Promise<unknown> {
  return harness.dispatch({ type: CANCEL_COMPARISON, payload: { activeTabId: ACTIVE_TAB_ID } });
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
  const start = harness.events.indexOf(`progress OPEN ${market}`);
  const end = harness.events.findIndex(
    (event, index) => index > start && (event.startsWith("progress OPEN ") || event === "progress DONE")
  );
  return harness.events.slice(start, end === -1 ? undefined : end);
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

      const opened = (market: Marketplace) =>
        marketEvents(harness, market).filter((event) => event.startsWith("open ")).map((event) => event.slice("open ".length));
      expect(opened("UK")).toEqual(["product/UK"]);
      expect(opened("DE")).toEqual(["missing/DE", "search/DE", "product/DE"]);
      expect(opened("FR")).toEqual(["missing/FR", "search/FR"]);
      expect(opened("IT")).toEqual(["missing/IT", "search/IT", "product/IT"]);
      expect(opened("ES")).toEqual(["product/ES", "search/ES", "product/ES"]);
      expect(opened("JP")).toEqual(["product/JP"]);
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

    it("loads FX rates before opening any marketplace tab", async () => {
      const harness = await bootServiceWorker(fullRunOptions);

      await runViaWorker(harness);

      const fxIndex = harness.events.indexOf("fx www.ecb.europa.eu");
      const firstOpenIndex = harness.events.findIndex((event) => event.startsWith("open "));
      expect(fxIndex).toBeGreaterThan(-1);
      expect(fxIndex).toBeLessThan(firstOpenIndex);
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
      const harness = await bootServiceWorker({ enabledMarketplaces: ["US", "DE"] });

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

    it("reads a marketplace that carries the source ASIN straight from its product page, in one tab", async () => {
      const harness = await bootServiceWorker({ enabledMarketplaces: ["US", "DE"], sourceAsinOn: ["DE"] });

      const payload = await runViaWorker(harness);

      expect(payload.error).toBeUndefined();
      expect(payload.results).toEqual([ASIN_DE_RESULT]);
      expect(harness.tabsCreate).toHaveBeenCalledTimes(1);
      expect(harness.tabsCreate).toHaveBeenCalledWith({ url: "https://www.amazon.de/dp/B000000001", active: false });
      expect(eventsAfterStartup(harness)).toEqual([
        "progress OPEN DE",
        "open product/DE",
        "ready product/DE",
        "inject content/location-setter.js product/DE",
        "inject content/product-extractor.js product/DE",
        "close product/DE",
        "progress READ DE",
        "progress DONE"
      ]);
      expect(harness.openTempTabs()).toEqual([]);
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
      expect(harness.tabsCreate.mock.calls.map(([options]) => (options as { url: string }).url)).toEqual([
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

      expect(harness.tabsCreate.mock.calls.map(([options]) => (options as { url: string }).url)).toEqual([
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

      expect(harness.tabsCreate.mock.calls.map(([options]) => (options as { url: string }).url)).toEqual([
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
      expect(marketEvents(harness, "DE").filter((event) => event.startsWith("open "))).toEqual([
        "open product/DE",
        "open search/DE",
        "open product/DE"
      ]);
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
      expect(harness.events).toContain("open search/DE");
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
      expect(harness.events).not.toContain("open search/DE");
      expect(harness.tabsCreate).toHaveBeenCalledTimes(1);
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
        expect(harness.tabsCreate.mock.calls.map(([options]) => (options as { url: string }).url)).toEqual([
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
        expect(harness.tabsCreate.mock.calls.map(([options]) => (options as { url: string }).url)).toEqual([
          SOURCE_ASIN_URL,
          TITLE_QUERY_URL,
          "https://www.amazon.de/dp/B000000005"
        ]);
      });

      it("quotes a page for the source ASIN that cannot be dispatched to the address in one tab, without searching", async () => {
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
        expect(harness.tabsCreate).toHaveBeenCalledTimes(1);
        expect(progressPayloads(harness).map((progress) => progress.latest?.phase)).toEqual(["OPEN", "READ", undefined]);
        expect(harness.openTempTabs()).toEqual([]);
      });
    });

    it("searches when the page for the source ASIN cannot be scripted", async () => {
      const harness = await bootServiceWorker({ enabledMarketplaces: ["US", "DE"], failScriptOn: "missing/DE" });

      const payload = await runViaWorker(harness);

      expect(payload.error).toBeUndefined();
      expect(payload.results).toEqual([EXPECTED_DE_RESULT]);
      expect(harness.openTempTabs()).toEqual([]);
    });

    it("searches when the page for the source ASIN is closed while it loads", async () => {
      const harness = await bootServiceWorker({
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
      expect(marketEvents(harness, "DE").slice(0, 10)).toEqual([
        "progress OPEN DE",
        "open missing/DE",
        "ready missing/DE",
        "inject content/location-setter.js missing/DE",
        "location form www.amazon.de",
        "location change www.amazon.de CH",
        "close missing/DE",
        "open missing/DE",
        "ready missing/DE",
        "inject content/product-extractor.js missing/DE"
      ]);
      expect(harness.tabsCreate.mock.calls.map(([options]) => (options as { url: string }).url)).toEqual([
        "https://www.amazon.de/dp/B000000001",
        "https://www.amazon.de/dp/B000000001",
        SEARCH_URL,
        "https://www.amazon.de/dp/B000000005"
      ]);
      expect(harness.events.filter((event) => event.startsWith("inject content/location-setter.js"))).toHaveLength(1);
      expect(harness.openTempTabs()).toEqual([]);
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
      expect(harness.events).toContain("location change www.amazon.de CH");
      expect(marketEvents(harness, "DE").filter((event) => event.startsWith("open "))).toEqual([
        "open missing/DE",
        "open search/DE",
        "open product/DE"
      ]);
      expect(harness.events.filter((event) => event.startsWith("inject content/location-setter.js"))).toHaveLength(1);
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
      return harness.events.filter((event) => event.startsWith("location ") || event.startsWith("inject content/location-setter.js"));
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
      expect(harness.events.filter((event) => event.startsWith("location "))).toEqual([]);
      expect(harness.events.filter((event) => event.startsWith("inject content/location-setter.js"))).toEqual([
        "inject content/location-setter.js missing/UK",
        "inject content/location-setter.js missing/DE"
      ]);
      expect(harness.fetch.mock.calls.map(([url]) => new URL(url as string).hostname)).toEqual(["www.ecb.europa.eu"]);
    });

    it("sets each store once per run, on the first of its tabs that has the location widget, and reopens that tab", async () => {
      const harness = await bootServiceWorker({
        enabledMarketplaces: ["US", "DE"],
        locations: { US: "CH" },
        prepare: (group, _market, document) => {
          if (group === "missing") {
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
        "open missing/DE",
        "ready missing/DE",
        "inject content/location-setter.js missing/DE",
        "inject content/product-extractor.js missing/DE",
        "close missing/DE",
        "open search/DE",
        "ready search/DE",
        "inject content/location-setter.js search/DE",
        "location form www.amazon.de",
        "location change www.amazon.de CH",
        "close search/DE",
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
        "close product/DE"
      ]);
      expect(harness.openTempTabs()).toEqual([]);
    });

    it("does not post a destination the store does not offer", async () => {
      const harness = await bootServiceWorker({
        enabledMarketplaces: ["US", "AU"],
        locations: { US: "CH", AU: "NZ" },
        notOfferedOn: ["AU"]
      });

      const payload = await runViaWorker(harness);

      expect(locationEvents(harness)).toEqual(["inject content/location-setter.js missing/AU", "location form www.amazon.com.au"]);
      expect(payload.results).toHaveLength(1);
      expect(payload.results[0]).toMatchObject({ marketplace: "AU", status: "DESTINATION_MISMATCH" });
      expect(payload.results[0].notes).toEqual(
        expect.arrayContaining(["Delivery location not offered: CH", "Destination mismatch detected (NZ)"])
      );
    });

    it("does not try to set a store to its own country", async () => {
      const harness = await bootServiceWorker({ enabledMarketplaces: ["US", "DE"], locations: { US: "DE", DE: "US" } });

      const payload = await runViaWorker(harness);

      expect(locationEvents(harness)).toEqual(["inject content/location-setter.js missing/DE"]);
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
    });

    it("stops when the run is cancelled during a location change", async () => {
      const harness = await bootServiceWorker({
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

    it("times out a location change that never answers and reads the page as it is", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const harness = await bootServiceWorker({
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

      expect(harness.events.filter((event) => event.startsWith("location change "))).toEqual([
        "location change www.amazon.co.uk CH",
        "location change www.amazon.de CH"
      ]);
      expect(harness.events.filter((event) => event.includes("www.amazon.com ") || event.endsWith("www.amazon.com"))).toEqual([]);
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
        expect.objectContaining({ credentials: "same-origin" })
      );
      expect(harness.events.filter((event) => event.startsWith("offers "))).toEqual(["offers www.amazon.de"]);
      expect(harness.openTempTabs()).toEqual([]);
    });

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
    });

    it("times out a product read that never answers, as it does the location step, and closes the tab", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const harness = await bootServiceWorker({
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
      expect(harness.tabsCreate.mock.calls.map(([options]) => (options as { url: string }).url).slice(-2)).toEqual([
        RED_LISTING_URL,
        `https://www.amazon.de/dp/${BLUE_VARIANT_ASIN}`
      ]);
      expect(harness.openTempTabs()).toEqual([]);
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
      expect(marketEvents(harness, "DE").filter((event) => event.startsWith("open "))).toEqual([
        "open missing/DE",
        "open search/DE",
        "open product/DE"
      ]);
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
    it("answers a repeat run from the cache with the baseline and FX table and opens no tabs", async () => {
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
      expect(harness.tabsCreate).toHaveBeenCalled();
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
      expect(harness.tabsCreate).toHaveBeenCalled();
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
    });
  });

  describe("cancellation", () => {
    it("stops mid-run, closes a tab opened after Stop at once and returns partial results with source, baseline and FX", async () => {
      let cancelResponse: unknown;
      const harness = await bootServiceWorker({
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

  describe("tab loading", () => {
    function tabEvents(harness: Harness, label: string): string[] {
      const start = harness.events.indexOf(`open ${label}`);
      const end = harness.events.indexOf(`close ${label}`, start);
      return harness.events.slice(start, end + 1);
    }

    it("reads each page as soon as its document is idle, without waiting for the tab to finish loading", async () => {
      const opened: FakeTab[] = [];
      const harness = await bootServiceWorker({
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
        const harness = await bootServiceWorker({ enabledMarketplaces: ["US", "DE", "UK"], holdScriptOn: ["search/DE"] });

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

    function openedOn(harness: Harness, market: Marketplace): string[] {
      return marketEvents(harness, market)
        .filter((event) => event.startsWith("open "))
        .map((event) => event.slice("open ".length));
    }

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
        "open robot-check/DE",
        "ready robot-check/DE",
        "close robot-check/DE"
      ]);
      expect(openedOn(harness, "UK")).toEqual(["missing/UK", "search/UK", "product/UK"]);
      expect(harness.openTempTabs()).toEqual([]);
    });

    it("reports a store whose search page is a robot check as PARSE_FAILED without reading another of its pages", async () => {
      const harness = await bootServiceWorker({ enabledMarketplaces: ["US", "DE"], robotCheckOn: ["search/DE"] });

      const payload = await runViaWorker(harness);

      expect(payload.results).toEqual([DE_ROBOT_CHECK]);
      expect(marketEvents(harness, "DE")).toEqual([
        "progress OPEN DE",
        "open missing/DE",
        "ready missing/DE",
        "inject content/location-setter.js missing/DE",
        "inject content/product-extractor.js missing/DE",
        "close missing/DE",
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
      expect(openedOn(harness, "US")).toEqual(["missing/US", "checkpoint/US"]);
      expect(harness.events).not.toContain("inject content/search-extractor.js checkpoint/US");
    });

    it("reads the error page Amazon serves with HTTP 503 as a robot check, not as a search without results", async () => {
      const harness = await bootServiceWorker({ enabledMarketplaces: ["US", "DE"], serviceUnavailableOn: ["search/DE"] });

      const payload = await runViaWorker(harness);

      expect(payload.results).toEqual([DE_ROBOT_CHECK]);
      expect(openedOn(harness, "DE")).toEqual(["missing/DE", "http-503/DE"]);
      expect(harness.events).not.toContain("inject content/search-extractor.js http-503/DE");
      expect(hasCachedComparison(harness)).toBe(false);
    });

    it("does not search a store that answers the source ASIN with the HTTP 503 error page", async () => {
      const harness = await bootServiceWorker({ enabledMarketplaces: ["US", "DE"], serviceUnavailableOn: ["missing/DE"] });

      const payload = await runViaWorker(harness);

      expect(payload.results).toEqual([DE_ROBOT_CHECK]);
      expect(marketEvents(harness, "DE")).toEqual([
        "progress OPEN DE",
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
      expect(openedOn(harness, "DE")).toEqual(["missing/DE", "search/DE", "product/DE", "robot-check/DE"]);
    });

    it("leaves a run with a robot check out of the cache, so the next run checks again", async () => {
      const harness = await bootServiceWorker({ enabledMarketplaces: ["US", "DE", "UK"], robotCheckOn: ["missing/DE"] });

      await runViaWorker(harness);
      expect(hasCachedComparison(harness)).toBe(false);

      harness.tabsCreate.mockClear();
      await runViaWorker(harness, "run-2");

      expect(harness.tabsCreate).toHaveBeenCalled();
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
      expect(openedOn(harness, "UK")).toEqual(["robot-check/UK"]);
      expect(openedOn(harness, "DE")).toEqual(["robot-check/DE"]);
      for (const market of ["FR", "IT"] as const) {
        expect(openedOn(harness, market)).toEqual([`missing/${market}`, `search/${market}`, `product/${market}`]);
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
      expect(openedOn(harness, "DE")).toEqual(["missing/DE", "http-503/DE"]);
      expect(openedOn(harness, "FR")).toEqual(["http-503/FR"]);
      expect(openedOn(harness, "IT")).toEqual(["missing/IT", "search/IT", "product/IT"]);
      expect(hasCachedComparison(harness)).toBe(false);
    });

    it("keeps checking and caches the run when two stores fail without a robot check", async () => {
      const closedTabIds: number[] = [];
      const harness = await bootServiceWorker({
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
      const notFoundStatuses: number[] = [];
      const harness = await bootServiceWorker({
        enabledMarketplaces: ["US", "UK", "DE", "FR", "IT"],
        onTabCreated: (tab) => {
          if (tab.label.startsWith("missing/")) {
            notFoundStatuses.push(tab.responseStatus);
          }
        }
      });

      const payload = await runViaWorker(harness);

      expect(notFoundStatuses).toEqual([404, 404, 404, 404]);
      expect(readFileSync(join(FIXTURE_ROOT, "product", "not-found.html"), "utf8")).toContain("api-services-support@amazon.com");
      expect(payload.results.map((result) => result.status)).not.toContain("PARSE_FAILED");
      for (const market of ["UK", "DE", "FR", "IT"] as const) {
        expect(openedOn(harness, market).slice(0, 2)).toEqual([`missing/${market}`, `search/${market}`]);
      }
      expect(hasCachedComparison(harness)).toBe(true);
    });

    it("stops when Stop arrives after a robot check and returns it among the partial results", async () => {
      const harness = await bootServiceWorker({
        enabledMarketplaces: ["US", "DE", "UK"],
        robotCheckOn: ["missing/DE"],
        onTabCreated: (tab, self) => {
          if (tab.label === "missing/UK") {
            void self.dispatch({ type: CANCEL_COMPARISON, payload: { activeTabId: ACTIVE_TAB_ID } });
          }
        }
      });

      const payload = await runViaWorker(harness);

      expect(payload.error).toBe(CANCELLED_ERROR);
      expect(payload.results).toEqual([DE_ROBOT_CHECK]);
      expect(harness.events.slice(harness.events.indexOf("open missing/UK"))).toEqual([
        "open missing/UK",
        "close missing/UK"
      ]);
      expect(hasCachedComparison(harness)).toBe(false);
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
    it("fails before opening any tab when FX rates cannot be loaded", async () => {
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
      expect(harness.tabsCreate).not.toHaveBeenCalled();
      expect(progressPayloads(harness)).toEqual([]);
    });

    it.each([
      ["search/DE", "content/search-extractor.js"],
      ["product/DE", "content/product-extractor.js"]
    ])(
      "records a market whose %s page cannot be scripted as PARSE_FAILED and closes its tab before the next market starts",
      async (label, script) => {
        const harness = await bootServiceWorker({ enabledMarketplaces: ["US", "DE", "UK"], failScriptOn: label });

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
    });

    it("reports missing product metadata on an Amazon page that is not a product page", async () => {
      const harness = await bootServiceWorker({
        activeUrl: "https://www.amazon.com/gp/help/customer/display.html",
        activeHtml: "<!doctype html><html><body><h1>Help</h1></body></html>"
      });

      const response = await loadSourceViaWorker(harness);

      expect(response).toEqual({ error: "Unable to extract required source product metadata" });
    });

    it("reports the scripting error on a page the extension cannot access", async () => {
      const harness = await bootServiceWorker({ activeUrl: "chrome://newtab/", activeHtml: "" });

      const response = await loadSourceViaWorker(harness);

      expect(response).toEqual({ error: "Cannot access a chrome:// URL" });
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
    });

    it("rejects unsupported messages", async () => {
      const harness = await bootServiceWorker();

      await expect(harness.dispatch({ type: "UNKNOWN" })).resolves.toEqual({ ok: false, error: "Unsupported message" });
    });
  });
});
