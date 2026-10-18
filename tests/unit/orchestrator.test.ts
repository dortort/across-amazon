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

const EXPECTED_BASELINE: ComparisonResult = {
  marketplace: "US",
  status: "OK",
  confidence: 1,
  productUrl: SOURCE_URL,
  breakdown: {
    item: { amount: 49.99, currency: "USD" },
    shipping: { amount: 0, currency: "USD" },
    importFees: { amount: 0, currency: "USD" }
  },
  notes: ["Import fees not displayed for destination"],
  normalizedTotal: { amount: 49.99, currency: "USD" }
};

const EXPECTED_DE_RESULT: ComparisonResult = {
  marketplace: "DE",
  status: "OK",
  confidence: 0.88,
  productUrl: "https://www.amazon.de/dp/B000000005",
  breakdown: {
    item: { amount: 37.2, currency: "EUR" },
    shipping: { amount: 4.5, currency: "EUR" },
    importFees: { amount: 3.2, currency: "EUR" },
    totalDisplayed: { amount: 37.2, currency: "EUR" }
  },
  notes: ["Match confidence: MEDIUM"],
  normalizedTotal: { amount: 40.18, currency: "USD" }
};

type FixtureGroup = "source" | "search" | "product";
type WindowScope = Record<string, unknown>;
type Prepare = (group: FixtureGroup, market: Marketplace, document: Document) => void;
type SendResponse = (response?: unknown) => void;
type MessageListener = (message: unknown, sender: unknown, sendResponse: SendResponse) => boolean;

interface FakeTab {
  id: number;
  url: string;
  label: string;
  dom: JSDOM;
  scope: WindowScope;
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
  onTabCreated?: (tab: FakeTab, harness: Harness) => void;
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
  dispatch: (message: unknown) => Promise<unknown>;
}

function setDeliveryCountry(document: Document, country: string): void {
  const line = document.querySelector("#glow-ingress-line2");
  if (line) {
    line.textContent = `Deliver to ${country}`;
  }
}

