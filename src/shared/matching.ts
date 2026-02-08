import type { MatchScore, Marketplace, SearchCandidate, SourceContext } from "./types";

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

export function extractVariationTokens(value: string): string[] {
  const normalized = normalizeText(value);
  const modelMatches = normalized.match(/[a-z]{1,4}\d{2,}[a-z0-9-]*/g) ?? [];
  const packMatches = normalized.match(/\b\d+\s?(?:pack|count|ct|pcs|piece|pieces|pk)\b/g) ?? [];
  const sizeMatches = normalized.match(/\b\d+(?:\.\d+)?\s?(?:oz|ml|l|kg|g|cm|mm|in)\b/g) ?? [];

  const colorMatches = normalized
    .split(" ")
    .filter((token) => ["black", "white", "blue", "red", "green", "silver", "gold", "pink"].includes(token));

  const tokenSet = new Set([...modelMatches, ...packMatches, ...sizeMatches, ...colorMatches]);
  return [...tokenSet];
}

function brandSimilarity(sourceBrand?: string, candidateBrand?: string): number {
  const source = normalizeBrand(sourceBrand);
  const candidate = normalizeBrand(candidateBrand);

  if (!source || !candidate) {
    return 0;
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

export function computeMatchScore(source: SourceContext, candidate: SearchCandidate): MatchScore {
  const sourceTitleTokens = tokenizeTitle(source.title, source.marketplace);
  const candidateTitleTokens = tokenizeTitle(candidate.title, candidate.marketplace);
  const sourceVariation = source.variationTokens;
  const candidateVariation = extractVariationTokens(candidate.title);

  const titleScore = jaccardSimilarity(sourceTitleTokens, candidateTitleTokens);
  const brandScore = brandSimilarity(source.brand, candidate.brand);
  const variationScore = variationSimilarity(sourceVariation, candidateVariation);

  const total =
    Number((titleScore * TITLE_WEIGHT + brandScore * BRAND_WEIGHT + variationScore * VARIATION_WEIGHT).toFixed(4));

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
  const scored = candidates
    .map((candidate) => ({
      candidate,
      score: computeMatchScore(source, candidate)
    }))
    .sort((left, right) => right.score.total - left.score.total);

  const best = scored[0];
  if (!best || best.score.total < MATCH_THRESHOLD) {
    return undefined;
  }

  return best;
}
