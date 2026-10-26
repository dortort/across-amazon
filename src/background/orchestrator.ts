import { buildProductUrl, buildSearchUrl, countryName, marketDisplayDomain } from "../shared/markets";
import { RUN_COMPARISON_PROGRESS } from "../shared/messages";
import type { RunComparisonProgress } from "../shared/messages";
import {
  buildSearchQueries,
  computeMatchScore,
  findSourceVariant,
  normalizeAsin,
  pickBestCandidate,
  sharesSourceAsin,
  variantConflicts
} from "../shared/matching";
import { deliveredTotalIn, getDefaultCurrencyForMarketplace } from "../shared/money";
import { sortComparisonResults, withCheapestOtherOffer } from "../shared/comparison";
import { ROBOT_CHECK_MARKERS, inspectPage, robotCheckNote } from "../shared/robot-check";
import type { PageInspection } from "../shared/robot-check";
import { buildComparisonCacheKey, loadSettings, readComparisonCache, writeComparisonCache } from "../shared/storage";
import type {
  ComparisonPhase,
  ComparisonResult,
  ExtensionSettings,
  FxTable,
  LoadSourcePayload,
  LocationRequest,
  LocationResult,
  Marketplace,
  MatchScore,
  OfferQuote,
  PageJobFallback,
  PageJobPage,
  PageJobRead,
  ProductExtractionRequest,
  ProductExtractionResult,
  RunComparisonProgressPayload,
  RunComparisonResultPayload,
  SearchCandidate,
  SearchExtractionRequest,
  SourceContext,
  SourceExtractionResult
} from "../shared/types";
import { getDailyFxTable } from "./fx-service";
import { canUseOffscreen, cancelOffscreenRun, closeOffscreenDocument, runPageJob } from "./offscreen-client";

const COMPARISON_TTL_MS = 30 * 60 * 1000;
const CANCELLED_ERROR = "Comparison cancelled by user";
const LOCATION_REQUEST_KEY = "__ACROSS_AMAZON_LOCATION_REQUEST__";
const LOCATION_RESULT_KEY = "__ACROSS_AMAZON_LOCATION_RESULT__";
const LOCATION_TIMEOUT_MS = 20_000;
const PRODUCT_REQUEST_KEY = "__ACROSS_AMAZON_PRODUCT_REQUEST__";
const PRODUCT_RESULT_KEY = "__ACROSS_AMAZON_PRODUCT_RESULT__";
const PRODUCT_TIMEOUT_MS = 25_000;
const PAGE_LOAD_TIMEOUT_MS = 20_000;
const FIRST_RETRY_DELAY_MS = 100;
const MAX_RETRY_DELAY_MS = 1_000;
const NO_TAB_ERROR = "No tab with id";
const NO_HOST_ACCESS_ERROR = "Cannot access contents of the page";
const FRAME_REMOVED_ERROR = "Frame with ID 0 was removed";
const MAX_PAGE_JOBS = 2;

class RobotCheckError extends Error {}

interface RunToken {
  key: string;
  cancelled: boolean;
  controller: AbortController;
  usedOffscreen: boolean;
  tempTabIds: Set<number>;
  locations: Map<Marketplace, LocationResult>;
}

const RUN_TOKENS = new Map<number, RunToken>();

async function closeTempTabs(token: RunToken): Promise<void> {
  const tabIds = [...token.tempTabIds];
  token.tempTabIds.clear();
  await Promise.all(tabIds.map((tabId) => chrome.tabs.remove(tabId).catch(() => undefined)));
}

function cancelRun(token: RunToken): Promise<void> {
  token.cancelled = true;
  token.controller.abort();
  return Promise.all([token.usedOffscreen ? cancelOffscreenRun(token.key) : undefined, closeTempTabs(token)]).then(
    () => undefined
  );
}

