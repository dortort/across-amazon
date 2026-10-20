export function normalize(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function collapseText(element: Element | null | undefined): string | undefined {
  return element?.textContent?.replace(/\s+/g, " ").trim() || undefined;
}

function parseLocalizedNumber(input: string): number | undefined {
  const sanitized = input.replace(/\s/g, "").replace(/[^0-9,.-]/g, "");
  if (!sanitized) {
    return undefined;
  }

  const hasComma = sanitized.includes(",");
  const hasDot = sanitized.includes(".");

  if (hasComma && hasDot) {
    const lastComma = sanitized.lastIndexOf(",");
    const lastDot = sanitized.lastIndexOf(".");
    const normalized =
      lastComma > lastDot ? sanitized.replace(/\./g, "").replace(",", ".") : sanitized.replace(/,/g, "");
    const parsed = Number.parseFloat(normalized);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  if (hasComma) {
    const parts = sanitized.split(",");
    const normalized = parts[parts.length - 1].length === 2 ? sanitized.replace(",", ".") : sanitized.replace(/,/g, "");
    const parsed = Number.parseFloat(normalized);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  const parsed = Number.parseFloat(sanitized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export type ParsedMoney = { amount: number; currency: string };

const CURRENCY_CODE = String.raw`(?<![A-Za-z])(?:USD|CAD|MXN|GBP|EUR|JPY|AUD|BRL|CHF|CNY|CZK|DKK|HKD|HUF|IDR|ILS|INR|ISK|KRW|MYR|NOK|NZD|PHP|PLN|RON|SEK|SGD|THB|TRY|ZAR)(?![A-Za-z])`;
const CURRENCY_CODE_TOKEN = new RegExp(CURRENCY_CODE);
const DOLLAR_CURRENCIES = new Set(["USD", "CAD", "MXN", "AUD"]);

function detectCurrency(text: string, marketCurrency: string): string {
  if (text.includes("US$")) {
    return "USD";
  }
  if (text.includes("CA$") || text.includes("C$")) {
    return "CAD";
  }
  if (text.includes("MX$")) {
    return "MXN";
  }
  if (text.includes("AU$")) {
    return "AUD";
  }
  const code = CURRENCY_CODE_TOKEN.exec(text)?.[0];
  if (code) {
    return code;
  }
  if (text.includes("£")) {
    return "GBP";
  }
  if (text.includes("€")) {
    return "EUR";
  }
  if (text.includes("￥") || text.includes("¥") || text.includes("円")) {
    return "JPY";
  }
  if (text.includes("$")) {
    return DOLLAR_CURRENCIES.has(marketCurrency) ? marketCurrency : "USD";
  }
  return marketCurrency;
}

const AMOUNT = String.raw`(?:\d{1,3}(?:[\u00a0\u202f]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)*)`;
const PREFIXED_MONEY = new RegExp(String.raw`(?:(?:CA|C|MX|AU|US)?\$|£|€|￥|¥|${CURRENCY_CODE}\s*)${AMOUNT}`);
const SUFFIXED_MONEY = new RegExp(String.raw`${AMOUNT}\s*(?:€|£|￥|¥|円|\$|${CURRENCY_CODE})`);
const BARE_AMOUNT = /^\d[\d\s.,]*$/;

export function parseMoney(text: string, marketCurrency: string): ParsedMoney | undefined {
  const amount = parseLocalizedNumber(text);
  if (amount === undefined) {
    return undefined;
  }

  return {
    amount,
    currency: detectCurrency(text, marketCurrency)
  };
}

export function parseCurrencyMarkedMoney(text: string, marketCurrency: string): ParsedMoney | undefined {
  const token = PREFIXED_MONEY.exec(text)?.[0] ?? SUFFIXED_MONEY.exec(text)?.[0];
  return token ? parseMoney(token, marketCurrency) : undefined;
}

export function readAmount(text: string, marketCurrency: string): ParsedMoney | undefined {
  return parseCurrencyMarkedMoney(text, marketCurrency) ?? (BARE_AMOUNT.test(text) ? parseMoney(text, marketCurrency) : undefined);
}

function readPricePart(price: Element, selector: string): string {
  return price.querySelector(selector)?.textContent?.replace(/\s+/g, "") ?? "";
}

export function readPriceText(price: Element): string | undefined {
  const offscreen = collapseText(price.querySelector(".a-offscreen"));
  if (offscreen) {
    return offscreen;
  }

  const whole = readPricePart(price, ".a-price-whole");
  if (whole) {
    return `${readPricePart(price, ".a-price-symbol")}${whole}${readPricePart(price, ".a-price-fraction")}`;
  }

  return collapseText(price);
}

export function hasFreeMarker(text: string | undefined): boolean {
  if (!text) {
    return false;
  }

  const normalizedText = normalize(text);
  return (
    normalizedText.includes("free") ||
    normalizedText.includes("gratuit") ||
    normalizedText.includes("gratis") ||
    normalizedText.includes("kostenlos") ||
    normalizedText.includes("無料")
  );
}

export interface ChargeReading {
  amount?: ParsedMoney;
  isFree: boolean;
}

const PRIMARY_DELIVERY_PRICE = "[id^='mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE'] [data-csa-c-delivery-price]";

export function readDeliveryPrice(scope: ParentNode, marketCurrency: string): ChargeReading | undefined {
  for (const message of Array.from(scope.querySelectorAll(PRIMARY_DELIVERY_PRICE))) {
    const value = message.getAttribute("data-csa-c-delivery-price")?.trim() ?? "";
    const amount = readAmount(value, marketCurrency);
    if (amount) {
      return { amount, isFree: false };
    }
    if (hasFreeMarker(value)) {
      return { isFree: true };
    }
  }

  return undefined;
}
