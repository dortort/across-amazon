import { MARKETPLACE_CODES } from "./markets";
import type { CachedComparisonRecord, ExtensionSettings, Marketplace } from "./types";

const SETTINGS_KEY = "settings:v1";

const DEFAULT_SETTINGS: ExtensionSettings = {
  enabledMarketplaces: [...MARKETPLACE_CODES],
  comparisonCurrency: "SOURCE",
  disclosureAcknowledged: false
};

function isMarketplaceArray(value: unknown): value is Marketplace[] {
  return Array.isArray(value) && value.every((item) => MARKETPLACE_CODES.includes(item as Marketplace));
}

export async function loadSettings(): Promise<ExtensionSettings> {
  const response = await chrome.storage.local.get(SETTINGS_KEY);
  const rawSettings = response[SETTINGS_KEY];

  if (!rawSettings || typeof rawSettings !== "object") {
    return DEFAULT_SETTINGS;
  }

  const enabledMarketplaces = isMarketplaceArray((rawSettings as ExtensionSettings).enabledMarketplaces)
    ? [...(rawSettings as ExtensionSettings).enabledMarketplaces]
    : [...DEFAULT_SETTINGS.enabledMarketplaces];

  const comparisonCurrency =
    typeof (rawSettings as ExtensionSettings).comparisonCurrency === "string"
      ? (rawSettings as ExtensionSettings).comparisonCurrency
      : DEFAULT_SETTINGS.comparisonCurrency;

  const disclosureAcknowledged = Boolean((rawSettings as ExtensionSettings).disclosureAcknowledged);

  return {
    enabledMarketplaces,
    comparisonCurrency,
    disclosureAcknowledged
  };
}

export async function saveSettings(settings: ExtensionSettings): Promise<void> {
  await chrome.storage.local.set({
    [SETTINGS_KEY]: settings
  });
}

export function buildComparisonCacheKey(input: {
  asin: string;
  variationTokens: string[];
  sourceMarketplace: Marketplace;
  destinationCountryCode: string;
  targetMarkets: Marketplace[];
}): string {
  const value = [
    input.asin,
    [...input.variationTokens].sort().join("|"),
    input.sourceMarketplace,
    input.destinationCountryCode,
    [...input.targetMarkets].sort().join("|")
  ].join("::");

  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }

  return `cmp:${Math.abs(hash)}`;
}

export async function readComparisonCache(cacheKey: string, ttlMs: number): Promise<CachedComparisonRecord | undefined> {
  const record = (await chrome.storage.local.get(cacheKey))[cacheKey] as CachedComparisonRecord | undefined;
  if (!record) {
    return undefined;
  }

  const age = Date.now() - new Date(record.createdAt).getTime();
  if (age > ttlMs) {
    await chrome.storage.local.remove(cacheKey);
    return undefined;
  }

  return record;
}

export async function writeComparisonCache(cacheKey: string, value: CachedComparisonRecord): Promise<void> {
  await chrome.storage.local.set({
    [cacheKey]: value
  });
}