function startRun(activeTabId: number): RunToken {
  const previous = RUN_TOKENS.get(activeTabId);
  if (previous) {
    void cancelRun(previous);
  }

  const token: RunToken = {
    key: crypto.randomUUID(),
    cancelled: false,
    controller: new AbortController(),
    usedOffscreen: false,
    tempTabIds: new Set(),
    locations: new Map()
  };
  RUN_TOKENS.set(activeTabId, token);
  return token;
}

async function finishRun(activeTabId: number, token: RunToken): Promise<void> {
  await closeTempTabs(token);
  if (RUN_TOKENS.get(activeTabId) === token) {
    RUN_TOKENS.delete(activeTabId);
  }
  if (RUN_TOKENS.size === 0) {
    await closeOffscreenDocument();
  }
}

function assertNotCancelled(token: RunToken): void {
  if (token.cancelled) {
    throw new Error(CANCELLED_ERROR);
  }
}

function isStorePage(pageUrl: string, storeHost: string): boolean {
  const page = new URL(pageUrl);
  return (page.protocol === "https:" || page.protocol === "http:") && page.hostname === storeHost;
}

function waitForStorePage(tabId: number, url: string): Promise<PageInspection> {
  const storeHost = new URL(url).hostname;
  return new Promise<PageInspection>((resolve, reject) => {
    let settled = false;
    let retryDelayMs = FIRST_RETRY_DELAY_MS;
    let retryId: ReturnType<typeof setTimeout> | undefined;

    const settle = (outcome: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      clearTimeout(retryId);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      outcome();
    };

    const fail = (error: Error): void => settle(() => reject(error));
    const failClosed = (): void => fail(new Error(`Tab ${tabId} was closed before it finished loading`));

    const onRemoved = (removedTabId: number): void => {
      if (removedTabId === tabId) {
        failClosed();
      }
    };

    const retry = (): void => {
      if (settled) {
        return;
      }
      retryId = setTimeout(inspect, retryDelayMs);
      retryDelayMs = Math.min(retryDelayMs * 2, MAX_RETRY_DELAY_MS);
    };

    const inspect = (): void => {
      chrome.scripting.executeScript({ target: { tabId }, func: inspectPage, args: [ROBOT_CHECK_MARKERS] }).then(
        ([frame]) => {
          const page = frame?.result;
          if (page && isStorePage(page.url, storeHost)) {
            settle(() => resolve(page));
          } else {
            retry();
          }
        },
        (error: unknown) => {
          const message = errorMessage(error, String(error));
          const injectionError = error instanceof Error ? error : new Error(message);
          if (message.startsWith(NO_TAB_ERROR)) {
            failClosed();
          } else if (message.startsWith(FRAME_REMOVED_ERROR)) {
            retry();
          } else if (message.startsWith(NO_HOST_ACCESS_ERROR)) {
            chrome.tabs.get(tabId).then((tab) => (tab.status === "complete" ? fail(injectionError) : retry()), failClosed);
          } else {
            fail(injectionError);
          }
        }
      );
    };

    const timeoutId = setTimeout(() => {
      fail(new Error(`Timed out waiting for tab ${tabId} to load`));
    }, PAGE_LOAD_TIMEOUT_MS);

    chrome.tabs.onRemoved.addListener(onRemoved);
    inspect();
  });
}

async function openInactiveTab(url: string, token: RunToken): Promise<number> {
  const tab = await chrome.tabs.create({
    url,
    active: false
  });

  if (tab.id === undefined) {
    throw new Error(`Failed to create tab for URL: ${url}`);
  }

  token.tempTabIds.add(tab.id);
  if (token.cancelled) {
    await closeTempTab(tab.id, token);
    throw new Error(CANCELLED_ERROR);
  }

  return tab.id;
}

async function closeTempTab(tabId: number, token: RunToken): Promise<void> {
  token.tempTabIds.delete(tabId);
  await chrome.tabs.remove(tabId).catch(() => undefined);
}

async function runScriptFile(tabId: number, file: string): Promise<void> {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: [file]
  });
}

