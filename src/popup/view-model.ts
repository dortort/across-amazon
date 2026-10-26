import { TIMED_OUT_NOTE } from "../shared/comparison";
import { MARKETPLACE_BY_CODE, MARKETPLACE_CODES, MARKET_CONCURRENCY, countryName } from "../shared/markets";
import { deliveredTotal, deliveredTotalIn, formatMoney } from "../shared/money";
import { ROBOT_CHECK_NOTE_PREFIX } from "../shared/robot-check";
import type {
  ComparisonPhase,
  ComparisonResult,
  ComparisonStatus,
  ExtensionSettings,
  FxTable,
  MarketProgress,
  Marketplace,
  Money,
  OtherSeller,
  SourceContext
} from "../shared/types";

export type VerdictView = "idle" | "running" | "done" | "settings";

export const DISPLAY_CURRENCIES = ["USD", "EUR", "GBP", "JPY"] as const;

export type Verdict =
  | { kind: "save"; best: ComparisonResult; bestTotal: Money; baselineTotal: Money; saving: Money; percent: number }
  | { kind: "stay"; baselineTotal: Money }
  | { kind: "cheapest"; best: ComparisonResult; bestTotal: Money }
  | { kind: "none" };

export interface RankedRow {
  result: ComparisonResult;
  total: Money;
  delta?: Money;
  isSource: boolean;
  isBest: boolean;
}

interface RankedEntry {
  result: ComparisonResult;
  total: Money;
}

export interface DeltaText {
  text: string;
  cls: "flat" | "down" | "up";
}

export interface CheckChipEntry {
  marketplace: Marketplace;
  result?: ComparisonResult;
}

const MATCH_CHECK_THRESHOLD = 0.9;
const SECONDS_PER_ROUND = 5;
const MIN_ESTIMATED_SECONDS = 5;
const MINUS_SIGN = "−";
const SOURCE_TRUST_SENTENCE = "This is the page you are on. Prices are what Amazon showed when we checked.";

const STATUS_TEXT: Record<ComparisonStatus, string> = {
  OK: "Available",
  UNAVAILABLE: "Delivered total not quotable",
  DESTINATION_MISMATCH: "Could not set delivery location",
  PARSE_FAILED: "Could not read the page",
  NO_CONFIDENT_MATCH: "No confident match"
};

const PHASE_LABEL: Record<ComparisonPhase, string> = {
  OPEN: "Checking",
  SEARCH: "Searching",
  MATCH: "Matching product",
  READ: "Reading cost stack"
};

function fractionDigits(currency: string): number {
  return currency === "JPY" ? 0 : 2;
}

function roundAmount(amount: number, digits = 2): number {
  const rounded = Number(amount.toFixed(digits));
  return rounded === 0 ? 0 : rounded;
}

function roundMoney(value: Money): Money {
  return { amount: roundAmount(value.amount, fractionDigits(value.currency)), currency: value.currency };
}

function marketCurrency(marketplace: Marketplace): string {
  return MARKETPLACE_BY_CODE[marketplace].currency;
}

function canonicalIndex(marketplace: Marketplace): number {
  return MARKETPLACE_CODES.indexOf(marketplace);
}

function compareTotals(left: Money, right: Money): number {
  return left.amount - right.amount;
}

function baselineDisplayTotal(
  baseline: ComparisonResult | undefined,
  currency: string,
  fxTable?: FxTable
): Money | undefined {
  if (!baseline || baseline.status !== "OK") {
    return undefined;
  }
  return displayTotal(baseline, currency, fxTable);
}

function remoteResults(baseline: ComparisonResult | undefined, results: ComparisonResult[]): ComparisonResult[] {
  return baseline ? results.filter((result) => result.marketplace !== baseline.marketplace) : results;
}

export function resolveDisplayCurrency(settingsCurrency: string, source?: SourceContext): string {
  if (settingsCurrency !== "SOURCE") {
    return settingsCurrency;
  }
  return source ? marketCurrency(source.marketplace) : "USD";
}

export function currencyChoices(source?: SourceContext, storedCurrency?: string): string[] {
  const leading = source ? [marketCurrency(source.marketplace)] : [];
  const stored = storedCurrency && storedCurrency !== "SOURCE" ? [storedCurrency] : [];
  return [...new Set<string>([...leading, ...DISPLAY_CURRENCIES, ...stored])];
}

export function deliveredLocalTotal(result: ComparisonResult, fxTable?: FxTable): Money | undefined {
  const { breakdown } = result;
  return deliveredTotal(breakdown) ?? (breakdown && fxTable ? deliveredTotalIn(breakdown, breakdown.item.currency, fxTable) : undefined);
}

