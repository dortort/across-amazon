import type { FxTable } from "../shared/types";

function getUtcDayKey(date = new Date()): string {
  const year = date.getUTCFullYear();
  const month = `${date.getUTCMonth() + 1}`.padStart(2, "0");
  const day = `${date.getUTCDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseEcbRates(xml: string): FxTable | undefined {
  const dateMatch = xml.match(/time=['"](\d{4}-\d{2}-\d{2})['"]/);
  const date = dateMatch?.[1] ?? getUtcDayKey();

  const rateMatches = [...xml.matchAll(/currency=['"]([A-Z]{3})['"]\s+rate=['"]([0-9.]+)['"]/g)];
  if (rateMatches.length === 0) {
    return undefined;
  }

  const rates: Record<string, number> = { EUR: 1 };
  for (const match of rateMatches) {
    const currency = match[1];
    const rate = Number.parseFloat(match[2]);
    if (Number.isFinite(rate)) {
      rates[currency] = rate;
    }
  }

  return {
    base: "EUR",
    date,
    rates,
    source: "ECB"
  };
}

async function fetchEcbDailyRates(): Promise<FxTable | undefined> {
  const response = await fetch("https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml", {
    method: "GET",
    cache: "no-store"
  });

  if (!response.ok) {
    return undefined;
  }

  const xml = await response.text();
  return parseEcbRates(xml);
}

async function fetchFrankfurterRates(): Promise<FxTable | undefined> {
  const response = await fetch("https://api.frankfurter.app/latest?from=EUR", {
    method: "GET",
    cache: "no-store"
  });

  if (!response.ok) {
    return undefined;
  }

  const payload = (await response.json()) as {
    amount?: number;
    base?: string;
    date?: string;
    rates?: Record<string, number>;
  };

  if (!payload.base || !payload.date || !payload.rates) {
    return undefined;
  }

  return {
    base: payload.base,
    date: payload.date,
    rates: {
      ...payload.rates,
      [payload.base]: 1
    },
    source: "FRANKFURTER"
  };
}

export async function getDailyFxTable(): Promise<FxTable> {
  const todayKey = getUtcDayKey();
  const cacheKey = `fx:${todayKey}`;
  const cached = (await chrome.storage.local.get(cacheKey))[cacheKey] as FxTable | undefined;
  if (cached) {
    return cached;
  }

  const ecbTable = await fetchEcbDailyRates().catch(() => undefined);
  if (ecbTable) {
    await chrome.storage.local.set({ [cacheKey]: ecbTable });
    return ecbTable;
  }

  const frankfurterTable = await fetchFrankfurterRates().catch(() => undefined);
  if (frankfurterTable) {
    await chrome.storage.local.set({ [cacheKey]: frankfurterTable });
    return frankfurterTable;
  }

  throw new Error("Unable to load FX reference rates from ECB or Frankfurter");
}