async function readWindowValue<T>(tabId: number, key: string): Promise<T | undefined> {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (propertyName: string) => {
      const scope = window as unknown as Record<string, unknown>;
      const value = scope[propertyName];
      delete scope[propertyName];
      return value;
    },
    args: [key]
  });

  return result?.result as T | undefined;
}

async function writeWindowValue<T>(tabId: number, key: string, value: T): Promise<void> {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (propertyName: string, propertyValue: unknown) => {
      (window as unknown as Record<string, unknown>)[propertyName] = propertyValue;
    },
    args: [key, value]
  });
}

async function extractSourceContext(activeTabId: number): Promise<SourceContext> {
  await runScriptFile(activeTabId, "content/source-extractor.js");
  const extracted = await readWindowValue<SourceExtractionResult>(activeTabId, "__ACROSS_AMAZON_SOURCE_CONTEXT__");

  if (!extracted?.source) {
    throw new Error(extracted?.error ?? "Unable to extract source product context");
  }

  return extracted.source;
}

async function readSearchCandidates(tabId: number, request: SearchExtractionRequest): Promise<SearchCandidate[]> {
  await writeWindowValue(tabId, "__ACROSS_AMAZON_SEARCH_REQUEST__", request);
  await runScriptFile(tabId, "content/search-extractor.js");
  const result = await readWindowValue<SearchCandidate[]>(tabId, "__ACROSS_AMAZON_SEARCH_CANDIDATES__");
  return result ?? [];
}

function extractSearchCandidates(tabId: number, request: SearchExtractionRequest): Promise<SearchCandidate[]> {
  return withTimeout(
    readSearchCandidates(tabId, request),
    PRODUCT_TIMEOUT_MS,
    "Timed out reading the search page after 25 seconds"
  );
}

async function extractProductData(tabId: number, request: ProductExtractionRequest): Promise<ProductExtractionResult | undefined> {
  await writeWindowValue(tabId, PRODUCT_REQUEST_KEY, request);
  await runScriptFile(tabId, "content/product-extractor.js");
  return withTimeout(
    readWindowValue<ProductExtractionResult>(tabId, PRODUCT_RESULT_KEY),
    PRODUCT_TIMEOUT_MS,
    "Timed out reading the product page after 25 seconds"
  );
}

function pushProgress(payload: RunComparisonProgressPayload): void {
  const message: RunComparisonProgress = {
    type: RUN_COMPARISON_PROGRESS,
    payload
  };

  chrome.runtime.sendMessage(message).catch(() => undefined);
}

function buildNoMatchResult(marketplace: Marketplace): ComparisonResult {
  return {
    marketplace,
    status: "NO_CONFIDENT_MATCH",
    confidence: 0,
    notes: ["No candidate passed conservative confidence threshold"]
  };
}

