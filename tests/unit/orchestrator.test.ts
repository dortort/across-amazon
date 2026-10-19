import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractProductData } from "../../src/content/product-extractor";
import { extractSearchCandidates } from "../../src/content/search-extractor";
import { extractSourceContext } from "../../src/content/source-extractor";
import { getMarketplaceByDomain } from "../../src/shared/markets";
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
  ComparisonResult,
  FxTable,
  LoadSourcePayload,
  Marketplace,
  ProductExtractionRequest,
  RunComparisonProgressPayload,
  RunComparisonResultPayload,
  SearchExtractionRequest,
  SourceContext
} from "../../src/shared/types";

const ACTIVE_TAB_ID = 1;
const SOURCE_URL = "https://www.amazon.com/dp/B000000001";
const FIXTURE_ROOT = join(process.cwd(), "tests", "fixtures");
const POPUP_CLOSED_ERROR = "Could not establish connection. Receiving end does not exist.";
const CANCELLED_ERROR = "Comparison cancelled by user";

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
    </Cube>
  </Cube>
</gesmes:Envelope>`;

const EXPECTED_FX_TABLE: FxTable = {
  base: "EUR",
  date: "2026-10-16",
  rates: { EUR: 1, USD: 1.08, JPY: 155.52, GBP: 0.852, CAD: 1.475, AUD: 1.655, MXN: 19.46 },
  source: "ECB"
};

const EXPECTED_SOURCE: SourceContext = {
  marketplace: "US",
  asin: "B000000001",
  title: "Acme Ultra Widget Model X100 2 Pack Blue",
  brand: "Acme",
  variationTokens: ["2 pack", "16 oz", "blue"],
  destinationCountryCode: "US",
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

interface FakeTab {
  id: number;
  url: string;
  label: string;
  dom: JSDOM;
  scope: WindowScope;
  status: "loading" | "complete";
  completeDuringStatusCheck?: boolean;
}

interface Injection {
  target: { tabId: number };
  files?: string[];
  func?: (...args: never[]) => unknown;
  args?: unknown[];
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
  finishLoading: (tabId: number) => void;
  dispatch: (message: unknown) => Promise<unknown>;
}

function setDeliveryCountry(document: Document, country: string): void {
  const line = document.querySelector("#glow-ingress-line2");
  if (line) {
    line.textContent = `Deliver to ${country}`;
  }
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

function loadFixtureDom(group: FixtureGroup, market: Marketplace, url: string, prepare?: Prepare): JSDOM {
  const file = group === "missing" ? join("product", "not-found.html") : join(group, `${market}.html`);
  const html = readFileSync(join(FIXTURE_ROOT, file), "utf8");
  const dom = new JSDOM(html, { url });
  setDeliveryCountry(dom.window.document, "United States");
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
      tab.scope.__ACROSS_AMAZON_PRODUCT_RESULT__ = extractProductData(document, request, location.href);
    }
  }
};

function createHarness(options: HarnessOptions): Harness {
  const storage: Record<string, unknown> = {
    "settings:v1": {
      enabledMarketplaces: options.enabledMarketplaces ?? ["US", "UK", "DE"],
      comparisonCurrency: options.comparisonCurrency ?? "SOURCE",
      disclosureAcknowledged: true
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

  function requireTab(tabId: number): FakeTab {
    const tab = tabs.get(tabId);
    if (!tab) {
      throw new Error(`No tab with id: ${tabId}.`);
    }
    return tab;
  }

  function registerActiveTab(): void {
    const url = options.activeUrl ?? SOURCE_URL;
    const market = getMarketplaceByDomain(new URL(url).hostname);
    const dom =
      options.activeHtml !== undefined || !market
        ? new JSDOM(options.activeHtml ?? "<!doctype html><html><body></body></html>", { url })
        : loadFixtureDom("source", market, url, options.prepare);
    const label = market && options.activeHtml === undefined ? `source/${market}` : "active";
    tabs.set(ACTIVE_TAB_ID, { id: ACTIVE_TAB_ID, url, label, dom, scope: {}, status: "complete" });
  }

  function loadProductPage(market: Marketplace, url: string, requestedAsin?: string): { group: FixtureGroup; dom: JSDOM } {
    const dom = loadFixtureDom("product", market, url, options.prepare);
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
    return { group: "missing", dom: loadFixtureDom("missing", market, url, options.prepare) };
  }

  function openTempTab(url: string): FakeTab {
    const parsed = new URL(url);
    const market = getMarketplaceByDomain(parsed.hostname);
    if (!market) {
      throw new Error(`No fixture for ${url}`);
    }
    const requestedAsin = /\/dp\/([A-Z0-9]{10})/i.exec(parsed.pathname)?.[1]?.toUpperCase();
    const { group, dom } =
      parsed.pathname === "/s"
        ? { group: "search" as const, dom: loadFixtureDom("search", market, url, options.prepare) }
        : loadProductPage(market, url, requestedAsin);
    const tab: FakeTab = {
      id: nextTabId,
      url,
      label: `${group}/${market}`,
      dom,
      scope: {},
      status: "complete"
    };
    nextTabId += 1;
    tabs.set(tab.id, tab);
    return tab;
  }

  function runInjection(injection: Injection): Array<{ frameId: number; documentId: string; result?: unknown }> {
    const tab = requireTab(injection.target.tabId);
    if (tab.url.startsWith("chrome://")) {
      throw new Error("Cannot access a chrome:// URL");
    }

    const frame = { frameId: 0, documentId: `doc-${tab.id}` };

    if (injection.files) {
      for (const file of injection.files) {
        events.push(`inject ${file} ${tab.label}`);
        if (options.failScriptOn === tab.label) {
          throw new Error("Frame with ID 0 was removed.");
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
      const isolatedWorld = new Function("window", "args", `return (${injection.func.toString()})(...args);`) as (
        scope: WindowScope,
        args: unknown[]
      ) => unknown;
      const result = isolatedWorld(tab.scope, structuredClone(injection.args ?? []));
      return [{ ...frame, result: structuredClone(result) }];
    }

    throw new Error("Either files or func must be specified");
  }

  const tabsCreate = vi.fn(async ({ url }: { url: string; active?: boolean }) => {
    const tab = openTempTab(url);
    events.push(`open ${tab.label}`);
    options.onTabCreated?.(tab, harness);
    return { id: tab.id, url, active: false, status: "loading" };
  });

  function finishLoading(tabId: number): void {
    const tab = requireTab(tabId);
    tab.status = "complete";
    for (const listener of [...updatedListeners]) {
      listener(tabId, { status: "complete" });
    }
  }

  const tabsRemove = vi.fn(async (tabId: number) => {
    const tab = requireTab(tabId);
    tabs.delete(tabId);
    events.push(`close ${tab.label}`);
    for (const listener of [...removedListeners]) {
      listener(tabId);
    }
  });

  const executeScript = vi.fn(async (injection: Injection) => runInjection(injection));

  const fetchMock = vi.fn(async (input: string) => {
    const host = new URL(input).hostname;
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
        const snapshot = { id: tab.id, url: tab.url, status: tab.status };
        events.push(`${tab.status === "complete" ? "ready" : "loading"} ${tab.label}`);
        if (tab.completeDuringStatusCheck) {
          finishLoading(tabId);
        }
        return snapshot;
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
          events.push(`progress ${payload.phase ?? "DONE"}${payload.currentMarketplace ? ` ${payload.currentMarketplace}` : ""}`);
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
    finishLoading,
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

function cacheKeyFor(targetMarkets: Marketplace[]): string {
  return buildComparisonCacheKey({
    asin: EXPECTED_SOURCE.asin,
    variationTokens: EXPECTED_SOURCE.variationTokens,
    sourceMarketplace: "US",
    destinationCountryCode: "US",
    targetMarkets
  });
}

function unversionedCacheKeyFor(targetMarkets: Marketplace[]): string {
  const value = [
    EXPECTED_SOURCE.asin,
    [...EXPECTED_SOURCE.variationTokens].sort().join("|"),
    "US",
    "US",
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

function removeElement(document: Document, selector: string): void {
  document.querySelector(selector)?.remove();
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
      prepare: (group, market, document) => {
        if (group === "search" && market === "FR") {
          removeElement(document, "[data-asin='B000000006']");
        }
        if (group === "product" && market === "JP") {
          setDeliveryCountry(document, "Japan");
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
        (progress) => progress.currentMarketplace === "JP" && progress.phase === "OPEN"
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

      expect(
        progress.map(({ completed, total, currentMarketplace, phase, results }) => ({
          completed,
          total,
          currentMarketplace,
          phase,
          results: results?.map((result) => result.marketplace)
        }))
      ).toEqual([
        { completed: 0, total: 2, currentMarketplace: "UK", phase: "OPEN", results: [] },
        { completed: 0, total: 2, currentMarketplace: "UK", phase: "SEARCH", results: [] },
        { completed: 0, total: 2, currentMarketplace: "UK", phase: "MATCH", results: [] },
        { completed: 0, total: 2, currentMarketplace: "UK", phase: "READ", results: [] },
        { completed: 1, total: 2, currentMarketplace: "DE", phase: "OPEN", results: ["UK"] },
        { completed: 1, total: 2, currentMarketplace: "DE", phase: "SEARCH", results: ["UK"] },
        { completed: 1, total: 2, currentMarketplace: "DE", phase: "MATCH", results: ["UK"] },
        { completed: 1, total: 2, currentMarketplace: "DE", phase: "READ", results: ["UK"] },
        { completed: 2, total: 2, currentMarketplace: undefined, phase: undefined, results: ["UK", "DE"] }
      ]);

      for (const entry of progress) {
        expect(entry).toMatchObject({ activeTabId: ACTIVE_TAB_ID, runId: "run-1", fxTable: EXPECTED_FX_TABLE });
      }

      const final = progress[progress.length - 1];
      expect(final).not.toHaveProperty("phase");
      expect(final).not.toHaveProperty("currentMarketplace");
      expect(progress[4].results?.[0].normalizedTotal).toEqual({ amount: 47.79, currency: "USD" });
      expect(final.results?.[1]).toEqual(EXPECTED_DE_RESULT);
    });

    it("emits each phase at the right point of the tab lifecycle", async () => {
      const harness = await bootServiceWorker({ enabledMarketplaces: ["US", "DE"] });

      await runViaWorker(harness);

      expect(harness.events).toEqual([
        "inject content/source-extractor.js source/US",
        "inject content/product-extractor.js source/US",
        "fx www.ecb.europa.eu",
        "progress OPEN DE",
        "open missing/DE",
        "ready missing/DE",
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
      expect(harness.events).toEqual([
        "inject content/source-extractor.js source/US",
        "inject content/product-extractor.js source/US",
        "fx www.ecb.europa.eu",
        "progress OPEN DE",
        "open product/DE",
        "ready product/DE",
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

      expect(progressPayloads(harness).map((progress) => [progress.currentMarketplace, progress.phase])).toEqual([
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
            tab.status = "loading";
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
            tab.status = "loading";
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

    it("ignores a comparison cached under the unversioned key of earlier builds", async () => {
      const harness = await bootServiceWorker({ enabledMarketplaces: ["US", "DE"] });
      const staleKey = unversionedCacheKeyFor(["DE"]);
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
            tab.status = "loading";
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

      expect(progressBeforeCancel.map((progress) => [progress.phase, progress.currentMarketplace])).toEqual([["OPEN", "DE"]]);
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
            tab.status = "loading";
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
      expect(progressPayloads(harness, "run-2").map((progress) => progress.phase)).toEqual(["OPEN"]);
      expect(harness.openTempTabs()).toEqual([]);
      expect(Object.keys(harness.storage).some((key) => key.startsWith("cmp:"))).toBe(false);
    });

    it("stops a run that is still going when a new run starts on the same tab", async () => {
      let held: FakeTab | undefined;
      const harness = await bootServiceWorker({
        enabledMarketplaces: ["US", "DE", "UK"],
        onTabCreated: (tab) => {
          if (!held) {
            tab.status = "loading";
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
    it("waits for a loading tab to report complete before reading it", async () => {
      const harness = await bootServiceWorker({
        enabledMarketplaces: ["US", "DE"],
        onTabCreated: (tab, self) => {
          tab.status = "loading";
          setTimeout(() => self.finishLoading(tab.id), 0);
        }
      });

      const payload = await runViaWorker(harness);

      expect(payload.results).toEqual([EXPECTED_DE_RESULT]);
      expect(harness.events.slice(harness.events.indexOf("open search/DE"), harness.events.indexOf("progress SEARCH DE") + 1)).toEqual([
        "open search/DE",
        "loading search/DE",
        "progress SEARCH DE"
      ]);
      expect(harness.tabListenerCount()).toBe(0);
    });

    it("reads a tab that finishes loading between the listener registration and the status check", async () => {
      const harness = await bootServiceWorker({
        enabledMarketplaces: ["US", "DE"],
        onTabCreated: (tab) => {
          tab.status = "loading";
          tab.completeDuringStatusCheck = true;
        }
      });

      const payload = await runViaWorker(harness);

      expect(payload.error).toBeUndefined();
      expect(payload.results).toEqual([EXPECTED_DE_RESULT]);
      expect(harness.events.filter((event) => event.startsWith("loading "))).toEqual([
        "loading missing/DE",
        "loading search/DE",
        "loading product/DE"
      ]);
      expect(harness.tabListenerCount()).toBe(0);
    });

    it("records a market whose tab is closed while loading as PARSE_FAILED without waiting for the timeout", async () => {
      let closedTabId: number | undefined;
      const harness = await bootServiceWorker({
        enabledMarketplaces: ["US", "DE", "UK"],
        onTabCreated: (tab, self) => {
          if (tab.label === "search/DE") {
            closedTabId = tab.id;
            tab.status = "loading";
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

    it("records a market whose page cannot be scripted as PARSE_FAILED, keeps going and closes its tab", async () => {
      const harness = await bootServiceWorker({ enabledMarketplaces: ["US", "DE", "UK"], failScriptOn: "search/DE" });

      const payload = await runViaWorker(harness);

      expect(payload.error).toBeUndefined();
      expect(payload.results.map((result) => [result.marketplace, result.status])).toEqual([
        ["UK", "OK"],
        ["DE", "PARSE_FAILED"]
      ]);
      expect(payload.results[1].notes).toEqual(["Frame with ID 0 was removed."]);
      expect(harness.events[harness.events.length - 1]).toBe("close search/DE");
      expect(harness.openTempTabs()).toEqual([]);
    });
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