export function displayTotal(result: ComparisonResult, currency: string, fxTable?: FxTable): Money | undefined {
  const local = deliveredTotal(result.breakdown);
  if (local && local.currency === currency) {
    return roundMoney(local);
  }
  const converted = fxTable ? deliveredTotalIn(result.breakdown, currency, fxTable) : undefined;
  if (converted) {
    return roundMoney(converted);
  }
  if (result.normalizedTotal && result.normalizedTotal.currency === currency) {
    return roundMoney(result.normalizedTotal);
  }
  return undefined;
}

function rankEntries(results: ComparisonResult[], currency: string, fxTable?: FxTable): RankedEntry[] {
  return results
    .filter((result) => result.status === "OK")
    .map((result) => ({ result, total: displayTotal(result, currency, fxTable) }))
    .filter((entry): entry is RankedEntry => entry.total !== undefined)
    .sort(
      (left, right) =>
        compareTotals(left.total, right.total) || left.result.marketplace.localeCompare(right.result.marketplace)
    );
}

export function rankAvailable(results: ComparisonResult[], currency: string, fxTable?: FxTable): ComparisonResult[] {
  return rankEntries(results, currency, fxTable).map((entry) => entry.result);
}

export function issues(results: ComparisonResult[]): ComparisonResult[] {
  return results
    .filter((result) => result.status !== "OK")
    .sort((left, right) => canonicalIndex(left.marketplace) - canonicalIndex(right.marketplace));
}

function checkPosition(order: Marketplace[]): (marketplace: Marketplace) => number {
  return (marketplace) => {
    const index = order.indexOf(marketplace);
    return index === -1 ? order.length + canonicalIndex(marketplace) : index;
  };
}

export function checkChips(
  results: ComparisonResult[],
  inFlight: MarketProgress[],
  order: Marketplace[]
): CheckChipEntry[] {
  const position = checkPosition(order);
  const finished = new Set(results.map((result) => result.marketplace));
  const entries: CheckChipEntry[] = [
    ...results.map((result) => ({ marketplace: result.marketplace, result })),
    ...inFlight.filter((entry) => !finished.has(entry.marketplace)).map(({ marketplace }) => ({ marketplace }))
  ];
  return entries.sort((left, right) => position(left.marketplace) - position(right.marketplace));
}

export function needsMatchCheck(result: ComparisonResult): boolean {
  return result.status === "OK" && result.confidence < MATCH_CHECK_THRESHOLD;
}

export function computeVerdict(
  baseline: ComparisonResult | undefined,
  results: ComparisonResult[],
  currency: string,
  fxTable?: FxTable
): Verdict {
  const baselineTotal = baselineDisplayTotal(baseline, currency, fxTable);
  const cheapest = rankEntries(remoteResults(baseline, results), currency, fxTable)[0];

  if (!cheapest) {
    return { kind: "none" };
  }
  const { result: best, total: bestTotal } = cheapest;
  if (!baselineTotal) {
    return { kind: "cheapest", best, bestTotal };
  }

  const digits = fractionDigits(currency);
  const savingAmount = roundAmount(baselineTotal.amount - bestTotal.amount, digits);
  if (savingAmount <= 0) {
    return { kind: "stay", baselineTotal };
  }

  return {
    kind: "save",
    best,
    bestTotal,
    baselineTotal,
    saving: { amount: savingAmount, currency },
    percent: (savingAmount / baselineTotal.amount) * 100
  };
}

export function rankedRows(
  baseline: ComparisonResult | undefined,
  results: ComparisonResult[],
  currency: string,
  fxTable?: FxTable
): RankedRow[] {
  const verdict = computeVerdict(baseline, results, currency, fxTable);
  const baselineTotal = baselineDisplayTotal(baseline, currency, fxTable);
  const bestResult = verdict.kind === "save" || verdict.kind === "cheapest" ? verdict.best : undefined;
  const digits = fractionDigits(currency);

  const rows: RankedRow[] = rankEntries(remoteResults(baseline, results), currency, fxTable).map(
    ({ result, total }) => ({
      result,
      total,
      delta: baselineTotal
        ? { amount: roundAmount(total.amount - baselineTotal.amount, digits), currency }
        : undefined,
      isSource: false,
      isBest: result === bestResult
    })
  );

  if (baseline && baselineTotal) {
    rows.push({
      result: baseline,
      total: baselineTotal,
      delta: { amount: 0, currency },
      isSource: true,
      isBest: verdict.kind === "stay"
    });
  }

  return rows.sort(
    (left, right) =>
      compareTotals(left.total, right.total) ||
      Number(right.isSource) - Number(left.isSource) ||
      left.result.marketplace.localeCompare(right.result.marketplace)
  );
}

