import type { MatchScore, Marketplace, SearchCandidate, SourceContext, VariantOption } from "./types";

const TITLE_WEIGHT = 0.45;
const BRAND_WEIGHT = 0.25;
const VARIATION_WEIGHT = 0.3;

export const MATCH_THRESHOLD = 0.78;

const STOPWORDS: Record<Marketplace, string[]> = {
  US: ["the", "for", "and", "with", "by", "from"],
  CA: ["the", "for", "and", "with", "by", "from"],
  MX: ["para", "con", "por", "de", "la", "el", "y"],
  UK: ["the", "for", "and", "with", "by", "from"],
  DE: ["und", "mit", "für", "von", "der", "die", "das"],
  FR: ["et", "avec", "pour", "de", "la", "le", "les"],
  IT: ["e", "con", "per", "di", "la", "il", "gli"],
  ES: ["y", "con", "para", "de", "la", "el", "los"],
  JP: ["の", "と", "に", "を", "で", "向け"],
  AU: ["the", "for", "and", "with", "by", "from"]
};

function jaccardSimilarity(sourceTokens: string[], candidateTokens: string[]): number {
  const source = new Set(sourceTokens);
  const candidate = new Set(candidateTokens);

  const intersectionSize = [...source].filter((token) => candidate.has(token)).length;
  const unionSize = new Set([...source, ...candidate]).size;

  if (unionSize === 0) {
    return 0;
  }

  return intersectionSize / unionSize;
}

export function normalizeText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenizeTitle(title: string, marketplace: Marketplace): string[] {
  const normalized = normalizeText(title);
  const stopwords = new Set(STOPWORDS[marketplace]);
  return normalized
    .split(" ")
    .filter((token) => token.length > 1)
    .filter((token) => !stopwords.has(token));
}

export function normalizeBrand(brand?: string): string {
  if (!brand) {
    return "";
  }

  return normalizeText(brand).replace(/\s+/g, "");
}

const MODEL_TOKEN = /\b(?=[a-z0-9-]*\d)(?=[a-z0-9-]*[a-z])[a-z0-9]+(?:-[a-z0-9]+)*\b/g;
const MIN_MODEL_TOKEN_LENGTH = 3;
const MODEL_CONFLICT_CAP = 0.5;
const BRAND_IN_TITLE_SCORE = 0.75;
const COLOR_TOKENS = new Set(["black", "white", "blue", "red", "green", "silver", "gold", "pink"]);

function isModelPart(part: string): boolean {
  return part.length >= MIN_MODEL_TOKEN_LENGTH && /\d/.test(part) && /[a-z]/.test(part);
}

