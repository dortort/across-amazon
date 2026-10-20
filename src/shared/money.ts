import type { FxTable, Marketplace, Money, PriceBreakdown } from "./types";
import { MARKETPLACE_BY_CODE } from "./markets";

const CURRENCY_SYMBOL_PATTERNS: Array<{ symbol: string; currency: string }> = [
  { symbol: "US$", currency: "USD" },
  { symbol: "CA$", currency: "CAD" },
  { symbol: "C$", currency: "CAD" },
  { symbol: "MX$", currency: "MXN" },
  { symbol: "AU$", currency: "AUD" },
  { symbol: "EUR", currency: "EUR" },
  { symbol: "JPY", currency: "JPY" },
  { symbol: "€", currency: "EUR" },
  { symbol: "£", currency: "GBP" },
  { symbol: "￥", currency: "JPY" },
  { symbol: "¥", currency: "JPY" },
  { symbol: "$", currency: "USD" }
];

export function parseLocalizedNumber(input: string): number | undefined {
  const sanitized = input.replace(/\s/g, "").replace(/[^0-9,.-]/g, "");
  if (!sanitized) {
    return undefined;
  }

  const hasComma = sanitized.includes(",");
  const hasDot = sanitized.includes(".");

  if (hasComma && hasDot) {
    const lastComma = sanitized.lastIndexOf(",");
    const lastDot = sanitized.lastIndexOf(".");
    if (lastComma > lastDot) {
      const normalized = sanitized.replace(/\./g, "").replace(",", ".");
      const parsed = Number.parseFloat(normalized);
      return Number.isFinite(parsed) ? parsed : undefined;
    }

    const normalized = sanitized.replace(/,/g, "");
    const parsed = Number.parseFloat(normalized);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  if (hasComma) {
    const commaParts = sanitized.split(",");
    if (commaParts.length > 1 && commaParts[commaParts.length - 1].length === 2) {
      const normalized = sanitized.replace(/\./g, "").replace(",", ".");
      const parsed = Number.parseFloat(normalized);
      return Number.isFinite(parsed) ? parsed : undefined;
    }

    const normalized = sanitized.replace(/,/g, "");
    const parsed = Number.parseFloat(normalized);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  const parsed = Number.parseFloat(sanitized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function detectCurrency(text: string, fallback?: string): string {
  for (const pattern of CURRENCY_SYMBOL_PATTERNS) {
    if (text.includes(pattern.symbol)) {
      return pattern.currency;
    }
  }
  return fallback ?? "USD";
}

export function parseMoney(text: string, fallbackCurrency?: string): Money | undefined {
  const amount = parseLocalizedNumber(text);
  if (amount === undefined) {
    return undefined;
  }

  return {
    amount,
    currency: detectCurrency(text, fallbackCurrency)
  };
}

export function getDefaultCurrencyForMarketplace(marketplace: Marketplace): string {
  return MARKETPLACE_BY_CODE[marketplace].currency;
}

export function sumMoney(parts: Array<Money | undefined>, currency: string): Money | undefined {
  const available = parts.filter((part): part is Money => Boolean(part));
  if (available.length === 0) {
    return undefined;
  }

  const sum = available.reduce((total, current) => total + current.amount, 0);
  return {
    amount: sum,
    currency
  };
}

function roundCents(amount: number): number {
  return Number(amount.toFixed(2));
}

function charges(breakdown: PriceBreakdown): Money[] {
  return [breakdown.item, breakdown.shipping, breakdown.importFees].filter((part): part is Money => Boolean(part));
}

export function deliveredTotal(breakdown: PriceBreakdown | undefined): Money | undefined {
  if (!breakdown) {
    return undefined;
  }

  const { currency } = breakdown.item;
  const parts = charges(breakdown);
  if (parts.some((part) => part.currency !== currency)) {
    return undefined;
  }

  const sum = roundCents(parts.reduce((total, part) => total + part.amount, 0));
  const displayed = breakdown.totalDisplayed;
  if (displayed && displayed.currency === currency && roundCents(displayed.amount) >= sum) {
    return { amount: roundCents(displayed.amount), currency };
  }

  return { amount: sum, currency };
}

export function convertMoney(value: Money, targetCurrency: string, fxTable: FxTable): Money | undefined {
  if (value.currency === targetCurrency) {
    return { ...value };
  }

  const base = fxTable.base;
  const fromRate = value.currency === base ? 1 : fxTable.rates[value.currency];
  const toRate = targetCurrency === base ? 1 : fxTable.rates[targetCurrency];

  if (!fromRate || !toRate) {
    return undefined;
  }

  const baseAmount = value.amount / fromRate;
  const converted = baseAmount * toRate;
  return {
    amount: Number(converted.toFixed(2)),
    currency: targetCurrency
  };
}

export function formatMoney(value: Money | undefined, locale = "en-US"): string {
  if (!value) {
    return "-";
  }

  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: value.currency,
    maximumFractionDigits: value.currency === "JPY" ? 0 : 2
  }).format(value.amount);
}

export function deliveredTotalIn(breakdown: PriceBreakdown | undefined, currency: string, fxTable: FxTable): Money | undefined {
  const local = deliveredTotal(breakdown);
  if (local) {
    return convertMoney(local, currency, fxTable);
  }
  if (!breakdown) {
    return undefined;
  }

  const converted = charges(breakdown).map((part) => convertMoney(part, currency, fxTable));
  if (!converted.every((part): part is Money => part !== undefined)) {
    return undefined;
  }
  const sum = roundCents(converted.reduce((total, part) => total + part.amount, 0));
  const displayed = breakdown.totalDisplayed && convertMoney(breakdown.totalDisplayed, currency, fxTable);
  return displayed && roundCents(displayed.amount) >= sum ? { amount: roundCents(displayed.amount), currency } : { amount: sum, currency };
}
