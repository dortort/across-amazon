import { expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { sortComparisonResults } from "../../src/shared/comparison";
import { MARKETPLACE_BY_CODE, MARKETPLACE_CODES } from "../../src/shared/markets";
import { LOAD_SOURCE, RUN_COMPARISON_PROGRESS, RUN_COMPARISON_RESULT } from "../../src/shared/messages";
import type {
  ComparisonPhase,
  ComparisonResult,
  ComparisonStatus,
  ExtensionSettings,
  FxTable,
  LoadSourcePayload,
  Marketplace,
  Money,
  RunComparisonProgressPayload,
  RunComparisonResultPayload,
  SourceContext
} from "../../src/shared/types";

export const NBSP = " ";
export const MINUS = "−";
export const SETTINGS_KEY = "settings:v1";
export const ACTIVE_TAB_ID = 42;
export const GENERATED_AT = "2026-07-30T09:00:00.000Z";
export const PHASES: ComparisonPhase[] = ["OPEN", "SEARCH", "MATCH", "READ"];
export const IMAGE_HOST = "https://m.media-amazon.com";

export const fxTable: FxTable = {
  base: "EUR",
  date: "2026-07-30",
  rates: { EUR: 1, USD: 1.08, GBP: 0.852, CAD: 1.475, AUD: 1.655, JPY: 155.52, MXN: 19.46 },
  source: "ECB"
};

export function money(amount: number, currency: string): Money {
  return { amount, currency };
}

export function productUrl(marketplace: Marketplace): string {
  return `https://${MARKETPLACE_BY_CODE[marketplace].domain}/dp/B09XS7JWHH`;
}

export const source: SourceContext = {
  marketplace: "US",
  asin: "B09XS7JWHH",
  title: "Sony WH-1000XM5 Wireless Noise Canceling Headphones",
  brand: "Sony",
  variationTokens: ["black"],
  destinationCountryCode: "US",
  sourceUrl: productUrl("US"),
  imageUrl: `${IMAGE_HOST}/images/I/sony-wh1000xm5.jpg`
};

function okResult(
  marketplace: Marketplace,
  costs: [item: number, shipping: number, importFees: number],
  confidence: number,
  normalizedUsd: number,
  notes: string[]
): ComparisonResult {
  const currency = MARKETPLACE_BY_CODE[marketplace].currency;
  const [item, shipping, importFees] = costs;
  return {
    marketplace,
    status: "OK",
    confidence,
    productUrl: productUrl(marketplace),
    breakdown: {
      item: money(item, currency),
      shipping: money(shipping, currency),
      importFees: money(importFees, currency)
    },
    normalizedTotal: money(normalizedUsd, "USD"),
    notes
  };
}

function failedResult(
  marketplace: Marketplace,
  status: Exclude<ComparisonStatus, "OK">,
  confidence: number,
  notes: string[]
): ComparisonResult {
  return { marketplace, status, confidence, notes };
}

export const baseline: ComparisonResult = {
  ...okResult("US", [399.99, 0, 0], 1, 399.99, ["The page you are on. Everything else is measured against this."]),
  productUrl: source.sourceUrl
};

export const cheapBaseline: ComparisonResult = {
  ...okResult("US", [299.99, 0, 0], 1, 299.99, ["The page you are on. Everything else is measured against this."]),
  productUrl: source.sourceUrl
};

export const de = okResult("DE", [279.0, 12.99, 31.2], 0.91, 349.05, [
  "Match confidence: HIGH",
  "Import fees deposit quoted on the product page. Delivery 6–10 days."
]);
export const it_ = okResult("IT", [289.9, 14.5, 30.2], 0.76, 361.37, [
  "Match confidence: MEDIUM",
  "Colour is not stated in the listing title — confirm it is the black variant before buying."
]);
export const uk = okResult("UK", [259.0, 9.99, 24.6], 0.94, 372.16, [
  "Import fees deposit quoted. Sold and shipped by Amazon UK."
]);
export const ca = okResult("CA", [479.99, 12.99, 41.62], 0.97, 391.44, [
  "Duties collected at checkout. Delivery 4–7 days."
]);
export const au = okResult("AU", [599.0, 19.95, 53.35], 0.9, 438.72, ["GST included in the quoted import estimate."]);
export const jp = failedResult("JP", "DESTINATION_MISMATCH", 0.93, [
  "Match found, but the seller does not ship to the United States."
]);
export const fr = failedResult("FR", "UNAVAILABLE", 0.9, ["Out of stock — no delivery date offered."]);
export const es = failedResult("ES", "PARSE_FAILED", 0.89, [
  "Import fees are only revealed at checkout, so the delivered total cannot be quoted."
]);
export const mx = failedResult("MX", "NO_CONFIDENT_MATCH", 0.31, [
  "Closest listing scored 31% — below the confidence floor."
]);

export const mockupResults: ComparisonResult[] = sortComparisonResults([ca, mx, uk, de, fr, it_, es, jp, au]);

export const DEFAULT_SETTINGS: ExtensionSettings = {
  enabledMarketplaces: [...MARKETPLACE_CODES],
  comparisonCurrency: "SOURCE",
  disclosureAcknowledged: false
};

export const FX_FAILURE = "Unable to load FX reference rates from ECB or Frankfurter";
export const CANCELLED = "Comparison cancelled by user";

export interface Scenario {
  source?: SourceContext;
  baseline?: ComparisonResult;
  results: ComparisonResult[];
  fxTable?: FxTable;
  generatedAt: string;
  error?: string;
  loadSourceError?: string;
  activeTabId: number | null;
  settings?: Partial<ExtensionSettings>;
  stepMs?: number;
}

export function scenario(overrides: Partial<Scenario> = {}): Scenario {
  return {
    source,
    baseline,
    results: mockupResults,
    fxTable,
    generatedAt: GENERATED_AT,
    activeTabId: ACTIVE_TAB_ID,
    ...overrides
  };
}

export function loadSourcePayload(scn: Scenario): LoadSourcePayload {
  return scn.loadSourceError ? { error: scn.loadSourceError } : { source: scn.source, baseline: scn.baseline };
}

export function resultPayload(scn: Scenario): RunComparisonResultPayload {
  return {
    source: scn.source,
    baseline: scn.baseline,
    results: scn.results,
    generatedAt: scn.generatedAt,
    fxTable: scn.fxTable,
    error: scn.error
  };
}

export function targetsOf(scn: Scenario): Marketplace[] {
  const enabled = scn.settings?.enabledMarketplaces ?? DEFAULT_SETTINGS.enabledMarketplaces;
  return enabled.filter((market) => market !== scn.source?.marketplace);
}

export function progressSteps(scn: Scenario): RunComparisonProgressPayload[] {
  const targets = targetsOf(scn);
  const total = targets.length;
  const finished: ComparisonResult[] = [];
  const steps: RunComparisonProgressPayload[] = [];

  targets.forEach((market, completed) => {
    for (const phase of PHASES) {
      steps.push({ completed, total, currentMarketplace: market, phase, results: sortComparisonResults(finished) });
    }
    const result = scn.results.find((candidate) => candidate.marketplace === market);
    if (result) {
      finished.push(result);
    }
  });

  steps.push({ completed: total, total, results: sortComparisonResults(finished) });
  return steps;
}

export function progressStep(
  scn: Scenario,
  market: Marketplace,
  phase: ComparisonPhase
): RunComparisonProgressPayload {
  const step = progressSteps(scn).find(
    (candidate) => candidate.currentMarketplace === market && candidate.phase === phase
  );
  if (!step) {
    throw new Error(`${market} is not a target of this scenario`);
  }
  return step;
}

export function finalStep(scn: Scenario): RunComparisonProgressPayload {
  const steps = progressSteps(scn);
  return steps[steps.length - 1];
}

export interface SentMessage {
  type: string;
  payload?: unknown;
}

export interface AaControl {
  openedUrls: string[];
  sentMessages: SentMessage[];
  emitted: SentMessage[];
  store: Record<string, unknown>;
  listenerCount: () => number;
  emit: (message: unknown) => void;
}

declare global {
  interface Window {
    __aa: AaControl;
  }
}

interface MockConfig {
  activeTabId: number | null;
  loadSourceResponse: LoadSourcePayload;
  store: Record<string, unknown>;
  autoplay: { stepMs: number; messages: SentMessage[] } | null;
}

function mockConfig(scn: Scenario): MockConfig {
  const messages: SentMessage[] = [
    ...progressSteps(scn).map((payload) => ({ type: RUN_COMPARISON_PROGRESS, payload })),
    { type: RUN_COMPARISON_RESULT, payload: resultPayload(scn) }
  ];
  return {
    activeTabId: scn.activeTabId,
    loadSourceResponse: loadSourcePayload(scn),
    store: scn.settings ? { [SETTINGS_KEY]: { ...DEFAULT_SETTINGS, ...scn.settings } } : {},
    autoplay: scn.stepMs === undefined ? null : { stepMs: scn.stepMs, messages }
  };
}

function mockChrome(config: MockConfig): void {
  type Listener = (message: unknown, sender: { id: string }, sendResponse: () => void) => void;
  const listeners: Listener[] = [];
  const timers: number[] = [];
  const clone = <T>(value: T): T => (value === undefined ? value : JSON.parse(JSON.stringify(value)));
  const store: Record<string, unknown> = clone(config.store);

  const control: AaControl = {
    openedUrls: [],
    sentMessages: [],
    emitted: [],
    store,
    listenerCount: () => listeners.length,
    emit: (message) => {
      control.emitted.push(clone(message) as SentMessage);
      [...listeners].forEach((listener) => listener(clone(message), { id: "across-amazon" }, () => undefined));
    }
  };

  const play = (): void => {
    const autoplay = config.autoplay;
    if (!autoplay) {
      return;
    }
    autoplay.messages.forEach((message, index) => {
      timers.push(window.setTimeout(() => control.emit(message), autoplay.stepMs * (index + 1)));
    });
  };

  const stop = (): void => {
    timers.splice(0).forEach((timer) => window.clearTimeout(timer));
  };

  const readKeys = (keys: string | string[] | null | undefined): Record<string, unknown> => {
    const wanted = keys === null || keys === undefined ? Object.keys(store) : Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(wanted.filter((key) => key in store).map((key) => [key, clone(store[key])]));
  };

  Object.defineProperty(window, "__aa", { configurable: true, value: control });
  Object.defineProperty(window, "chrome", {
    configurable: true,
    writable: true,
    value: {
      tabs: {
        query: async () => (config.activeTabId === null ? [] : [{ id: config.activeTabId, active: true }]),
        create: async (properties: { url?: string; active?: boolean }) => {
          control.openedUrls.push(properties.url ?? "");
          return { id: 99, ...properties };
        }
      },
      storage: {
        local: {
          get: async (keys?: string | string[] | null) => readKeys(keys),
          set: async (items: Record<string, unknown>) => {
            Object.assign(store, clone(items));
          },
          remove: async (keys: string | string[]) => {
            (Array.isArray(keys) ? keys : [keys]).forEach((key) => delete store[key]);
          }
        }
      },
      runtime: {
        id: "across-amazon",
        onMessage: {
          addListener: (listener: Listener) => {
            listeners.push(listener);
          },
          removeListener: (listener: Listener) => {
            const index = listeners.indexOf(listener);
            if (index >= 0) {
              listeners.splice(index, 1);
            }
          },
          hasListener: (listener: Listener) => listeners.includes(listener)
        },
        sendMessage: async (message: SentMessage) => {
          control.sentMessages.push(clone(message));
          switch (message.type) {
            case "LOAD_SOURCE":
              return clone(config.loadSourceResponse);
            case "RUN_COMPARISON":
              stop();
              play();
              return { ok: true };
            case "CANCEL_COMPARISON":
              stop();
              return { ok: true };
            default:
              return { ok: true };
          }
        }
      }
    }
  });
}

const THUMBNAIL_SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120">',
  '<rect width="120" height="120" fill="#eef1f0"/>',
  '<path d="M30 72a30 30 0 0 1 60 0" fill="none" stroke="#2f3a37" stroke-width="8"/>',
  '<rect x="22" y="66" width="16" height="30" rx="6" fill="#2f3a37"/>',
  '<rect x="82" y="66" width="16" height="30" rx="6" fill="#2f3a37"/>',
  "</svg>"
].join("");

