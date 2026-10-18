import { MARKETPLACE_BY_CODE, countryName } from "../shared/markets";
import { convertMoney, formatMoney } from "../shared/money";
import type {
  ComparisonPhase,
  ComparisonResult,
  ComparisonStatus,
  ExtensionSettings,
  FxTable,
  Marketplace,
  Money,
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

const MATCH_CHECK_THRESHOLD = 0.9;
const SECONDS_PER_MARKET = 3;
const MIN_ESTIMATED_SECONDS = 5;
const MINUS_SIGN = "−";
const MATCH_CONFIDENCE_NOTE = /^match confidence:/i;

const STATUS_TEXT: Record<ComparisonStatus, string> = {
  OK: "Available",
  UNAVAILABLE: "Delivered total not quotable",
  DESTINATION_MISMATCH: "Does not ship here",
  PARSE_FAILED: "Could not read the page",
  NO_CONFIDENT_MATCH: "No confident match"
};

const PHASE_LABEL: Record<ComparisonPhase, string> = {
  OPEN: "Opening tab",
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

function asSentence(note: string): string {
  const trimmed = note.trim();
  return /[.!?…]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function noteText(notes: string[] | undefined): string {
  return (notes ?? [])
    .map((note) => note.trim())
    .filter((note) => note.length > 0 && !MATCH_CONFIDENCE_NOTE.test(note))
    .map(asSentence)
    .join(" ");
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

export function currencyChoices(source?: SourceContext): string[] {
  const leading = source ? [marketCurrency(source.marketplace)] : [];
  return [...new Set<string>([...leading, ...DISPLAY_CURRENCIES])];
}

export function deliveredLocalTotal(result: ComparisonResult): Money | undefined {
  const breakdown = result.breakdown;
  if (!breakdown) {
    return undefined;
  }
  if (breakdown.totalDisplayed) {
    return { ...breakdown.totalDisplayed };
  }
  const amount = breakdown.item.amount + (breakdown.shipping?.amount ?? 0) + (breakdown.importFees?.amount ?? 0);
  return { amount: roundAmount(amount), currency: breakdown.item.currency };
}

export function displayTotal(result: ComparisonResult, currency: string, fxTable?: FxTable): Money | undefined {
  const local = deliveredLocalTotal(result);
  if (local && local.currency === currency) {
    return roundMoney(local);
  }
  if (local && fxTable) {
    const converted = convertMoney(local, currency, fxTable);
    if (converted) {
      return roundMoney(converted);
    }
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
  return results.filter((result) => result.status !== "OK");
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

export function statusText(status: ComparisonStatus): string {
  return STATUS_TEXT[status];
}

export function issueNote(result: ComparisonResult, destinationCountryCode?: string): string {
  const fromNotes = noteText(result.notes);
  if (fromNotes) {
    return fromNotes;
  }
  const destination = destinationCountryCode ? countryName(destinationCountryCode) : "your address";
  switch (result.status) {
    case "DESTINATION_MISMATCH":
      return `Match found, but the seller does not ship to ${destination}.`;
    case "UNAVAILABLE":
      return "Amazon did not show a delivered price for this destination.";
    case "PARSE_FAILED":
      return "The product page could not be read.";
    case "NO_CONFIDENT_MATCH":
      return "No listing scored above the confidence floor.";
    default:
      return "";
  }
}

export function phaseLabel(phase?: ComparisonPhase): string {
  return phase ? PHASE_LABEL[phase] : PHASE_LABEL.OPEN;
}

export function trustSentence(result: ComparisonResult): string {
  const percent = Math.round(Math.min(1, Math.max(0, result.confidence)) * 100);
  const lead = needsMatchCheck(result)
    ? `We are ${percent}% sure this is the same product.`
    : `We are ${percent}% sure this is the same product — title, brand and variant all line up.`;
  const note = noteText(result.notes);
  return note ? `${lead} ${note}` : lead;
}

export function estimatedSeconds(targetCount: number): number {
  return Math.max(MIN_ESTIMATED_SECONDS, SECONDS_PER_MARKET * targetCount);
}

export function targetMarkets(settings: ExtensionSettings, source?: SourceContext): Marketplace[] {
  return settings.enabledMarketplaces.filter((market) => market !== source?.marketplace);
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
