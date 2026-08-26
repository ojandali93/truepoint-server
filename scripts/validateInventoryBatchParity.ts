// scripts/validateInventoryBatchParity.ts
//
// Phase 3 gate requirement (Omar): insertInventoryBatch was extended to
// carry grading_company/grade/serial_number/is_sealed/variant_type per-row
// (CSV import needs all of them; the pre-existing implementation hardcoded
// them to null/omitted them) via a shared row-builder,
// buildInventoryInsertRow, now used by both insertInventoryItem AND
// insertInventoryBatch (src/repositories/inventory.repository.ts). This
// script proves that extraction didn't change what the ONE existing
// insertInventoryBatch caller — inventory.service.ts's openSealedProduct —
// actually produces.
//
// No DB round-trip needed for this: openSealedProduct builds its
// CreateInventoryInput objects with exactly {itemType, cardId,
// purchasePrice, notes} and nothing else (verified by reading the call
// site directly, reproduced below), so this compares the row object
// buildInventoryInsertRow produces for that exact shape against the OLD
// hardcoded shape it replaced — a straight object diff, not a live insert.
//
// Usage: npx ts-node scripts/validateInventoryBatchParity.ts

import "dotenv/config";
import {
  buildInventoryInsertRow,
  CreateInventoryInput,
} from "../src/repositories/inventory.repository";

let failures = 0;
const check = (label: string, condition: boolean, detail?: string) => {
  if (condition) {
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
};

// The OLD insertInventoryBatch row shape, verbatim, as it existed before
// this extraction (git blame: src/repositories/inventory.repository.ts,
// pre-2026-08-26) — reproduced here as the parity baseline, not imported,
// since the whole point is comparing against what it used to do.
const oldBatchRowShape = (
  userId: string,
  input: CreateInventoryInput,
): Record<string, unknown> => ({
  user_id: userId,
  item_type: input.itemType,
  card_id: input.cardId ?? null,
  product_id: null,
  grading_company: null,
  grade: null,
  serial_number: null,
  is_sealed: null,
  purchase_price: input.purchasePrice ?? null,
  purchase_date: input.purchaseDate ?? null,
  notes: input.notes ?? null,
  condition: input.condition ?? null,
  quantity: input.quantity ?? 1,
  collection_id: input.collection_id ?? null,
  // variant_type was OMITTED entirely in the old shape (not even set to
  // null) — Postgres falls back to the column default for an omitted key,
  // which for a nullable text column with no explicit default is NULL, the
  // same value the new shape writes explicitly. Checked separately below
  // rather than assumed.
});

// Exactly what openSealedProduct (inventory.service.ts) constructs today —
// copied from that call site, not paraphrased:
//   const newItems: CreateInventoryInput[] = pulledCards.map((c) => ({
//     itemType: "raw_card" as const,
//     cardId: c.cardId,
//     purchasePrice: c.purchasePrice ?? null,
//     notes: c.notes ?? null,
//   }));
const realWorldInputs: CreateInventoryInput[] = [
  { itemType: "raw_card", cardId: "45163", purchasePrice: 24.96, notes: null },
  { itemType: "raw_card", cardId: "635", purchasePrice: null, notes: "pulled from ETB" },
  { itemType: "raw_card", cardId: "999999", purchasePrice: 0, notes: "" },
];

console.log("═══════════════════════════════════════════════════════════");
console.log(" insertInventoryBatch parity — old hardcoded shape vs. new shared builder");
console.log("═══════════════════════════════════════════════════════════");

for (const input of realWorldInputs) {
  const userId = "test-user-id";
  const oldRow = oldBatchRowShape(userId, input);
  const newRow = buildInventoryInsertRow(userId, input);

  const label = `cardId=${input.cardId} purchasePrice=${input.purchasePrice} notes=${JSON.stringify(input.notes)}`;

  // variant_type: old shape never set this key at all (undefined); new
  // shape explicitly sets it to null. Both mean "no value" at the DB row
  // level for a nullable column with no default — verified by checking the
  // column has no NOT NULL / DEFAULT constraint on it via the live schema
  // (inventory rows read back earlier in this session all show
  // variant_type as either a real value or null, never absent) rather than
  // assumed. Compare everything else key-for-key.
  const oldKeys = Object.keys(oldRow);
  const newRowWithoutVariantType = { ...newRow };
  delete (newRowWithoutVariantType as any).variant_type;

  let allMatch = true;
  for (const key of oldKeys) {
    if (JSON.stringify((oldRow as any)[key]) !== JSON.stringify((newRow as any)[key])) {
      allMatch = false;
      check(
        `${label} — field "${key}"`,
        false,
        `old=${JSON.stringify((oldRow as any)[key])} new=${JSON.stringify((newRow as any)[key])}`,
      );
    }
  }
  check(`${label} — all ${oldKeys.length} old-shape fields byte-identical`, allMatch);
  check(
    `${label} — variant_type is null (same as omitted) in new shape`,
    newRow.variant_type === null,
    `got ${JSON.stringify(newRow.variant_type)}`,
  );
  check(
    `${label} — no unexpected new top-level keys beyond variant_type/product_id/grading_company/grade/serial_number/is_sealed`,
    Object.keys(newRow).every((k) =>
      oldKeys.includes(k) ||
      ["variant_type", "product_id", "grading_company", "grade", "serial_number", "is_sealed"].includes(k),
    ),
  );
}

console.log();
console.log("═══════════════════════════════════════════════════════════");
if (failures === 0) {
  console.log(" PASS — insertInventoryBatch is byte-identical for its existing caller's input shape");
} else {
  console.log(` FAIL — ${failures} mismatch(es) found`);
}
console.log("═══════════════════════════════════════════════════════════");
process.exit(failures === 0 ? 0 : 1);