export async function installChromeMock(page: Page, scn: Scenario): Promise<void> {
  await page.route(`${IMAGE_HOST}/**`, (route) =>
    route.fulfill({ status: 200, contentType: "image/svg+xml", body: THUMBNAIL_SVG })
  );
  await page.addInitScript(mockChrome, mockConfig(scn));
}

export async function openPopup(page: Page, scn: Scenario = scenario()): Promise<void> {
  await installChromeMock(page, scn);
  await page.goto("/popup.html");
  await page.waitForFunction(() => window.__aa.listenerCount() > 0);
  if (scn.activeTabId !== null) {
    await expect.poll(() => sentTypes(page)).toContain(LOAD_SOURCE);
  }
}

export async function emit(page: Page, message: SentMessage): Promise<void> {
  await page.evaluate(async (payload) => {
    window.__aa.emit(payload);
    await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
  }, message);
}

export function emitProgress(page: Page, payload: RunComparisonProgressPayload): Promise<void> {
  return emit(page, { type: RUN_COMPARISON_PROGRESS, payload });
}

export function emitResult(page: Page, payload: RunComparisonResultPayload): Promise<void> {
  return emit(page, { type: RUN_COMPARISON_RESULT, payload });
}

export function sentMessages(page: Page, type?: string): Promise<SentMessage[]> {
  return page.evaluate(
    (wanted) => window.__aa.sentMessages.filter((message) => wanted === null || message.type === wanted),
    type ?? null
  );
}