export function formatDelta(delta: Money | undefined, isSource: boolean, locale = "en-US"): DeltaText {
  if (isSource) {
    return { text: "the page you are on", cls: "flat" };
  }
  if (!delta) {
    return { text: "", cls: "flat" };
  }
  if (delta.amount === 0) {
    return { text: "same price", cls: "flat" };
  }
  const magnitude = formatMoney({ amount: Math.abs(delta.amount), currency: delta.currency }, locale);
  return delta.amount < 0
    ? { text: `${MINUS_SIGN}${magnitude}`, cls: "down" }
    : { text: `+${magnitude}`, cls: "up" };
}

export function importFeesShown(result: ComparisonResult): boolean {
  return !result.breakdown || result.breakdown.importFees !== undefined;
}

export function costSentence(result: ComparisonResult): string {
  return importFeesShown(result)
    ? "Item, shipping and import fees included."
    : "Item and shipping included. Amazon showed no import fees, so duties may still be due on delivery.";
}

export function costLine(row: RankedRow): string {
  return importFeesShown(row.result) ? "incl. shipping & import" : "incl. shipping, import fees not shown";
}

export function sourceCostSentence(baseline: ComparisonResult | undefined, sourceDomain: string): string {
  return baseline && !importFeesShown(baseline)
    ? `The price on ${sourceDomain} leaves out import fees, which Amazon did not show.`
    : "";
}

export function importFeesValue(row: RankedRow, formatted: (value: Money) => string): string {
  const importFees = row.result.breakdown?.importFees;
  if (importFees?.amount) {
    return formatted(importFees);
  }
  return importFeesShown(row.result) ? "—" : "Not shown";
}

export function statusText(status: ComparisonStatus): string {
  return STATUS_TEXT[status];
}

const AMAZON_REASON_PREFIX = "Amazon says: ";
const OTHER_OFFERS_UNREAD_PREFIX = "Other offers could not be read: ";
const NO_OTHER_SELLER = "No other seller delivers the item new to the destination";
const LOCATION_NOT_OFFERED_PREFIX = "Delivery location not offered";
const LOCATION_SET_PREFIX = "Delivery location set to ";

function noteAfter(result: ComparisonResult, prefix: string): string | undefined {
  const note = result.notes?.find((entry) => entry.startsWith(prefix));
  return note?.slice(prefix.length).trim() || undefined;
}

function asSentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

export function issueNote(result: ComparisonResult, destinationCountryCode?: string): string {
  const destination = destinationCountryCode ? countryName(destinationCountryCode) : "your address";
  switch (result.status) {
    case "DESTINATION_MISMATCH":
      return result.notes?.some((note) => note.startsWith(LOCATION_NOT_OFFERED_PREFIX))
        ? `This store does not offer delivery to ${destination}.`
        : `Could not set this store's delivery location to ${destination}, so its price is for another place.`;
    case "UNAVAILABLE": {
      const reason = noteAfter(result, AMAZON_REASON_PREFIX);
      const unread = noteAfter(result, OTHER_OFFERS_UNREAD_PREFIX);
      return [
        `Amazon did not show a delivered price to ${destination}.`,
        ...(reason ? [`Amazon says: “${reason}”`] : []),
        ...(result.notes?.includes(NO_OTHER_SELLER) ? ["No other seller delivers the item new there either."] : []),
        ...(unread ? [asSentence(`${OTHER_OFFERS_UNREAD_PREFIX}${unread}`)] : [])
      ].join(" ");
    }
    case "PARSE_FAILED": {
      const robotCheckDomain = noteAfter(result, ROBOT_CHECK_NOTE_PREFIX);
      if (robotCheckDomain) {
        return `Amazon showed a robot check on ${robotCheckDomain} instead of the page.`;
      }
      if (result.notes?.includes(TIMED_OUT_NOTE)) {
        return "The check ran out of time before this store was read.";
      }
      return "The product page could not be read.";
    }
    case "NO_CONFIDENT_MATCH":
      return "No listing scored above the confidence floor.";
    default:
      return "";
  }
}

export function locationNote(result: ComparisonResult): string | undefined {
  return result.notes?.find((note) => note.startsWith(LOCATION_SET_PREFIX));
}

function completeReadSentence(listed: number, compared: number): string {
  if (listed <= 1) {
    return "The only offer Amazon lists that delivers new.";
  }
  if (compared === listed) {
    return `Cheapest of the ${listed} offers Amazon lists that deliver new.`;
  }
  return compared > 0
    ? `Cheapest of the ${compared} of the ${listed} offers Amazon lists that deliver new whose prices could be converted.`
    : `The first of the ${listed} offers Amazon lists that deliver new.`;
}

