// src/lib/variantMatch.ts
//
// The raw-card price fallback strategy used by inventory.service.ts's live
// pricing (resolveMarketValue) — extracted so portfolioMovers.service.ts can
// apply the IDENTICAL exact→representative fallback to historical prices
// instead of re-deriving its own version of the same rule.
//
// Strategy:
//   1. Exact variant match — the inventory item's variant_type, normalized
//      via variantKey(), looked up directly.
//   2. Representative "any variant on this card" — used when the exact
//      variant has no price (e.g. the scanner mis-tagged the variant), so
//      the value isn't zero. Approximate until the variant is corrected.
//
// Both maps are keyed the same way regardless of whether the caller built
// them from LIVE prices (card_variants, via inventory.repository's
// fetchVariantPrices) or a HISTORICAL snapshot reduced down to one price per
// key for a target date (portfolioMovers.repository) — this function has no
// opinion about where the numbers came from, only how to pick between them.
import { variantKey } from "./variantKey";

export function matchVariantPrice(
  exactByKey: Map<string, number>,
  anyByCard: Map<string, number>,
  cardId: string,
  variantType: string | null | undefined,
): number | null {
  const exact = exactByKey.get(`${cardId}|${variantKey(variantType)}`);
  if (exact != null) return exact;

  const anyV = anyByCard.get(cardId);
  if (anyV != null) return anyV;

  return null;
}
