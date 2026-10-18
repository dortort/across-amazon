import { buildSearchUrl } from "../shared/markets";
import { RUN_COMPARISON_PROGRESS } from "../shared/messages";
import type { RunComparisonProgress } from "../shared/messages";
import { pickBestCandidate } from "../shared/matching";
import { convertMoney, getDefaultCurrencyForMarketplace, sumMoney } from "../shared/money";
import { sortComparisonResults } from "../shared/comparison";
import { buildComparisonCacheKey, loadSettings, readComparisonCache, writeComparisonCache } from "../shared/storage";
import type {
  ComparisonResult,
  Marketplace,
  ProductExtractionRequest,
  ProductExtractionResult,
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

function pushProgress(completed: number, total: number, currentMarketplace?: Marketplace): void {
  const message: RunComparisonProgress = {
    type: RUN_COMPARISON_PROGRESS,
    payload: {
      completed,
      total,
      currentMarketplace
    }
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

export function cancelComparison(activeTabId: number): void {
  const token = RUN_TOKENS.get(activeTabId);
  if (token) {
    token.cancelled = true;
  }
}

export async function runComparison(activeTabId: number): Promise<RunComparisonResultPayload> {
  const token = getOrCreateRunToken(activeTabId);
  token.cancelled = false;

  let sourceContext: SourceContext | undefined;
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
        results: cachedRecord.results,
        generatedAt: cachedRecord.createdAt
      };
    }

    const queryParts = [source.title, source.brand, ...source.variationTokens].filter(Boolean);
    const query = queryParts.join(" ");

    for (let index = 0; index < targetMarkets.length; index += 1) {
      assertNotCancelled(token);

      const targetMarket = targetMarkets[index];
      pushProgress(index, targetMarkets.length, targetMarket);

      try {
        const searchUrl = buildSearchUrl(targetMarket, query);
        const searchTabId = await openInactiveTab(searchUrl, token);
        await waitForTabComplete(searchTabId);
        const candidates = await extractSearchCandidates(searchTabId, {
          marketplace: targetMarket,
          limit: 8
        });
        await closeTempTab(searchTabId, token);

        const best = pickBestCandidate(source, candidates);
        if (!best) {
          results.push(buildNoMatchResult(targetMarket));
          continue;
        }

        const productTabId = await openInactiveTab(best.candidate.url, token);
        await waitForTabComplete(productTabId);

        const productData = await extractProductData(productTabId, {
          marketplace: targetMarket,
          sourceDestinationCountryCode: source.destinationCountryCode
        });

        await closeTempTab(productTabId, token);

        if (!productData) {
          results.push(buildFailedResult(targetMarket, "No product extraction data returned"));
          continue;
        }

        const baseConfidence = Number((best.score.total * 0.8 + productData.parseConfidence * 0.2).toFixed(4));

        if (!productData.destinationMatched) {
          results.push({
            marketplace: targetMarket,
            status: "DESTINATION_MISMATCH",
            confidence: baseConfidence,
            productUrl: productData.canonicalUrl,
            notes: [...productData.notes, "Destination on product page does not match source destination"]
          });
          continue;
        }

        if (!productData.breakdown || !productData.hasShippingInfo || !productData.hasImportInfo) {
          results.push({
            marketplace: targetMarket,
            status: "UNAVAILABLE",
            confidence: baseConfidence,
            productUrl: productData.canonicalUrl,
            breakdown: productData.breakdown,
            notes: productData.notes
          });
          continue;
        }

        results.push({
          marketplace: targetMarket,
          status: "OK",
          confidence: baseConfidence,
          productUrl: productData.canonicalUrl,
          breakdown: productData.breakdown,
          notes: [
            `Match confidence: ${best.score.confidenceLabel}`,
            ...productData.notes.filter((note) => note.toLowerCase().includes("shipping") === false)
          ]
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown extraction error";
        results.push(buildFailedResult(targetMarket, message));
      }
    }

    pushProgress(targetMarkets.length, targetMarkets.length);

    const comparisonCurrency =
      settings.comparisonCurrency === "SOURCE"
        ? getDefaultCurrencyForMarketplace(source.marketplace)
        : settings.comparisonCurrency;

    const fxTable = await getDailyFxTable();

    const normalizedResults = results.map((result) => {
      if (result.status !== "OK" || !result.breakdown) {
        return result;
      }

      const deliveredTotal =
        result.breakdown.totalDisplayed ??
        sumMoney(
          [result.breakdown.item, result.breakdown.shipping, result.breakdown.importFees],
          result.breakdown.item.currency
        );

      if (!deliveredTotal) {
        return {
          ...result,
          status: "UNAVAILABLE",
          notes: [...(result.notes ?? []), "Unable to build delivered total"]
        } as ComparisonResult;
      }

      const normalizedTotal = convertMoney(deliveredTotal, comparisonCurrency, fxTable);
      if (!normalizedTotal) {
        return {
          ...result,
          status: "UNAVAILABLE",
          notes: [...(result.notes ?? []), `Missing FX conversion path to ${comparisonCurrency}`]
        } as ComparisonResult;
      }

      return {
        ...result,
        normalizedTotal
      };
    });

    const sortedResults = sortComparisonResults(normalizedResults);

    const payload: RunComparisonResultPayload = {
      source,
      results: sortedResults,
      generatedAt: new Date().toISOString()
    };

    await writeComparisonCache(cacheKey, {
      createdAt: payload.generatedAt,
      source,
      results: sortedResults
    });

    return payload;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown comparison error";
    return {
      source: sourceContext,
      results,
      generatedAt: new Date().toISOString(),
      error: message
    };
  } finally {
    for (const tabId of token.tempTabIds) {
      await chrome.tabs.remove(tabId).catch(() => undefined);
    }
    token.tempTabIds.clear();
    RUN_TOKENS.delete(activeTabId);
  }
}