function buildFailedResult(marketplace: Marketplace, reason: string): ComparisonResult {
  return {
    marketplace,
    status: "PARSE_FAILED",
    confidence: 0,
    notes: [reason]
  };
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function resolveComparisonCurrency(settings: ExtensionSettings, source: SourceContext): string {
  return settings.comparisonCurrency === "SOURCE"
    ? getDefaultCurrencyForMarketplace(source.marketplace)
    : settings.comparisonCurrency;
}

function normalizeResult(result: ComparisonResult, currency: string, fxTable: FxTable): ComparisonResult {
  const quoted = withCheapestOtherOffer(result, currency, fxTable);
  if (quoted.status !== "OK" || !quoted.breakdown) {
    return quoted;
  }

  const normalizedTotal = deliveredTotalIn(quoted.breakdown, currency, fxTable);
  if (!normalizedTotal) {
    return {
      ...quoted,
      status: "UNAVAILABLE",
      notes: [...(quoted.notes ?? []), `Missing FX conversion path to ${currency}`]
    };
  }

  return {
    ...quoted,
    normalizedTotal
  };
}

interface ExtractedBaseline {
  baseline: ComparisonResult;
  otherOffers?: OfferQuote[];
}

async function extractBaseline(
  activeTabId: number,
  source: SourceContext,
  readOtherOffers: boolean
): Promise<ExtractedBaseline | undefined> {
  try {
    const extraction = await extractProductData(activeTabId, {
      marketplace: source.marketplace,
      sourceDestinationCountryCode: source.destinationCountryCode,
      sourceDeliverTo: source.deliverTo,
      readOtherOffers
    });

    const breakdown = extraction?.breakdown;
    if (!extraction || !breakdown) {
      return undefined;
    }

    const currency = breakdown.item.currency;
    const importFees = breakdown.importFees ?? (extraction.otherSeller ? undefined : { amount: 0, currency });
    return {
      baseline: {
        marketplace: source.marketplace,
        status: "OK",
        confidence: 1,
        productUrl: source.sourceUrl,
        breakdown: {
          item: breakdown.item,
          shipping: breakdown.shipping ?? { amount: 0, currency },
          ...(importFees ? { importFees } : {}),
          ...(breakdown.totalDisplayed ? { totalDisplayed: breakdown.totalDisplayed } : {})
        },
        ...(extraction.otherSeller ? { otherSeller: extraction.otherSeller } : {}),
        notes: extraction.notes
      },
      otherOffers: extraction.otherOffers
    };
  } catch {
    return undefined;
  }
}

async function readTempTab<T>(
  url: string,
  targetMarket: Marketplace,
  token: RunToken,
  read: (tabId: number) => Promise<T>
): Promise<T> {
  const tabId = await openInactiveTab(url, token);
  try {
    const page = await waitForStorePage(tabId, url);
    if (page.robotCheck) {
      throw new RobotCheckError(robotCheckNote(marketDisplayDomain(targetMarket)));
    }
    return await read(tabId);
  } finally {
    await closeTempTab(tabId, token);
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeoutId);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeoutId);
        reject(error);
      }
    );
  });
}

function locationRequestFor(source: SourceContext, targetMarket: Marketplace, token: RunToken): LocationRequest | undefined {
  const countryCode = source.destinationCountryCode;
  return countryCode && !token.locations.has(targetMarket) ? { marketplace: targetMarket, countryCode } : undefined;
}

function expectedDestinationFor(source: SourceContext, targetMarket: Marketplace, token: RunToken): string | undefined {
  const status = token.locations.get(targetMarket)?.status;
  return status === "SET" || status === "ALREADY_SET" ? source.destinationCountryCode : undefined;
}

function recordLocation(token: RunToken, targetMarket: Marketplace, location?: LocationResult): void {
  if (location && location.status !== "NO_WIDGET") {
    token.locations.set(targetMarket, location);
  }
}

async function ensureDeliveryLocation(
  tabId: number,
  source: SourceContext,
  targetMarket: Marketplace,
  token: RunToken
): Promise<LocationResult | undefined> {
  const request = locationRequestFor(source, targetMarket, token);
  if (!request) {
    return undefined;
  }

  await writeWindowValue<LocationRequest>(tabId, LOCATION_REQUEST_KEY, request);
  await runScriptFile(tabId, "content/location-setter.js");

  let result: LocationResult;
  try {
    result = (await withTimeout(
      readWindowValue<LocationResult>(tabId, LOCATION_RESULT_KEY),
      LOCATION_TIMEOUT_MS,
      "timed out after 20 seconds"
    )) ?? { status: "FAILED", reason: "the location step returned nothing" };
  } catch (error) {
    assertNotCancelled(token);
    result = { status: "FAILED", reason: errorMessage(error, "Unknown location error") };
  }

  assertNotCancelled(token);
  recordLocation(token, targetMarket, result);
  return result;
}

async function readTargetTab<T>(
  source: SourceContext,
  targetMarket: Marketplace,
  url: string,
  token: RunToken,
  read: (tabId: number) => Promise<T>
): Promise<T> {
  const first = await readTempTab(url, targetMarket, token, async (tabId) => {
    const location = await ensureDeliveryLocation(tabId, source, targetMarket, token);
    return location?.status === "SET" ? { reopen: true as const } : { reopen: false as const, value: await read(tabId) };
  });
  return first.reopen ? readTempTab(url, targetMarket, token, read) : first.value;
}

