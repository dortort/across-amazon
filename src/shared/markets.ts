import type { Marketplace } from "./types";

export interface MarketplaceConfig {
  code: Marketplace;
  domain: string;
  label: string;
  currency: string;
  locale: string;
  flag: string;
}

export const MARKETPLACES: MarketplaceConfig[] = [
  { code: "US", domain: "www.amazon.com", label: "United States", currency: "USD", locale: "en-US", flag: "🇺🇸" },
  { code: "CA", domain: "www.amazon.ca", label: "Canada", currency: "CAD", locale: "en-CA", flag: "🇨🇦" },
  { code: "MX", domain: "www.amazon.com.mx", label: "Mexico", currency: "MXN", locale: "es-MX", flag: "🇲🇽" },
  { code: "UK", domain: "www.amazon.co.uk", label: "United Kingdom", currency: "GBP", locale: "en-GB", flag: "🇬🇧" },
  { code: "DE", domain: "www.amazon.de", label: "Germany", currency: "EUR", locale: "de-DE", flag: "🇩🇪" },
  { code: "FR", domain: "www.amazon.fr", label: "France", currency: "EUR", locale: "fr-FR", flag: "🇫🇷" },
  { code: "IT", domain: "www.amazon.it", label: "Italy", currency: "EUR", locale: "it-IT", flag: "🇮🇹" },
  { code: "ES", domain: "www.amazon.es", label: "Spain", currency: "EUR", locale: "es-ES", flag: "🇪🇸" },
  { code: "JP", domain: "www.amazon.co.jp", label: "Japan", currency: "JPY", locale: "ja-JP", flag: "🇯🇵" },
  { code: "AU", domain: "www.amazon.com.au", label: "Australia", currency: "AUD", locale: "en-AU", flag: "🇦🇺" }
];

export const MARKETPLACE_BY_CODE: Record<Marketplace, MarketplaceConfig> = MARKETPLACES.reduce(
  (accumulator, market) => {
    accumulator[market.code] = market;
    return accumulator;
  },
  {} as Record<Marketplace, MarketplaceConfig>
);

export const MARKETPLACE_CODES = MARKETPLACES.map((market) => market.code);

export function getMarketplaceByDomain(hostname: string): Marketplace | undefined {
  const normalizedHost = hostname.toLowerCase().replace(/^m\./, "www.");
  return MARKETPLACES.find((market) => market.domain === normalizedHost)?.code;
}

export function buildSearchUrl(marketplace: Marketplace, query: string): string {
  const domain = MARKETPLACE_BY_CODE[marketplace].domain;
  return `https://${domain}/s?k=${encodeURIComponent(query)}`;
}

export function buildProductUrl(marketplace: Marketplace, asin: string): string {
  return `https://${MARKETPLACE_BY_CODE[marketplace].domain}/dp/${encodeURIComponent(asin)}`;
}

export function marketLabel(code: Marketplace): string {
  return MARKETPLACE_BY_CODE[code].label;
}

export function marketDisplayDomain(code: Marketplace): string {
  return MARKETPLACE_BY_CODE[code].domain.replace(/^www\./, "");
}

export function countryName(code: string): string {
  const upper = code.toUpperCase();
  return MARKETPLACE_CODES.includes(upper as Marketplace) ? MARKETPLACE_BY_CODE[upper as Marketplace].label : code;
}
