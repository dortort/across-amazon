import { buildSearchUrl } from "../shared/markets";
import { RUN_COMPARISON_PROGRESS } from "../shared/messages";
import type { RunComparisonProgress } from "../shared/messages";
import { pickBestCandidate } from "../shared/matching";
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

interface RunToken {
  cancelled: boolean;
  tempTabIds: Set<number>;
}

const RUN_TOKENS = new Map<number, RunToken>();

function getOrCreateRunToken(activeTabId: number): RunToken {
  const existing = RUN_TOKENS.get(activeTabId);
  if (existing) {
    return existing;
  }

  const token: RunToken = {
    cancelled: false,
    tempTabIds: new Set()
  };
  RUN_TOKENS.set(activeTabId, token);
  return token;
}

function assertNotCancelled(token: RunToken): void {
  if (token.cancelled) {
    throw new Error("Comparison cancelled by user");
  }
}

async function waitForTabComplete(tabId: number, timeoutMs = 15_000): Promise<void> {
  const existing = await chrome.tabs.get(tabId);
  if (existing.status === "complete") {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error(`Timed out waiting for tab ${tabId} to complete`));
    }, timeoutMs);

    const onUpdated = (updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        clearTimeout(timeoutId);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    };

    chrome.tabs.onUpdated.addListener(onUpdated);
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
      sourceDestinationCountryCode: source.destinationCountryCode
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

async function compareMarket(
  source: SourceContext,
  targetMarket: Marketplace,
  query: string,
  token: RunToken,
  enterPhase: (phase: ComparisonPhase) => void
): Promise<ComparisonResult> {
  enterPhase("OPEN");
  const searchTabId = await openInactiveTab(buildSearchUrl(targetMarket, query), token);
  await waitForTabComplete(searchTabId);

  enterPhase("SEARCH");
  const candidates = await extractSearchCandidates(searchTabId, {
    marketplace: targetMarket,
    limit: 8
  });
  await closeTempTab(searchTabId, token);

  enterPhase("MATCH");
  const best = pickBestCandidate(source, candidates);
  if (!best) {
    return buildNoMatchResult(targetMarket);
  }

  const productTabId = await openInactiveTab(best.candidate.url, token);
  await waitForTabComplete(productTabId);

  enterPhase("READ");
  const productData = await extractProductData(productTabId, {
    marketplace: targetMarket,
    sourceDestinationCountryCode: source.destinationCountryCode
  });
  await closeTempTab(productTabId, token);

  if (!productData) {
    return buildFailedResult(targetMarket, "No product extraction data returned");
  }

  const baseConfidence = Number((best.score.total * 0.8 + productData.parseConfidence * 0.2).toFixed(4));

  if (!productData.destinationMatched) {
    return {
      marketplace: targetMarket,
      status: "DESTINATION_MISMATCH",
      confidence: baseConfidence,
      productUrl: productData.canonicalUrl,
      notes: [...productData.notes, "Destination on product page does not match source destination"]
    };
  }

  if (!productData.breakdown || !productData.hasShippingInfo || !productData.hasImportInfo) {
    return {
      marketplace: targetMarket,
      status: "UNAVAILABLE",
      confidence: baseConfidence,
      productUrl: productData.canonicalUrl,
      breakdown: productData.breakdown,
      notes: productData.notes
    };
  }

  return {
    marketplace: targetMarket,
    status: "OK",
    confidence: baseConfidence,
    productUrl: productData.canonicalUrl,
    breakdown: productData.breakdown,
    notes: [
      `Match confidence: ${best.score.confidenceLabel}`,
      ...productData.notes.filter((note) => note.toLowerCase().includes("shipping") === false)
    ]
  };
}

export function cancelComparison(activeTabId: number): void {
  const token = RUN_TOKENS.get(activeTabId);
  if (token) {
    token.cancelled = true;
  }
}

export async function loadSource(activeTabId: number): Promise<LoadSourcePayload> {
  try {
    const source = await extractSourceContext(activeTabId);
    const baseline = await extractBaseline(activeTabId, source);
    if (!baseline) {
      return { source };
    }

    const [settings, fxTable] = await Promise.all([loadSettings(), getDailyFxTable().catch(() => undefined)]);
    return {
      source,
      baseline: fxTable ? normalizeResult(baseline, resolveComparisonCurrency(settings, source), fxTable) : baseline
    };
  } catch (error) {
    return { error: errorMessage(error, "Unable to read the active tab") };
  }
}

export async function runComparison(activeTabId: number): Promise<RunComparisonResultPayload> {
  const token = getOrCreateRunToken(activeTabId);
  token.cancelled = false;

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
      targetMarkets
    });

    const cachedRecord = await readComparisonCache(cacheKey, COMPARISON_TTL_MS);
    if (cachedRecord) {
      return {
        source: cachedRecord.source,
        baseline: cachedRecord.baseline,
        results: cachedRecord.results,
        generatedAt: cachedRecord.createdAt,
        fxTable: cachedRecord.fxTable
      };
    }

    baseline = await extractBaseline(activeTabId, source);
    const table = await getDailyFxTable();
    fxTable = table;

    const comparisonCurrency = resolveComparisonCurrency(settings, source);
    baseline = baseline && normalizeResult(baseline, comparisonCurrency, table);

    const queryParts = [source.title, source.brand, ...source.variationTokens].filter(Boolean);
    const query = queryParts.join(" ");
    const total = targetMarkets.length;

    for (const [index, targetMarket] of targetMarkets.entries()) {
      const enterPhase = (phase: ComparisonPhase): void => {
        assertNotCancelled(token);
        pushProgress({
          completed: index,
          total,
          currentMarketplace: targetMarket,
          phase,
          results: sortComparisonResults(results)
        });
      };

      let result: ComparisonResult;
      try {
        result = await compareMarket(source, targetMarket, query, token, enterPhase);
      } catch (error) {
        assertNotCancelled(token);
        result = buildFailedResult(targetMarket, errorMessage(error, "Unknown extraction error"));
      }

      results.push(normalizeResult(result, comparisonCurrency, table));
    }

    const sortedResults = sortComparisonResults(results);
    pushProgress({ completed: total, total, results: sortedResults });

    const payload: RunComparisonResultPayload = {
      source,
      baseline,
      results: sortedResults,
      generatedAt: new Date().toISOString(),
      fxTable: table
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
      error: errorMessage(error, "Unknown comparison error")
    };
  } finally {
    for (const tabId of token.tempTabIds) {
      await chrome.tabs.remove(tabId).catch(() => undefined);
    }
    token.tempTabIds.clear();
    RUN_TOKENS.delete(activeTabId);
  }
}