interface PageSpec<T> {
  inTab: (tabId: number) => Promise<T>;
  job: PageJobPage;
  fromJob: (read: PageJobRead) => T;
}

function once(callback?: () => void): () => void {
  let called = false;
  return () => {
    if (!called) {
      called = true;
      callback?.();
    }
  };
}

function requestedFailure(result: PageJobRead | PageJobFallback): LocationResult | undefined {
  return result.location?.status === "FAILED" && result.locationRequested === true ? result.location : undefined;
}

async function redoLocationInTab(
  source: SourceContext,
  targetMarket: Marketplace,
  url: string,
  token: RunToken,
  failed: LocationResult
): Promise<LocationResult | undefined> {
  try {
    await readTempTab(url, targetMarket, token, (tabId) => ensureDeliveryLocation(tabId, source, targetMarket, token));
  } catch (error) {
    assertNotCancelled(token);
    if (error instanceof RobotCheckError) {
      throw error;
    }
  }
  if (!token.locations.has(targetMarket)) {
    token.locations.set(targetMarket, failed);
  }
  return token.locations.get(targetMarket);
}

async function readFallbackTab<T>(
  token: RunToken,
  targetMarket: Marketplace,
  result: PageJobFallback,
  inTab: () => Promise<T>
): Promise<T> {
  const failed = requestedFailure(result);
  if (!failed) {
    recordLocation(token, targetMarket, result.location);
  }
  try {
    return await inTab();
  } finally {
    if (failed && !token.cancelled && !token.locations.has(targetMarket)) {
      token.locations.set(targetMarket, failed);
    }
  }
}

async function readPage<T>(
  source: SourceContext,
  targetMarket: Marketplace,
  url: string,
  token: RunToken,
  spec: PageSpec<T>,
  onRead?: () => void
): Promise<T> {
  const read = once(onRead);
  const inTab = (): Promise<T> =>
    readTargetTab(source, targetMarket, url, token, (tabId) => {
      read();
      return spec.inTab(tabId);
    });
  if (!canUseOffscreen()) {
    return inTab();
  }

  read();
  for (let attempt = 0; attempt < MAX_PAGE_JOBS; attempt += 1) {
    token.usedOffscreen = true;
    const result = await runPageJob(
      {
        runKey: token.key,
        url,
        page: spec.job,
        location: locationRequestFor(source, targetMarket, token),
        expectDestination: expectedDestinationFor(source, targetMarket, token)
      },
      token.controller.signal
    );
    assertNotCancelled(token);
    switch (result.outcome) {
      case "cancelled":
        throw new Error(CANCELLED_ERROR);
      case "not-found":
        return spec.fromJob({ outcome: "read", finalUrl: result.finalUrl });
      case "robot-check":
        return inTab();
      case "fallback":
        return readFallbackTab(token, targetMarket, result, inTab);
      case "location-set":
        recordLocation(token, targetMarket, result.location);
        break;
      case "read": {
        const failed = requestedFailure(result);
        if (!failed) {
          recordLocation(token, targetMarket, result.location);
          return spec.fromJob(result);
        }
        const redone = await redoLocationInTab(source, targetMarket, url, token, failed);
        if (redone?.status !== "SET" && redone?.status !== "ALREADY_SET") {
          return spec.fromJob(result);
        }
        break;
      }
    }
  }
  return inTab();
}

function readProductPage(
  source: SourceContext,
  targetMarket: Marketplace,
  url: string,
  token: RunToken,
  onRead?: () => void
): Promise<ProductExtractionResult | undefined> {
  const request: ProductExtractionRequest = {
    marketplace: targetMarket,
    sourceDestinationCountryCode: source.destinationCountryCode,
    sourceDeliverTo: source.deliverTo,
    readOtherOffers: true
  };
  return readPage(
    source,
    targetMarket,
    url,
    token,
    {
      inTab: (tabId) => extractProductData(tabId, request),
      job: { kind: "product", request },
      fromJob: (read) => read.product
    },
    onRead
  );
}

