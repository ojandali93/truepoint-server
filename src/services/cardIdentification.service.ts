import {
  identifyCardFromBase64,
  identifyCardFromUrl,
  CardIdentificationResult,
} from "../lib/geminiClient";
import { getAllPricesForCard } from "./pricing.service";
import { PokemonCard } from "../types/pokemon.types";
import { logError } from "../lib/Logger";

export interface CardScanResult {
  identification: CardIdentificationResult;
  matchedCard: PokemonCard | null;
  matchConfidence: "exact" | "probable" | "unverified" | "failed";
  prices: Awaited<ReturnType<typeof getAllPricesForCard>> | null;
  searchQuery: string | null;
}

// Bug fix (counterfeit-screening Phase 0, 2026-09-01): this used to emit a
// field:"value" query DSL ('name:"Lugia V" number:169') that searchCards'
// actual implementation (applyCardNameNumberSearch, src/lib/cardSearch.ts)
// has no concept of — it just ILIKE-matches whatever whitespace-separated
// tokens it's given against name/number columns directly, so a literal
// 'name:"Lugia' token never matched anything in the name column. This
// silently broke EVERY identification-to-catalog match (matchConfidence
// was always "failed", verified live pre-fix) — including this feature's
// existing production consumer, browse/scan.tsx's card-scan-to-identify
// flow, which this same service already backs. Plain space-separated
// tokens are what applyCardNameNumberSearch actually parses (see its own
// header comment) — verified live post-fix that real matches come back.
const buildSearchQuery = (id: CardIdentificationResult): string | null => {
  const parts: string[] = [];
  if (id.cardName) parts.push(id.cardName);
  if (id.cardNumber) parts.push(id.cardNumber);
  return parts.length > 0 ? parts.join(" ") : null;
};

const scoreMatch = (
  id: CardIdentificationResult,
  card: PokemonCard,
): "exact" | "probable" | "unverified" => {
  let score = 0;
  if (
    id.cardName &&
    card.name.toLowerCase().includes(id.cardName.toLowerCase())
  )
    score += 3;
  if (id.cardNumber && card.number === id.cardNumber) score += 3;
  if (
    id.setName &&
    card.set.name.toLowerCase().includes(id.setName.toLowerCase())
  )
    score += 2;
  if (id.hp && card.hp === id.hp) score += 1;
  if (id.rarity && card.rarity?.toLowerCase().includes(id.rarity.toLowerCase()))
    score += 1;

  if (score >= 6) return "exact";
  if (score >= 3) return "probable";
  return "unverified";
};

const runIdentification = async (
  id: CardIdentificationResult,
): Promise<CardScanResult> => {
  const searchQuery = buildSearchQuery(id);

  if (!searchQuery || id.confidence === "low") {
    return {
      identification: id,
      matchedCard: null,
      matchConfidence: "failed",
      prices: null,
      searchQuery,
    };
  }

  try {
    const { searchCards } = await import("./card.service");
    const results = await searchCards({ q: searchQuery ?? "", pageSize: 5 });
    const topMatch = results.data[0] ?? null;

    if (!topMatch) {
      return {
        identification: id,
        matchedCard: null,
        matchConfidence: "failed",
        prices: null,
        searchQuery,
      };
    }

    const matchConfidence = scoreMatch(id, topMatch);

    const prices =
      matchConfidence === "exact" || matchConfidence === "probable"
        ? await getAllPricesForCard(topMatch.id)
        : null;

    return {
      identification: id,
      matchedCard: topMatch,
      matchConfidence,
      prices,
      searchQuery,
    };
  } catch (err: any) {
    await logError({
      source: "identify-card-from-tcgapis", // ← change per controller
      message: (err as any)?.message ?? "Unknown error",
      error: err,
      userId: null,
      requestPath: "",
      requestMethod: "",
      metadata: {},
    });
    return {
      identification: id,
      matchedCard: null,
      matchConfidence: "failed",
      prices: null,
      searchQuery,
    };
  }
};

export const identifyFromBase64 = async (
  base64Image: string,
  mimeType: "image/jpeg" | "image/png" | "image/webp" = "image/jpeg",
): Promise<CardScanResult> => {
  const id = await identifyCardFromBase64(base64Image, mimeType);
  return runIdentification(id);
};

export const identifyFromUrl = async (
  imageUrl: string,
): Promise<CardScanResult> => {
  const id = await identifyCardFromUrl(imageUrl);
  return runIdentification(id);
};
