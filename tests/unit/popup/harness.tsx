import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { App } from "../../../src/popup/App";
import {
  CANCEL_COMPARISON,
  LOAD_SOURCE,
  RUN_COMPARISON,
  RUN_COMPARISON_PROGRESS,
  RUN_COMPARISON_RESULT
} from "../../../src/shared/messages";
import { MARKETPLACE_BY_CODE, MARKETPLACE_CODES } from "../../../src/shared/markets";
import type {
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
} from "../../../src/shared/types";

export const NBSP = " ";
export const MINUS = "−";
export const SETTINGS_KEY = "settings:v1";
export const ACTIVE_TAB_ID = 42;

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
  imageUrl: "https://m.media-amazon.com/images/I/sony-wh1000xm5.jpg"
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

export const mockupResults: ComparisonResult[] = [ca, mx, uk, de, fr, it_, es, jp, au];

export const TARGET_ORDER: Marketplace[] = ["CA", "MX", "UK", "DE", "FR", "IT", "ES", "JP", "AU"];

export function resultPayload(overrides: Partial<RunComparisonResultPayload> = {}): RunComparisonResultPayload {
  return {
    source,
    baseline,
    results: mockupResults,
    generatedAt: "2026-07-30T09:00:00.000Z",
    fxTable,
    ...overrides
  };
}

export const DEFAULT_SETTINGS: ExtensionSettings = {
  enabledMarketplaces: [...MARKETPLACE_CODES],
  comparisonCurrency: "SOURCE",
  disclosureAcknowledged: false
};

export interface ChromeMockOptions {
  loadSource?: LoadSourcePayload;
  tabs?: Array<{ id?: number }>;
  settings?: Partial<ExtensionSettings>;
  withStorage?: boolean;
}

type Listener = (message: unknown) => void;

export function installChrome(options: ChromeMockOptions = {}) {
  const listeners = new Set<Listener>();
  const store: Record<string, unknown> = options.settings
    ? { [SETTINGS_KEY]: { ...DEFAULT_SETTINGS, ...options.settings } }
    : {};

  const sendMessage = vi.fn(async (message: { type: string }) =>
    message.type === LOAD_SOURCE ? (options.loadSource ?? { source, baseline }) : { ok: true }
  );
  const query = vi.fn(async () => options.tabs ?? [{ id: ACTIVE_TAB_ID }]);
  const create = vi.fn(async (properties: { url?: string; active?: boolean }) => ({ id: 99, ...properties }));
  const get = vi.fn(async (key: string) => ({ [key]: store[key] }));
  const set = vi.fn(async (items: Record<string, unknown>) => {
    Object.assign(store, items);
  });
  const addListener = vi.fn((listener: Listener) => {
    listeners.add(listener);
  });
  const removeListener = vi.fn((listener: Listener) => {
    listeners.delete(listener);
  });

  vi.stubGlobal("chrome", {
    tabs: { query, create },
    runtime: { sendMessage, onMessage: { addListener, removeListener } },
    ...(options.withStorage === false ? {} : { storage: { local: { get, set } } })
  });

  const emit = (message: unknown): void => {
    act(() => {
      listeners.forEach((listener) => listener(message));
    });
  };

  const sentOfType = (type: string): unknown[] =>
    sendMessage.mock.calls.map(([message]) => message).filter((message) => message.type === type);

  return {
    store,
    listeners,
    sendMessage,
    query,
    create,
    get,
    set,
    addListener,
    removeListener,
    sentOfType,
    runRequests: () => sentOfType(RUN_COMPARISON),
    cancelRequests: () => sentOfType(CANCEL_COMPARISON),
    progress: (payload: RunComparisonProgressPayload) => emit({ type: RUN_COMPARISON_PROGRESS, payload }),
    result: (payload: RunComparisonResultPayload) => emit({ type: RUN_COMPARISON_RESULT, payload })
  };
}

export function renderApp(options: ChromeMockOptions = {}) {
  const chromeMock = installChrome(options);
  const user = userEvent.setup();
  const view = render(<App />);
  return { ...chromeMock, ...view, user };
}

export async function renderLoaded(options: ChromeMockOptions = {}) {
  const app = renderApp(options);
  await screen.findByRole("heading", { name: (options.loadSource?.source ?? source).title });
  return app;
}

export async function renderRunning(options: ChromeMockOptions = {}) {
  const app = await renderLoaded(options);
  await app.user.click(screen.getByRole("button", { name: /^Check \d+ other Amazons?$/ }));
  return app;
}

export async function renderDone(
  payload: RunComparisonResultPayload = resultPayload(),
  options: ChromeMockOptions = {}
) {
  const app = await renderRunning(options);
  app.result(payload);
  return app;
}

export function rowElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(".dB-list .dB-row"));
}

export function rowSummary(row: HTMLElement) {
  return {
    name: row.querySelector(".who strong")?.firstChild?.textContent,
    local: row.querySelector(".who > span")?.textContent,
    total: row.querySelector(".amt strong")?.textContent,
    delta: row.querySelector(".amt > span")?.textContent,
    deltaClass: row.querySelector(".amt > span")?.className,
    best: row.classList.contains("best"),
    pill: row.querySelector(".dB-flag-pill")?.textContent ?? null
  };
}