type AsinLookup = { status: "MATCHED"; productData: ProductExtractionResult } | { status: "DEAD" | "MISSED" };

async function lookUpSourceAsin(source: SourceContext, targetMarket: Marketplace, token: RunToken): Promise<AsinLookup> {
  let productData: ProductExtractionResult | undefined;
  try {
    productData = await readProductPage(source, targetMarket, buildProductUrl(targetMarket, source.asin), token);
  } catch (error) {
    assertNotCancelled(token);
    if (error instanceof RobotCheckError) {
      throw error;
    }
    return { status: "MISSED" };
  }

  if (!productData || !sharesSourceAsin(source, { marketplace: targetMarket, asin: productData.asin, title: productData.title })) {
    return { status: "MISSED" };
  }

  return productData.availability === "unavailable" ? { status: "DEAD" } : { status: "MATCHED", productData };
}

interface ResolvedVariant {
  productData: ProductExtractionResult;
  asin?: string;
  notes: string[];
}

async function resolveSourceVariant(
  source: SourceContext,
  targetMarket: Marketplace,
  productData: ProductExtractionResult,
  token: RunToken
): Promise<ResolvedVariant | undefined> {
  if (!variantConflicts(source, productData.selectedVariants)) {
    return { productData, notes: [] };
  }

  const option = findSourceVariant(
    source,
    productData.variantOptions.filter((candidate) => candidate.asin !== productData.asin)
  );
  if (!option) {
    return undefined;
  }

  let variantData: ProductExtractionResult | undefined;
  try {
    variantData = await readProductPage(source, targetMarket, buildProductUrl(targetMarket, option.asin), token);
  } catch (error) {
    assertNotCancelled(token);
    if (error instanceof RobotCheckError) {
      throw error;
    }
    return {
      productData,
      notes: [
        `Could not read the ${option.label} variant: ${errorMessage(error, "Unknown extraction error")}`,
        `Quoted listing is another variant: ${productData.selectedVariants.join(", ")}`
      ]
    };
  }

  if (!variantData || variantData.asin !== option.asin || variantConflicts(source, variantData.selectedVariants)) {
    return undefined;
  }

  return { productData: variantData, asin: option.asin, notes: [`Switched to the ${option.label} variant`] };
}

function buildVariantMismatchResult(marketplace: Marketplace, selectedVariants: string[]): ComparisonResult {
  return {
    marketplace,
    status: "NO_CONFIDENT_MATCH",
    confidence: 0,
    notes: ["Matched by search", `Closest listing is another variant: ${selectedVariants.join(", ")}`]
  };
}

function locationNotes(location?: LocationResult): string[] {
  switch (location?.status) {
    case "SET":
      return location.countryCode ? [`Delivery location set to ${countryName(location.countryCode)}`] : [];
    case "NOT_OFFERED":
      return [`Delivery location not offered: ${location.countryCode}`];
    case "FAILED":
      return [`Delivery location not set: ${location.reason}`];
    default:
      return [];
  }
}

