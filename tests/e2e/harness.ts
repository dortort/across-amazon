import { expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { sortComparisonResults } from "../../src/shared/comparison";
import { MARKET_CONCURRENCY } from "../../src/shared/markets";
import {
  CANCEL_COMPARISON,
  LOAD_SOURCE,
  RUN_COMPARISON,
  RUN_COMPARISON_PROGRESS,
  RUN_COMPARISON_RESULT
} from "../../src/shared/messages";
import type {
  ComparisonPhase,
  ComparisonResult,
  ExtensionSettings,
  FxTable,
  LoadSourcePayload,
  MarketProgress,
  Marketplace,
  RunComparisonProgressPayload,
  RunComparisonResultPayload,
  SourceContext
} from "../../src/shared/types";
import {
  ACTIVE_TAB_ID,
  DEFAULT_SETTINGS,
  GENERATED_AT,
  IMAGE_HOST,
  SETTINGS_KEY,
  baseline,
  fxTable,
  mockupResults,
  source
} from "../fixtures/popup";

export {
  ACTIVE_TAB_ID,
  DEFAULT_SETTINGS,
  GENERATED_AT,
  IMAGE_HOST,
  MINUS,
  NBSP,
  SETTINGS_KEY,
  TARGET_ORDER,
  au,
  baseline,
  ca,
  cheapBaseline,
  de,
  es,
  fr,
  fxTable,
  it_,
  jp,
  money,
  mx,
  productUrl,
  source,
  uk
} from "../fixtures/popup";

export const PHASES: ComparisonPhase[] = ["OPEN", "SEARCH", "MATCH", "READ"];
export const FX_FAILURE = "Unable to load FX reference rates from ECB or Frankfurter";
export const CANCELLED = "Comparison cancelled by user";
export const BACKGROUND_UNREACHABLE = "Could not reach the background service";
export const LOADING_HINT = "Reading this page…";
export const OTHER_TAB_ID = 7;
export const NON_AMAZON_URL = "https://www.example.com/sony-wh-1000xm5";
export const AMAZON_NON_PRODUCT_URL = "https://www.amazon.com/gp/cart/view.html";
export const EXTRACTION_FAILURE = "Unable to extract required source product metadata";

export const sortedResults: ComparisonResult[] = sortComparisonResults(mockupResults);

export interface Scenario {
  source?: SourceContext;
  baseline?: ComparisonResult;
  results: ComparisonResult[];
  fxTable?: FxTable;
  generatedAt: string;
  error?: string;
  loadSourceError?: string;
  holdLoadSource?: boolean;
  activeTabId: number | null;
  tabUrl?: string;
  settings?: Partial<ExtensionSettings>;
  stepMs?: number;
}

export function scenario(overrides: Partial<Scenario> = {}): Scenario {
  return {
    source,
    baseline,
    results: sortedResults,
    fxTable,
    generatedAt: GENERATED_AT,
    activeTabId: ACTIVE_TAB_ID,
    tabUrl: source.sourceUrl,
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
  let completed = 0;

  for (let start = 0; start < total; start += MARKET_CONCURRENCY) {
    const round = targets.slice(start, start + MARKET_CONCURRENCY);
    let inFlight: MarketProgress[] = [];
    for (const phase of PHASES) {
      for (const market of round) {
        const latest = { marketplace: market, phase };
        inFlight =
          phase === "OPEN"
            ? [...inFlight, latest]
            : inFlight.map((entry) => (entry.marketplace === market ? latest : entry));
        steps.push({
          completed,
          total,
          inFlight,
          latest,
          results: sortComparisonResults(finished),
          fxTable: scn.fxTable
        });
      }
    }
    for (const market of round) {
      completed += 1;
      const result = scn.results.find((candidate) => candidate.marketplace === market);
      if (result) {
        finished.push(result);
      }
      inFlight = inFlight.filter((entry) => entry.marketplace !== market);
      if (completed < total) {
        steps.push({ completed, total, inFlight, results: sortComparisonResults(finished), fxTable: scn.fxTable });
      }
    }
  }

  steps.push({ completed: total, total, inFlight: [], results: sortComparisonResults(finished), fxTable: scn.fxTable });
  return steps;
}

export function progressStep(
  scn: Scenario,
  market: Marketplace,
  phase: ComparisonPhase
): RunComparisonProgressPayload {
  const step = progressSteps(scn).find(
    (candidate) => candidate.latest?.marketplace === market && candidate.latest.phase === phase
  );
  if (!step) {
    throw new Error(`${market} is not a target of this scenario`);
  }
  return step;
}

export function finishedStep(scn: Scenario, market: Marketplace): RunComparisonProgressPayload {
  const completed = targetsOf(scn).indexOf(market) + 1;
  const step = progressSteps(scn).find((candidate) => !candidate.latest && candidate.completed === completed);
  if (completed === 0 || !step) {
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

export interface RunRequest {
  activeTabId: number;
  runId?: string;
}

export type RunFailure = "reject" | "no-response";

export interface AaControl {
  openedUrls: string[];
  sentMessages: SentMessage[];
  emitted: SentMessage[];
  store: Record<string, unknown>;
  listenerCount: () => number;
  emit: (message: SentMessage) => void;
  failRun: (failure: RunFailure) => void;
  releaseLoadSource: () => void;
}

declare global {
  interface Window {
    __aa: AaControl;
  }
}

interface MockConfig {
  types: {
    load: string;
    run: string;
    cancel: string;
    progress: string;
    result: string;
  };
  tab: { id: number; url?: string } | null;
  loadSourceResponse: LoadSourcePayload;
  holdLoadSource: boolean;
  store: Record<string, unknown>;
  autoplay: { stepMs: number; messages: SentMessage[] } | null;
}

function mockConfig(scn: Scenario): MockConfig {
  const messages: SentMessage[] = [
    ...progressSteps(scn).map((payload) => ({ type: RUN_COMPARISON_PROGRESS, payload })),
    { type: RUN_COMPARISON_RESULT, payload: resultPayload(scn) }
  ];
  return {
    types: {
      load: LOAD_SOURCE,
      run: RUN_COMPARISON,
      cancel: CANCEL_COMPARISON,
      progress: RUN_COMPARISON_PROGRESS,
      result: RUN_COMPARISON_RESULT
    },
    tab: scn.activeTabId === null ? null : { id: scn.activeTabId, url: scn.tabUrl },
    loadSourceResponse: loadSourcePayload(scn),
    holdLoadSource: scn.holdLoadSource === true,
    store: scn.settings ? { [SETTINGS_KEY]: { ...DEFAULT_SETTINGS, ...scn.settings } } : {},
    autoplay: scn.stepMs === undefined ? null : { stepMs: scn.stepMs, messages }
  };
}

function mockChrome(config: MockConfig): void {
  type Listener = (message: unknown, sender: { id: string }, sendResponse: () => void) => void;
  type Correlation = { activeTabId?: number; runId?: string };
  interface PendingRun {
    request: RunRequest;
    settled: boolean;
    resolve: (response: unknown) => void;
    reject: (error: Error) => void;
  }

  const listeners: Listener[] = [];
  const timers: number[] = [];
  const runs: PendingRun[] = [];
  const clone = <T>(value: T): T => (value === undefined ? value : JSON.parse(JSON.stringify(value)));
  const store: Record<string, unknown> = clone(config.store);
  let releaseSource: () => void = () => undefined;

  const settle = (run: PendingRun | undefined, outcome: "ok" | RunFailure): void => {
    if (!run || run.settled) {
      return;
    }
    run.settled = true;
    if (outcome === "reject") {
      run.reject(new Error("Could not establish connection. Receiving end does not exist."));
    } else {
      run.resolve(outcome === "ok" ? { ok: true } : undefined);
    }
  };

  const stamp = (message: SentMessage, run: RunRequest | undefined): SentMessage => {
    const payload: Correlation = { ...(clone(message.payload) as Correlation) };
    payload.activeTabId ??= run?.activeTabId ?? config.tab?.id;
    payload.runId ??= run?.runId;
    return { type: message.type, payload };
  };

  const dispatch = (message: SentMessage, run: RunRequest | undefined): void => {
    const stamped = stamp(message, run);
    control.emitted.push(clone(stamped));
    [...listeners].forEach((listener) => listener(clone(stamped), { id: "across-amazon" }, () => undefined));
    if (stamped.type === config.types.result) {
      const { runId } = stamped.payload as Correlation;
      settle(
        runs.find((pending) => pending.request.runId === runId),
        "ok"
      );
    }
  };

  const control: AaControl = {
    openedUrls: [],
    sentMessages: [],
    emitted: [],
    store,
    listenerCount: () => listeners.length,
    emit: (message) => dispatch(message, runs[runs.length - 1]?.request),
    failRun: (failure) => settle(runs[runs.length - 1], failure),
    releaseLoadSource: () => releaseSource()
  };

  const play = (run: RunRequest): void => {
    const autoplay = config.autoplay;
    if (!autoplay) {
      return;
    }
    autoplay.messages.forEach((message, index) => {
      timers.push(window.setTimeout(() => dispatch(message, run), autoplay.stepMs * (index + 1)));
    });
  };

  const stop = (): void => {
    timers.splice(0).forEach((timer) => window.clearTimeout(timer));
  };

  const readKeys = (keys: string | string[] | null | undefined): Record<string, unknown> => {
    const wanted = keys === null || keys === undefined ? Object.keys(store) : Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(wanted.filter((key) => key in store).map((key) => [key, clone(store[key])]));
  };

  const loadSource = (): Promise<LoadSourcePayload> => {
    if (!config.holdLoadSource) {
      return Promise.resolve(clone(config.loadSourceResponse));
    }
    return new Promise((resolve) => {
      releaseSource = () => resolve(clone(config.loadSourceResponse));
    });
  };

  const startRun = (request: RunRequest): Promise<unknown> =>
    new Promise((resolve, reject) => {
      stop();
      runs.push({ request, settled: false, resolve, reject });
      play(request);
    });

  Object.defineProperty(window, "__aa", { configurable: true, value: control });
  Object.defineProperty(window, "chrome", {
    configurable: true,
    writable: true,
    value: {
      tabs: {
        query: async () => (config.tab ? [{ active: true, ...config.tab }] : []),
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
            case config.types.load:
              return loadSource();
            case config.types.run:
              return startRun(clone(message.payload) as RunRequest);
            case config.types.cancel:
              stop();
              return { ok: true, type: config.types.cancel };
            default:
              return { ok: false, error: "Unsupported message" };
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

export function loadingHint(page: Page): Locator {
  return page.getByText(LOADING_HINT, { exact: true });
}

export function brandMark(page: Page): Locator {
  return page.locator(".dB-brand img.dB-mark");
}

export async function openPopup(page: Page, scn: Scenario = scenario()): Promise<void> {
  await installChromeMock(page, scn);
  await page.goto("/popup.html");
  await page.waitForFunction(() => window.__aa.listenerCount() > 0);
  await expect
    .poll(() => brandMark(page).evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0))
    .toBe(true);
  if (scn.holdLoadSource) {
    await expect.poll(() => sentTypes(page)).toContain(LOAD_SOURCE);
  } else {
    await expect(loadingHint(page)).toHaveCount(0);
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

export async function failRun(page: Page, failure: RunFailure): Promise<void> {
  await page.evaluate(async (outcome) => {
    window.__aa.failRun(outcome);
    await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
  }, failure);
}

export function releaseLoadSource(page: Page): Promise<void> {
  return page.evaluate(() => window.__aa.releaseLoadSource());
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

export async function runIds(page: Page): Promise<string[]> {
  return (await sentMessages(page, RUN_COMPARISON)).map((message) => {
    const { runId } = message.payload as RunRequest;
    if (typeof runId !== "string" || runId.length === 0) {
      throw new Error(`RUN_COMPARISON was sent without a run id: ${JSON.stringify(message)}`);
    }
    return runId;
  });
}

export function emittedMessages(page: Page): Promise<SentMessage[]> {
  return page.evaluate(() => window.__aa.emitted);
}

export async function emittedTypes(page: Page): Promise<string[]> {
  return (await emittedMessages(page)).map((message) => message.type);
}

export function openedUrls(page: Page): Promise<string[]> {
  return page.evaluate(() => [...window.__aa.openedUrls]);
}

export function storedSettings(page: Page): Promise<unknown> {
  return page.evaluate((key) => window.__aa.store[key], SETTINGS_KEY);
}

export function runButton(page: Page): Locator {
  return page.getByRole("button", { name: /^Check (\d+ )?other Amazons?$/ });
}

export function scrollArea(page: Page): Locator {
  return page.locator(".dB-scroll");
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
  return page.getByRole("status", { includeHidden: true });
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