export async function sentTypes(page: Page): Promise<string[]> {
  return (await sentMessages(page)).map((message) => message.type);
}

export function emittedTypes(page: Page): Promise<string[]> {
  return page.evaluate(() => window.__aa.emitted.map((message) => message.type));
}

export function openedUrls(page: Page): Promise<string[]> {
  return page.evaluate(() => [...window.__aa.openedUrls]);
}

export function storedSettings(page: Page): Promise<unknown> {
  return page.evaluate((key) => window.__aa.store[key], SETTINGS_KEY);
}

export function runButton(page: Page): Locator {
  return page.getByRole("button", { name: /^Check \d+ other Amazons?$/ });
}

export function listRows(page: Page): Locator {
  return page.locator(".dB-list").getByRole("button");
}

export function listRow(page: Page, marketName: string): Locator {
  return listRows(page).filter({ hasText: marketName });
}

export function verdictCard(page: Page): Locator {
  return page.locator(".dB-verdict");
}

export function toast(page: Page): Locator {
  return page.getByRole("status");
}

export async function startRun(page: Page): Promise<void> {
  await runButton(page).click();
  await expect(page.getByRole("button", { name: "Stop checking" })).toBeVisible();
}

export async function completeRun(page: Page, scn: Scenario = scenario()): Promise<void> {
  await startRun(page);
  await emitResult(page, resultPayload(scn));
  await expect(page.getByRole("button", { name: "Check again" })).toBeVisible();
}