function buildProductResult(
  targetMarket: Marketplace,
  productData: ProductExtractionResult,
  match: MatchScore,
  matchNotes: string[],
  productUrl: string,
  location?: LocationResult
): ComparisonResult {
  const baseConfidence = Number((match.total * 0.8 + productData.parseConfidence * 0.2).toFixed(4));
  const notSet = location?.status === "FAILED" || location?.status === "NOT_OFFERED";
  const notes = [...matchNotes, ...locationNotes(location)];

  if (!productData.destinationMatched || (notSet && productData.destinationCountryCode === undefined)) {
    return {
      marketplace: targetMarket,
      status: "DESTINATION_MISMATCH",
      confidence: baseConfidence,
      productUrl,
      notes: [...notes, ...productData.notes, "Destination on product page does not match source destination"]
    };
  }

  if (!productData.breakdown || !productData.hasShippingInfo) {
    return {
      marketplace: targetMarket,
      status: "UNAVAILABLE",
      confidence: baseConfidence,
      productUrl,
      breakdown: productData.breakdown,
      notes: [...notes, ...productData.notes]
    };
  }

  return {
    marketplace: targetMarket,
    status: "OK",
    confidence: baseConfidence,
    productUrl,
    breakdown: productData.breakdown,
    ...(productData.otherSeller ? { otherSeller: productData.otherSeller } : {}),
    ...(productData.otherOffers ? { otherOffers: productData.otherOffers } : {}),
    notes: [...notes, ...productData.notes.filter((note) => note.toLowerCase().includes("shipping") === false)]
  };
}

async function searchForMatch(
  source: SourceContext,
  targetMarket: Marketplace,
  queries: string[],
  skippedAsins: string[],
  token: RunToken,
  enterPhase: (phase: ComparisonPhase) => void
): Promise<{ candidate: SearchCandidate; score: MatchScore } | undefined> {
  const request: SearchExtractionRequest = { marketplace: targetMarket, limit: 8 };
  for (const query of queries) {
    const candidates = await readPage(
      source,
      targetMarket,
      buildSearchUrl(targetMarket, query),
      token,
      {
        inTab: (tabId) => extractSearchCandidates(tabId, request),
        job: { kind: "search", request },
        fromJob: (read) => read.candidates ?? []
      },
      () => enterPhase("SEARCH")
    );

    enterPhase("MATCH");
    const best = pickBestCandidate(
      source,
      candidates.filter((candidate) => !skippedAsins.includes(normalizeAsin(candidate.asin)))
    );
    if (best) {
      return best;
    }
  }

  return undefined;
}

async function compareMarket(
  source: SourceContext,
  targetMarket: Marketplace,
  queries: string[],
  token: RunToken,
  enterPhase: (phase: ComparisonPhase) => void
): Promise<ComparisonResult> {
  enterPhase("OPEN");
  const lookup = await lookUpSourceAsin(source, targetMarket, token);
  if (lookup.status === "MATCHED") {
    enterPhase("READ");
    const productUrl = buildProductUrl(targetMarket, source.asin);
    const match = computeMatchScore(source, {
      marketplace: targetMarket,
      asin: lookup.productData.asin,
      title: lookup.productData.title ?? "",
      url: productUrl
    });
    return buildProductResult(
      targetMarket,
      lookup.productData,
      match,
      ["Matched by ASIN"],
      productUrl,
      token.locations.get(targetMarket)
    );
  }

  const skippedAsins = lookup.status === "DEAD" ? [normalizeAsin(source.asin)] : [];
  const best = await searchForMatch(source, targetMarket, queries, skippedAsins, token, enterPhase);
  if (!best) {
    return buildNoMatchResult(targetMarket);
  }

  const productData = await readProductPage(source, targetMarket, best.candidate.url, token, () => enterPhase("READ"));
  if (!productData) {
    return buildFailedResult(targetMarket, "No product extraction data returned");
  }

  const variant = await resolveSourceVariant(source, targetMarket, productData, token);
  if (!variant) {
    return buildVariantMismatchResult(targetMarket, productData.selectedVariants);
  }

  const asin = variant.asin ?? best.candidate.asin;
  const productUrl = asin ? buildProductUrl(targetMarket, asin) : variant.productData.canonicalUrl;
  return buildProductResult(
    targetMarket,
    variant.productData,
    best.score,
    ["Matched by search", `Match confidence: ${best.score.confidenceLabel}`, ...variant.notes],
    productUrl,
    token.locations.get(targetMarket)
  );
}

export async function cancelComparison(activeTabId: number): Promise<void> {
  const token = RUN_TOKENS.get(activeTabId);
  if (token) {
    await cancelRun(token);
  }
}

