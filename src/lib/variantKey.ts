// src/lib/variantKey.ts
//
// Normalizes a variant_type string into the lookup key used to match a
// scanner-recorded inventory variant against a card_variants row (lowercase,
// alphanumeric only). "Reverse Holofoil" → "reverseholofoil",
// "reverse_holofoil" → "reverseholofoil" — so an inventory entry and the
// canonical variant row match regardless of formatting.
//
// Extracted from two identical copies that had drifted into
// inventory.service.ts and inventory.repository.ts independently — both now
// import from here instead of keeping their own. Also reused by
// portfolioMovers.service.ts to join inventory.variant_type against
// card_price_history.variant with the same normalization live pricing uses.
export const variantKey = (v: string | null | undefined): string =>
  (v ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