function loadFixtureDom(group: FixtureGroup, market: Marketplace, url: string, prepare?: Prepare): JSDOM {
  const html = readFileSync(join(FIXTURE_ROOT, group, `${market}.html`), "utf8");
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
  let nextTabId = 100;

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
    tabs.set(ACTIVE_TAB_ID, { id: ACTIVE_TAB_ID, url, label, dom, scope: {} });
  }

  function openTempTab(url: string): FakeTab {
    const parsed = new URL(url);
    const market = getMarketplaceByDomain(parsed.hostname);
    if (!market) {
      throw new Error(`No fixture for ${url}`);
    }
    const group: FixtureGroup = parsed.pathname === "/s" ? "search" : "product";
    const tab: FakeTab = {
      id: nextTabId,
      url,
      label: `${group}/${market}`,
      dom: loadFixtureDom(group, market, url, options.prepare),
      scope: {}
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

  const tabsRemove = vi.fn(async (tabId: number) => {
    const tab = requireTab(tabId);
    tabs.delete(tabId);
    events.push(`close ${tab.label}`);
  });

  const executeScript = vi.fn(async (injection: Injection) => runInjection(injection));

  const fetchMock = vi.fn(async (input: string) => {
    const host = new URL(input).hostname;
    events.push(`fx ${host}`);
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
        events.push(`ready ${tab.label}`);
        return { id: tab.id, url: tab.url, status: "complete" };
      }),
      remove: tabsRemove,
      onUpdated: {
        addListener: vi.fn(),
        removeListener: vi.fn()
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

async function runViaWorker(harness: Harness): Promise<RunComparisonResultPayload> {
  const response = await harness.dispatch({ type: RUN_COMPARISON, payload: { activeTabId: ACTIVE_TAB_ID } });
  expect(response).toEqual({ ok: true });
  const resultMessages = harness.messages.filter((message) => message.type === RUN_COMPARISON_RESULT);
  return resultMessages[resultMessages.length - 1].payload as RunComparisonResultPayload;
}

function progressPayloads(harness: Harness): RunComparisonProgressPayload[] {
  return harness.messages
    .filter((message) => message.type === RUN_COMPARISON_PROGRESS)
    .map((message) => message.payload as RunComparisonProgressPayload);
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

function removeElement(document: Document, selector: string): void {
  document.querySelector(selector)?.remove();
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("background orchestrator", () => {
  describe("full run", () => {
    const fullRunOptions: HarnessOptions = {
      enabledMarketplaces: ["US", "UK", "DE", "FR", "IT", "ES", "JP"],
      prepare: (group, market, document) => {
        if (group === "search" && market === "FR") {
          removeElement(document, "[data-asin='B000000006']");
        }
        if (group === "product" && market === "JP") {
          setDeliveryCountry(document, "Japan");
        }
      }
    };

    it("LOAD_SOURCE returns the source context with its image and a normalized baseline without opening tabs", async () => {
      const harness = await bootServiceWorker(fullRunOptions);

      const response = await loadSourceViaWorker(harness);

      expect(response).toEqual({ source: EXPECTED_SOURCE, baseline: EXPECTED_BASELINE });
      expect(harness.tabsCreate).not.toHaveBeenCalled();
      expect(harness.events.filter((event) => event.startsWith("inject"))).toEqual([
        "inject content/source-extractor.js source/US",
        "inject content/product-extractor.js source/US"
      ]);
    });

    it("compares every enabled market and returns sorted, normalized results with the baseline and FX table", async () => {
      const harness = await bootServiceWorker(fullRunOptions);

      const payload = await runViaWorker(harness);

      expect(payload.error).toBeUndefined();
      expect(payload.source).toEqual(EXPECTED_SOURCE);
      expect(payload.baseline).toEqual(EXPECTED_BASELINE);
      expect(payload.fxTable).toEqual(EXPECTED_FX_TABLE);
      expect(payload.results.map((result) => [result.marketplace, result.status, result.normalizedTotal?.amount])).toEqual([
        ["ES", "OK", 38.66],
        ["IT", "OK", 39.85],
        ["DE", "OK", 40.18],
        ["UK", "OK", 41.2],
        ["FR", "NO_CONFIDENT_MATCH", undefined],
        ["JP", "DESTINATION_MISMATCH", undefined]
      ]);
      expect(payload.results.find((result) => result.marketplace === "DE")).toEqual(EXPECTED_DE_RESULT);

      for (const result of payload.results.filter((entry) => entry.status === "OK")) {
        expect(result.normalizedTotal?.currency).toBe("USD");
      }

      expect(payload.results.find((result) => result.marketplace === "JP")).toEqual({
        marketplace: "JP",
        status: "DESTINATION_MISMATCH",
        confidence: 0.86,
        productUrl: "https://www.amazon.co.jp/dp/B000000009",
        notes: ["Destination mismatch detected (JP)", "Destination on product page does not match source destination"]
      });
      expect(harness.events).not.toContain("open product/FR");
      expect(harness.openTempTabs()).toEqual([]);

      const jpOpen = progressPayloads(harness).find(
        (progress) => progress.currentMarketplace === "JP" && progress.phase === "OPEN"
      );
      expect(jpOpen?.completed).toBe(5);
      expect(jpOpen?.results?.map((result) => result.marketplace)).toEqual(["ES", "IT", "DE", "UK", "FR"]);
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
        { completed: 2, total: 2, currentMarketplace: undefined, phase: undefined, results: ["DE", "UK"] }
      ]);

      const final = progress[progress.length - 1];
      expect(final).not.toHaveProperty("phase");
      expect(final).not.toHaveProperty("currentMarketplace");
      expect(progress[4].results?.[0].normalizedTotal).toEqual({ amount: 41.2, currency: "USD" });
      expect(final.results?.[0]).toEqual(EXPECTED_DE_RESULT);
    });

    it("emits each phase at the right point of the tab lifecycle", async () => {
      const harness = await bootServiceWorker({ enabledMarketplaces: ["US", "DE"] });

      await runViaWorker(harness);

      expect(harness.events).toEqual([
        "inject content/source-extractor.js source/US",
        "inject content/product-extractor.js source/US",
        "fx www.ecb.europa.eu",
        "progress OPEN DE",
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

  describe("cache", () => {
    it("answers a repeat run from the cache with the baseline and FX table and opens no tabs", async () => {
      const harness = await bootServiceWorker({ enabledMarketplaces: ["US", "UK", "DE"] });
      const first = await runViaWorker(harness);

      harness.tabsCreate.mockClear();
      harness.executeScript.mockClear();
      harness.fetch.mockClear();
      const progressBefore = progressPayloads(harness).length;

      const second = await runViaWorker(harness);

      expect(second).toEqual(first);
      expect(second.baseline).toEqual(EXPECTED_BASELINE);
      expect(second.fxTable).toEqual(EXPECTED_FX_TABLE);
      expect(harness.tabsCreate).not.toHaveBeenCalled();
      expect(harness.fetch).not.toHaveBeenCalled();
      expect(harness.executeScript.mock.calls.flatMap(([injection]) => (injection as Injection).files ?? [])).toEqual([
        "content/source-extractor.js"
      ]);
      expect(progressPayloads(harness)).toHaveLength(progressBefore);
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
    it("stops mid-run, closes the open temp tab and returns partial results with source, baseline and FX", async () => {
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
      expect(payload.error).toBe("Comparison cancelled by user");
      expect(payload.results).toEqual([EXPECTED_DE_RESULT]);
      expect(payload.source).toEqual(EXPECTED_SOURCE);
      expect(payload.baseline).toEqual(EXPECTED_BASELINE);
      expect(payload.fxTable).toEqual(EXPECTED_FX_TABLE);

      expect(harness.events.slice(harness.events.indexOf("open search/UK"))).toEqual([
        "open search/UK",
        "ready search/UK",
        "close search/UK"
      ]);
      expect(harness.openTempTabs()).toEqual([]);
      expect(Object.keys(harness.storage).some((key) => key.startsWith("cmp:"))).toBe(false);
    });
  });

  describe("failures", () => {
    it("fails before opening any tab when FX rates cannot be loaded", async () => {
      const harness = await bootServiceWorker({ enabledMarketplaces: ["US", "UK", "DE"], fxAvailable: false });

      const payload = await runViaWorker(harness);

      expect(payload.error).toBe("Unable to load FX reference rates from ECB or Frankfurter");
      expect(payload.results).toEqual([]);
      expect(payload.source).toEqual(EXPECTED_SOURCE);
      expect(payload.baseline).toEqual({ ...EXPECTED_BASELINE, normalizedTotal: undefined });
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

    it("LOAD_SOURCE still returns the source and raw baseline when FX rates are unavailable", async () => {
      const harness = await bootServiceWorker({ fxAvailable: false });

      const response = await loadSourceViaWorker(harness);

      expect(response.error).toBeUndefined();
      expect(response.source).toEqual(EXPECTED_SOURCE);
      expect(response.baseline).toEqual({ ...EXPECTED_BASELINE, normalizedTotal: undefined });
      expect(response.baseline).not.toHaveProperty("normalizedTotal");
    });

    it("normalizes the baseline and results into a fixed comparison currency", async () => {
      const harness = await bootServiceWorker({ enabledMarketplaces: ["US", "UK", "DE"], comparisonCurrency: "EUR" });

      const loaded = await loadSourceViaWorker(harness);
      const payload = await runViaWorker(harness);

      expect(loaded.baseline?.normalizedTotal).toEqual({ amount: 46.29, currency: "EUR" });
      expect(payload.baseline?.normalizedTotal).toEqual({ amount: 46.29, currency: "EUR" });
      expect(payload.results.map((result) => [result.marketplace, result.normalizedTotal])).toEqual([
        ["DE", { amount: 37.2, currency: "EUR" }],
        ["UK", { amount: 38.15, currency: "EUR" }]
      ]);
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