export async function loadSource(activeTabId: number): Promise<LoadSourcePayload> {
  try {
    const source = await extractSourceContext(activeTabId);
    const baseline = (await extractBaseline(activeTabId, source, false))?.baseline;
    return { source, baseline };
  } catch (error) {
    return { error: errorMessage(error, "Unable to read the active tab") };
  }
}

export async function runComparison(activeTabId: number, runId?: string): Promise<RunComparisonResultPayload> {
  const token = startRun(activeTabId);

  let sourceContext: SourceContext | undefined;
  let baseline: ComparisonResult | undefined;
  let fxTable: FxTable | undefined;
  const results: ComparisonResult[] = [];

  try {
    const source = await extractSourceContext(activeTabId);
    sourceContext = source;
    const settings = await loadSettings();

    const targetMarkets = settings.enabledMarketplaces.filter((market) => market !== source.marketplace);
    const cacheKey = buildComparisonCacheKey({
      asin: source.asin,
      variationTokens: source.variationTokens,
      sourceMarketplace: source.marketplace,
      destinationCountryCode: source.destinationCountryCode,
      deliverTo: source.deliverTo,
      targetMarkets
    });

    const cachedRecord = await readComparisonCache(cacheKey, COMPARISON_TTL_MS);
    if (cachedRecord) {
      return {
        source: cachedRecord.source,
        baseline: cachedRecord.baseline,
        results: cachedRecord.results,
        generatedAt: cachedRecord.createdAt,
        fxTable: cachedRecord.fxTable,
        activeTabId,
        runId
      };
    }

    const baselineRead = extractBaseline(activeTabId, source, true);
    const fxRead = getDailyFxTable();
    fxRead.catch(() => undefined);
    const extracted = await baselineRead;
    baseline = extracted?.baseline;
    const table = await fxRead;
    fxTable = table;

    const comparisonCurrency = resolveComparisonCurrency(settings, source);
    baseline = extracted && normalizeResult({ ...extracted.baseline, otherOffers: extracted.otherOffers }, comparisonCurrency, table);

    const queries = buildSearchQueries(source);
    const total = targetMarkets.length;
    let sawRobotCheck = false;

    for (const [index, targetMarket] of targetMarkets.entries()) {
      const enterPhase = (phase: ComparisonPhase): void => {
        assertNotCancelled(token);
        const latest = { marketplace: targetMarket, phase };
        pushProgress({
          completed: index,
          total,
          inFlight: [latest],
          latest,
          results: sortComparisonResults(results),
          fxTable: table,
          activeTabId,
          runId
        });
      };

      const result = await compareMarket(source, targetMarket, queries, token, enterPhase).catch((error: unknown) => {
        if (error instanceof RobotCheckError) {
          sawRobotCheck = true;
        }
        return buildFailedResult(targetMarket, errorMessage(error, "Unknown extraction error"));
      });
      assertNotCancelled(token);
      results.push(normalizeResult(result, comparisonCurrency, table));
    }

    const sortedResults = sortComparisonResults(results);
    pushProgress({ completed: total, total, inFlight: [], results: sortedResults, fxTable: table, activeTabId, runId });

    const payload: RunComparisonResultPayload = {
      source,
      baseline,
      results: sortedResults,
      generatedAt: new Date().toISOString(),
      fxTable: table,
      activeTabId,
      runId
    };

    if (!sawRobotCheck) {
      await writeComparisonCache(cacheKey, {
        createdAt: payload.generatedAt,
        source,
        baseline,
        results: sortedResults,
        fxTable: table
      });
    }

    return payload;
  } catch (error) {
    return {
      source: sourceContext,
      baseline,
      results: sortComparisonResults(results),
      generatedAt: new Date().toISOString(),
      fxTable,
      error: errorMessage(error, "Unknown comparison error"),
      activeTabId,
      runId
    };
  } finally {
    await finishRun(activeTabId, token);
  }
}