function partialReadSentence(listed: number, compared: number, scope: string): string {
  if (listed <= 1) {
    return `The only offer that delivers new ${scope}.`;
  }
  if (compared === listed) {
    return `Cheapest of the ${listed} offers that deliver new ${scope}.`;
  }
  return compared > 0
    ? `Cheapest of the ${compared} of the ${listed} offers that deliver new and whose prices could be converted, ${scope}.`
    : `The first of the ${listed} offers that deliver new ${scope}.`;
}

function unreadableSentence(readable: number, compared: number, scope: string): string {
  const converted = compared > 0 && compared < readable ? " and converted" : "";
  if (compared === 0) {
    return `${readable <= 1 ? "The only" : "The first"} offer whose prices could be read, ${scope}.`;
  }
  return compared === 1
    ? `The only offer whose prices could be read${converted}, ${scope}.`
    : `Cheapest of the ${compared} offers whose prices could be read${converted}, ${scope}.`;
}

function offersSentence(other: OtherSeller): string {
  const { deliveringNewCount: listed, comparedCount: compared = 0, readCount, offerCount, unreadableCount } = other;
  const total = offerCount > readCount ? ` of the ${offerCount} Amazon lists` : "";
  const partialScope = `among the first ${readCount} read${total}`;
  if (unreadableCount > 0) {
    const scope = other.readComplete ? `of the ${listed + unreadableCount} Amazon lists that deliver new` : partialScope;
    return unreadableSentence(listed, compared, scope);
  }
  return other.readComplete ? completeReadSentence(listed, compared) : partialReadSentence(listed, compared, partialScope);
}

export function otherSellerNote(result: ComparisonResult): string | undefined {
  const other = result.otherSeller;
  if (!other) {
    return undefined;
  }
  const dispatcher = other.fulfilledByAmazon ? "Amazon" : other.dispatcher;
  const soldBy = `Sold by ${other.seller ?? "another seller"}${dispatcher ? `, dispatched by ${dispatcher}` : ""}.`;
  return `${soldBy} ${offersSentence(other)}`;
}

export function phaseLabel(phase?: ComparisonPhase): string {
  return phase ? PHASE_LABEL[phase] : PHASE_LABEL.OPEN;
}

export function startingMarkets(runTargets: Marketplace[]): MarketProgress[] {
  return runTargets.slice(0, MARKET_CONCURRENCY).map((marketplace) => ({ marketplace, phase: "OPEN" }));
}

export function shownMarket(inFlight: MarketProgress[], latest?: MarketProgress): MarketProgress | undefined {
  return inFlight.find((entry) => entry.marketplace === latest?.marketplace) ?? inFlight[0];
}

export function trustSentence(result: ComparisonResult, isSource = false): string {
  if (isSource) {
    return SOURCE_TRUST_SENTENCE;
  }
  const percent = Math.round(Math.min(1, Math.max(0, result.confidence)) * 100);
  return needsMatchCheck(result)
    ? `We are ${percent}% sure this is the same product.`
    : `We are ${percent}% sure this is the same product — title, brand and variant all line up.`;
}

export function estimatedSeconds(targetCount: number): number {
  return Math.max(MIN_ESTIMATED_SECONDS, Math.ceil(targetCount / MARKET_CONCURRENCY) * SECONDS_PER_ROUND);
}

export function targetMarkets(settings: ExtensionSettings, source?: SourceContext): Marketplace[] {
  return settings.enabledMarketplaces.filter((market) => market !== source?.marketplace);
}

export function formatVariantTokens(tokens: string[]): string {
  return tokens.map((token) => token.charAt(0).toUpperCase() + token.slice(1)).join(" · ");
}

export function percentFormat(percent: number): string {
  return Number.isFinite(percent) ? String(Math.round(Math.abs(percent))) : "0";
}

export function progressPercent(completed: number, total: number): number {
  if (total <= 0) {
    return 0;
  }
  return Math.round((Math.min(Math.max(completed, 0), total) / total) * 100);
}

export function checkLabel(targetCount: number): string {
  return `Check ${targetCount} other ${targetCount === 1 ? "Amazon" : "Amazons"}`;
}

export function issuesLabel(issueCount: number): string {
  return `${issueCount} ${issueCount === 1 ? "marketplace" : "marketplaces"} could not be compared`;
}

export function formatLocal(value: Money, marketplace: Marketplace): string {
  return formatMoney(value, MARKETPLACE_BY_CODE[marketplace].locale);
}