function foldText(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

export function extractModelTokens(value: string): string[] {
  const folded = foldText(value);
  const tokens = new Set<string>();

  for (const match of folded.match(MODEL_TOKEN) ?? []) {
    const joined = match.replace(/-/g, "");
    if (joined.length >= MIN_MODEL_TOKEN_LENGTH) {
      tokens.add(joined);
    }
    for (const part of match.split("-")) {
      if (isModelPart(part)) {
        tokens.add(part);
      }
    }
  }

  return [...tokens];
}

const PACK_PATTERN = String.raw`\d+\s?(?:pack|count|ct|pcs|piece|pieces|pk)`;
const SIZE_PATTERN = String.raw`\d+(?:\.\d+)?\s?(?:oz|ml|l|kg|g|cm|mm|in)`;
const PACK_TOKEN = new RegExp(`^${PACK_PATTERN}$`);
const SIZE_TOKEN = new RegExp(`^${SIZE_PATTERN}$`);
const ATTRIBUTE_KINDS = ["pack", "size", "colour"] as const;

export function extractAttributeTokens(value: string): string[] {
  const normalized = normalizeText(value);
  const packMatches = normalized.match(new RegExp(String.raw`\b${PACK_PATTERN}\b`, "g")) ?? [];
  const sizeMatches = normalized.match(new RegExp(String.raw`\b${SIZE_PATTERN}\b`, "g")) ?? [];
  const colorMatches = normalized.split(" ").filter((token) => COLOR_TOKENS.has(token));

  return [...new Set([...packMatches, ...sizeMatches, ...colorMatches])];
}

function attributeKind(token: string): (typeof ATTRIBUTE_KINDS)[number] {
  if (PACK_TOKEN.test(token)) {
    return "pack";
  }
  return SIZE_TOKEN.test(token) ? "size" : "colour";
}

function sourceAttributeTokens(source: SourceContext): string[] {
  return [...new Set([...source.variationTokens.flatMap(extractAttributeTokens), ...extractAttributeTokens(source.title)])];
}

function attributesConflict(wanted: string[], offered: string[]): boolean {
  return ATTRIBUTE_KINDS.some((kind) => {
    const wantedOfKind = wanted.filter((token) => attributeKind(token) === kind);
    const offeredOfKind = offered.filter((token) => attributeKind(token) === kind);
    return (
      wantedOfKind.length > 0 && offeredOfKind.length > 0 && !wantedOfKind.some((token) => offeredOfKind.includes(token))
    );
  });
}

export function variantConflicts(source: SourceContext, selectedVariants: string[]): boolean {
  return attributesConflict(sourceAttributeTokens(source), selectedVariants.flatMap(extractAttributeTokens));
}

export function findSourceVariant(source: SourceContext, options: VariantOption[]): VariantOption | undefined {
  const wanted = sourceAttributeTokens(source);
  return options.find((option) => {
    const offered = extractAttributeTokens(option.label);
    return offered.some((token) => wanted.includes(token)) && !attributesConflict(wanted, offered);
  });
}

export function extractVariationTokens(value: string): string[] {
  return [...new Set([...extractModelTokens(value), ...extractAttributeTokens(value)])];
}

function brandSimilarity(sourceBrand: string | undefined, candidateBrand: string | undefined, candidateTitle: string): number {
  const source = normalizeBrand(sourceBrand);
  const candidate = normalizeBrand(candidateBrand);

  if (!source) {
    return 0;
  }

  if (!candidate) {
    const sourceWords = normalizeText(sourceBrand ?? "");
    return ` ${normalizeText(candidateTitle)} `.includes(` ${sourceWords} `) ? BRAND_IN_TITLE_SCORE : 0;
  }

  if (source === candidate) {
    return 1;
  }

  if (source.includes(candidate) || candidate.includes(source)) {
    return 0.75;
  }

  const sourceTokens = source.match(/[a-z0-9]+/g) ?? [];
  const candidateTokens = candidate.match(/[a-z0-9]+/g) ?? [];
  return jaccardSimilarity(sourceTokens, candidateTokens) * 0.7;
}

interface ModelNumber {
  whole: string;
  parts: string[];
  isBare: boolean;
}

function readModelNumbers(value: string): ModelNumber[] {
  return (foldText(value).match(MODEL_TOKEN) ?? [])
    .map((match) => {
      const segments = match.split("-");
      return { whole: segments.join(""), parts: segments.filter(isModelPart), isBare: segments.length === 1 };
    })
    .filter((model) => model.whole.length >= MIN_MODEL_TOKEN_LENGTH);
}

function isSameModel(left: ModelNumber, right: ModelNumber): boolean {
  return (
    left.whole === right.whole ||
    (right.isBare && left.parts.includes(right.whole)) ||
    (left.isBare && right.parts.includes(left.whole))
  );
}

const MODEL_TITLE_FLOOR = 0.7;
const MIN_DISTINCTIVE_MODEL_LENGTH = 5;
const MEASUREMENT = /^\d+[a-z]+$/;
const BUNDLE_MARKER = /\s[+&]\s|\bbundle\b/i;

function isDistinctiveModel(model: ModelNumber): boolean {
  const letters = model.whole.match(/[a-z]/g)?.length ?? 0;
  const digits = model.whole.match(/\d/g)?.length ?? 0;
  return (
    model.whole.length >= MIN_DISTINCTIVE_MODEL_LENGTH && letters >= 2 && digits >= 2 && !MEASUREMENT.test(model.whole)
  );
}

function sharesDistinctiveModel(sourceTitle: string, candidateTitle: string): boolean {
  const sourceModels = readModelNumbers(sourceTitle).filter(isDistinctiveModel);
  const candidateModels = readModelNumbers(candidateTitle).filter(isDistinctiveModel);
  return (
    candidateModels.length > 0 &&
    candidateModels.every((candidate) => sourceModels.some((source) => isSameModel(source, candidate)))
  );
}

function isSameBrandAndModel(source: SourceContext, candidate: SearchCandidate): boolean {
  const brand = normalizeBrand(source.brand);
  return (
    brand !== "" &&
    brand === normalizeBrand(candidate.brand) &&
    !BUNDLE_MARKER.test(candidate.title) &&
    sharesDistinctiveModel(source.title, candidate.title)
  );
}

function hasModelConflict(sourceTitle: string, candidateTitle: string): boolean {
  const sourceModels = readModelNumbers(sourceTitle);
  const candidateModels = readModelNumbers(candidateTitle);
  return (
    sourceModels.length > 0 &&
    candidateModels.length > 0 &&
    !sourceModels.some((source) => candidateModels.some((candidate) => isSameModel(source, candidate)))
  );
}

function variationSimilarity(sourceTokens: string[], candidateTokens: string[]): number {
  if (sourceTokens.length === 0 || candidateTokens.length === 0) {
    return 0;
  }

  return jaccardSimilarity(sourceTokens, candidateTokens);
}

export function confidenceLabel(score: number): "HIGH" | "MEDIUM" | "LOW" {
  if (score >= 0.9) {
    return "HIGH";
  }

  if (score >= MATCH_THRESHOLD) {
    return "MEDIUM";
  }

  return "LOW";
}

export function normalizeAsin(asin?: string): string {
  return asin?.trim().toUpperCase() ?? "";
}

export function sharesSourceAsin(
  source: SourceContext,
  listing: { marketplace: Marketplace; asin?: string; title?: string }
): boolean {
  const asin = normalizeAsin(listing.asin);
  if (!asin || asin !== normalizeAsin(source.asin) || !listing.title) {
    return false;
  }

  const sourceTitleTokens = tokenizeTitle(source.title, source.marketplace);
  const listingTitleTokens = tokenizeTitle(listing.title, listing.marketplace);
  return jaccardSimilarity(sourceTitleTokens, listingTitleTokens) > 0;
}

export function computeMatchScore(source: SourceContext, candidate: SearchCandidate): MatchScore {
  const sourceTitleTokens = tokenizeTitle(source.title, source.marketplace);
  const candidateTitleTokens = tokenizeTitle(candidate.title, candidate.marketplace);
  const sourceAttributes = sourceAttributeTokens(source);
  const candidateAttributes = extractAttributeTokens(candidate.title);

  const titleSimilarity = jaccardSimilarity(sourceTitleTokens, candidateTitleTokens);
  const titleScore =
    isSameBrandAndModel(source, candidate) && !attributesConflict(sourceAttributes, candidateAttributes)
      ? Math.max(titleSimilarity, MODEL_TITLE_FLOOR)
      : titleSimilarity;
  const brandScore = brandSimilarity(source.brand, candidate.brand, candidate.title);
  const variationScore = variationSimilarity(sourceAttributes, candidateAttributes);

  if (sharesSourceAsin(source, candidate)) {
    return { total: 1, titleScore, brandScore, variationScore, confidenceLabel: "HIGH" };
  }

  const brandWeight = normalizeBrand(source.brand) ? BRAND_WEIGHT : 0;
  const variationWeight = sourceAttributes.length > 0 && candidateAttributes.length > 0 ? VARIATION_WEIGHT : 0;
  const weighted =
    (titleScore * TITLE_WEIGHT + brandScore * brandWeight + variationScore * variationWeight) /
    (TITLE_WEIGHT + brandWeight + variationWeight);
  const capped = hasModelConflict(source.title, candidate.title) ? Math.min(weighted, MODEL_CONFLICT_CAP) : weighted;
  const total = Number(capped.toFixed(4));

  return {
    total,
    titleScore,
    brandScore,
    variationScore,
    confidenceLabel: confidenceLabel(total)
  };
}

export function pickBestCandidate(
  source: SourceContext,
  candidates: SearchCandidate[]
): { candidate: SearchCandidate; score: MatchScore } | undefined {
  const sourceAsin = normalizeAsin(source.asin);
  const carriesSourceAsin = (candidate: SearchCandidate): number =>
    sourceAsin && normalizeAsin(candidate.asin) === sourceAsin ? 1 : 0;

  const scored = candidates
    .map((candidate) => ({
      candidate,
      score: computeMatchScore(source, candidate)
    }))
    .sort(
      (left, right) =>
        right.score.total - left.score.total || carriesSourceAsin(right.candidate) - carriesSourceAsin(left.candidate)
    );

  const best = scored[0];
  if (!best || best.score.total < MATCH_THRESHOLD) {
    return undefined;
  }

  return best;
}
