import { buildProductUrl, buildSearchUrl } from "../shared/markets";
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
import { convertMoney, deliveredTotal, getDefaultCurrencyForMarketplace } from "../shared/money";
import { sortComparisonResults } from "../shared/comparison";
import { buildComparisonCacheKey, loadSettings, readComparisonCache, writeComparisonCache } from "../shared/storage";
import type {
  ComparisonPhase,
  ComparisonResult,
  ExtensionSettings,
  FxTable,
  LoadSourcePayload,
  Marketplace,
  MatchScore,
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

const COMPARISON_TTL_MS = 30 * 60 * 1000;
const CANCELLED_ERROR = "Comparison cancelled by user";

interface RunToken {
  cancelled: boolean;
  tempTabIds: Set<number>;
}

const RUN_TOKENS = new Map<number, RunToken>();

async function closeTempTabs(token: RunToken): Promise<void> {
  const tabIds = [...token.tempTabIds];
  token.tempTabIds.clear();
  await Promise.all(tabIds.map((tabId) => chrome.tabs.remove(tabId).catch(() => undefined)));
}

function cancelRun(token: RunToken): Promise<void> {
  token.cancelled = true;
  return closeTempTabs(token);
}

function startRun(activeTabId: number): RunToken {
  const previous = RUN_TOKENS.get(activeTabId);
  if (previous) {
    void cancelRun(previous);
  }

  const token: RunToken = {
    cancelled: false,
    tempTabIds: new Set()
  };
  RUN_TOKENS.set(activeTabId, token);
  return token;
}

async function finishRun(activeTabId: number, token: RunToken): Promise<void> {
  await closeTempTabs(token);
  if (RUN_TOKENS.get(activeTabId) === token) {
    RUN_TOKENS.delete(activeTabId);
  }
}

function assertNotCancelled(token: RunToken): void {
  if (token.cancelled) {
    throw new Error(CANCELLED_ERROR);
  }
}

function waitForTabComplete(tabId: number, timeoutMs = 15_000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const settle = (error?: Error): void => {
      clearTimeout(timeoutId);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };

    const onUpdated = (updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo): void => {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        settle();
      }
    };

    const onRemoved = (removedTabId: number): void => {
      if (removedTabId === tabId) {
        settle(new Error(`Tab ${tabId} was closed before it finished loading`));
      }
    };

    const timeoutId = setTimeout(() => {
      settle(new Error(`Timed out waiting for tab ${tabId} to complete`));
    }, timeoutMs);

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    chrome.tabs.get(tabId).then(
      (tab) => {
        if (tab.status === "complete") {
          settle();
        }
      },
      (error: unknown) => {
        settle(new Error(errorMessage(error, `Unable to read tab ${tabId}`)));
      }
    );
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

async function extractSearchCandidates(tabId: number, request: SearchExtractionRequest): Promise<SearchCandidate[]> {
  await writeWindowValue(tabId, "__ACROSS_AMAZON_SEARCH_REQUEST__", request);
  await runScriptFile(tabId, "content/search-extractor.js");
  const result = await readWindowValue<SearchCandidate[]>(tabId, "__ACROSS_AMAZON_SEARCH_CANDIDATES__");
  return result ?? [];
}

async function extractProductData(tabId: number, request: ProductExtractionRequest): Promise<ProductExtractionResult | undefined> {
  await writeWindowValue(tabId, "__ACROSS_AMAZON_PRODUCT_REQUEST__", request);
  await runScriptFile(tabId, "content/product-extractor.js");
  return readWindowValue<ProductExtractionResult>(tabId, "__ACROSS_AMAZON_PRODUCT_RESULT__");
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
  if (result.status !== "OK" || !result.breakdown) {
    return result;
  }

  const total = deliveredTotal(result.breakdown);
  if (!total) {
    return {
      ...result,
      status: "UNAVAILABLE",
      notes: [...(result.notes ?? []), "Unable to build delivered total"]
    };
  }

  const normalizedTotal = convertMoney(total, currency, fxTable);
  if (!normalizedTotal) {
    return {
      ...result,
      status: "UNAVAILABLE",
      notes: [...(result.notes ?? []), `Missing FX conversion path to ${currency}`]
    };
  }

  return {
    ...result,
    normalizedTotal
  };
}

async function extractBaseline(activeTabId: number, source: SourceContext): Promise<ComparisonResult | undefined> {
  try {
    const extraction = await extractProductData(activeTabId, {
      marketplace: source.marketplace,
      sourceDestinationCountryCode: source.destinationCountryCode,
      sourceDeliverTo: source.deliverTo
    });

    const breakdown = extraction?.breakdown;
    if (!extraction || !breakdown) {
      return undefined;
    }

    const currency = breakdown.item.currency;
    return {
      marketplace: source.marketplace,
      status: "OK",
      confidence: 1,
      productUrl: source.sourceUrl,
      breakdown: {
        item: breakdown.item,
        shipping: breakdown.shipping ?? { amount: 0, currency },
        importFees: breakdown.importFees ?? { amount: 0, currency },
        ...(breakdown.totalDisplayed ? { totalDisplayed: breakdown.totalDisplayed } : {})
      },
      notes: extraction.notes
    };
  } catch {
    return undefined;
  }
}

async function readTempTab<T>(url: string, token: RunToken, read: (tabId: number) => Promise<T>): Promise<T> {
  const tabId = await openInactiveTab(url, token);
  try {
    await waitForTabComplete(tabId);
    return await read(tabId);
  } finally {
    await closeTempTab(tabId, token);
  }
}

function readProductPage(
  source: SourceContext,
  targetMarket: Marketplace,
  url: string,
  token: RunToken,
  onLoaded?: () => void
): Promise<ProductExtractionResult | undefined> {
  return readTempTab(url, token, (tabId) => {
    onLoaded?.();
    return extractProductData(tabId, {
      marketplace: targetMarket,
      sourceDestinationCountryCode: source.destinationCountryCode,
      sourceDeliverTo: source.deliverTo
    });
  });
}

type AsinLookup = { status: "MATCHED"; productData: ProductExtractionResult } | { status: "DEAD" | "MISSED" };

async function lookUpSourceAsin(source: SourceContext, targetMarket: Marketplace, token: RunToken): Promise<AsinLookup> {
  let productData: ProductExtractionResult | undefined;
  try {
    productData = await readProductPage(source, targetMarket, buildProductUrl(targetMarket, source.asin), token);
  } catch {
    assertNotCancelled(token);
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

  const variantData = await readProductPage(source, targetMarket, buildProductUrl(targetMarket, option.asin), token);
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

function buildProductResult(
  targetMarket: Marketplace,
  productData: ProductExtractionResult,
  match: MatchScore,
  matchNotes: string[],
  productUrl: string
): ComparisonResult {
  const baseConfidence = Number((match.total * 0.8 + productData.parseConfidence * 0.2).toFixed(4));

  if (!productData.destinationMatched) {
    return {
      marketplace: targetMarket,
      status: "DESTINATION_MISMATCH",
      confidence: baseConfidence,
      productUrl,
      notes: [...matchNotes, ...productData.notes, "Destination on product page does not match source destination"]
    };
  }

  if (!productData.breakdown || !productData.hasShippingInfo) {
    return {
      marketplace: targetMarket,
      status: "UNAVAILABLE",
      confidence: baseConfidence,
      productUrl,
      breakdown: productData.breakdown,
      notes: [...matchNotes, ...productData.notes]
    };
  }

  return {
    marketplace: targetMarket,
    status: "OK",
    confidence: baseConfidence,
    productUrl,
    breakdown: productData.breakdown,
    notes: [...matchNotes, ...productData.notes.filter((note) => note.toLowerCase().includes("shipping") === false)]
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
  for (const query of queries) {
    const candidates = await readTempTab(buildSearchUrl(targetMarket, query), token, (tabId) => {
      enterPhase("SEARCH");
      return extractSearchCandidates(tabId, {
        marketplace: targetMarket,
        limit: 8
      });
    });

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
    return buildProductResult(targetMarket, lookup.productData, match, ["Matched by ASIN"], productUrl);
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
    productUrl
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
    const baseline = await extractBaseline(activeTabId, source);
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

    baseline = await extractBaseline(activeTabId, source);
    const table = await getDailyFxTable();
    fxTable = table;

    const comparisonCurrency = resolveComparisonCurrency(settings, source);
    baseline = baseline && normalizeResult(baseline, comparisonCurrency, table);

    const queries = buildSearchQueries(source);
    const total = targetMarkets.length;

    for (const [index, targetMarket] of targetMarkets.entries()) {
      const enterPhase = (phase: ComparisonPhase): void => {
        assertNotCancelled(token);
        pushProgress({
          completed: index,
          total,
          currentMarketplace: targetMarket,
          phase,
          results: sortComparisonResults(results),
          fxTable: table,
          activeTabId,
          runId
        });
      };

      const result = await compareMarket(source, targetMarket, queries, token, enterPhase).catch((error: unknown) =>
        buildFailedResult(targetMarket, errorMessage(error, "Unknown extraction error"))
      );
      assertNotCancelled(token);
      results.push(normalizeResult(result, comparisonCurrency, table));
    }

    const sortedResults = sortComparisonResults(results);
    pushProgress({ completed: total, total, results: sortedResults, fxTable: table, activeTabId, runId });

    const payload: RunComparisonResultPayload = {
      source,
      baseline,
      results: sortedResults,
      generatedAt: new Date().toISOString(),
      fxTable: table,
      activeTabId,
      runId
    };

    await writeComparisonCache(cacheKey, {
      createdAt: payload.generatedAt,
      source,
      baseline,
      results: sortedResults,
      fxTable: table
    });

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
