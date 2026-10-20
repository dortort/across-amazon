export interface Store {
  code: string;
  country: string;
  domain: string;
  currency: string;
}

export const stores: readonly Store[] = [
  { code: "US", country: "United States", domain: "amazon.com", currency: "USD" },
  { code: "CA", country: "Canada", domain: "amazon.ca", currency: "CAD" },
  { code: "MX", country: "Mexico", domain: "amazon.com.mx", currency: "MXN" },
  { code: "UK", country: "United Kingdom", domain: "amazon.co.uk", currency: "GBP" },
  { code: "DE", country: "Germany", domain: "amazon.de", currency: "EUR" },
  { code: "FR", country: "France", domain: "amazon.fr", currency: "EUR" },
  { code: "IT", country: "Italy", domain: "amazon.it", currency: "EUR" },
  { code: "ES", country: "Spain", domain: "amazon.es", currency: "EUR" },
  { code: "JP", country: "Japan", domain: "amazon.co.jp", currency: "JPY" },
  { code: "AU", country: "Australia", domain: "amazon.com.au", currency: "AUD" },
];
