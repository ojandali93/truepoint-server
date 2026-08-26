// scripts/validateGradedPricePrecedence.ts
//
// Validates CLAUDE.md §6's amended graded-pricing contract (LOCKED
// 2026-08-25, AMENDED 2026-08-25) against the pure aggregation/filter
// functions extracted from inventory.repository.ts (aggregateCardPrices)
// and poketracePriceSync.service.ts (filterGradedPriceRows) specifically so
// this can run without a mocking framework — this repo has no test runner
// installed (no jest/vitest/mocha in package.json), so this follows the
// existing scripts/validateMovers.ts convention: a runnable, assertion-based
// script with a PASS/FAIL banner and a process exit code.
//
// LIVE DATA, not synthetics (updated 2026-08-25 after the PriceCharting
// sync's slice run and full run both landed real rows): every assertion
// below that has a real-world analog now reads the ACTUAL rows sitting in
// market_prices for both source='poketrace' and source='pricecharting' —
// no hand-constructed price fixtures. The two exceptions are explicitly
// labeled "SYNTHETIC (necessarily)" — they test behavior against inputs
// that can never occur from a correctly-functioning sync (a PokeTrace row
// at the Black Label tier; a PriceCharting row at a sub-10 tier), so there
// is no live row to point at by definition. Kept as defense-in-depth, not
// passed off as production data.
//
// Usage: npx ts-node scripts/validateGradedPricePrecedence.ts

import "dotenv/config";
import { aggregateCardPrices, MarketPriceRow } from "../src/repositories/inventory.repository";
import {
  filterGradedPriceRows,
  RawGradedPriceRow,
} from "../src/services/poketracePriceSync.service";
import {
  filterGradePricesForCard,
  RawGradeRow,
} from "../src/services/gradingArbitrage.service";
import { getGradeLadder } from "../src/services/regradeTracker.service";
import {
  parseGradeString,
  isTenPlusGrade,
  sourceAllowedAtTier,
} from "../src/lib/gradedPricePrecedence";
import { supabaseAdmin } from "../src/lib/supabase";

let failures = 0;
const check = (label: string, condition: boolean, detail?: string) => {
  if (condition) {
    console.log(`  ✅ ${label}`);
  } else {
    failures++;
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
  }
};

// Non-failing diagnostic — for observations that are useful to print but
// aren't themselves proof of anything (see the grade-string-truncation-bug
// note in section 4: a company+grade lookup can land on a mislabeled row by
// pure luck of array order, so it can't be trusted to gate PASS/FAIL).
const note = (label: string, condition: boolean, detail?: string) => {
  console.log(`  ${condition ? "ℹ️ " : "⚠️ "}${label}${detail ? ` — ${detail}` : ""}`);
};

/** Every real row (any source) market_prices has for one card. Live, unfiltered. */
async function fetchAllRows(cardId: string): Promise<MarketPriceRow[]> {
  const { data, error } = await supabaseAdmin
    .from("market_prices")
    .select("card_id, source, variant, grade, market_price")
    .eq("card_id", cardId)
    .not("grade", "is", null)
    .not("market_price", "is", null);
  if (error) throw error;
  return (data ?? []) as MarketPriceRow[];
}

const priceFor = (rows: MarketPriceRow[], source: string, grade: string) =>
  rows.find((r) => r.source === source && r.grade === grade)?.market_price ?? null;

async function main() {
  console.log("\n=== Graded Price Precedence Validation (CLAUDE.md §6) — LIVE DATA ===\n");

  // ── 1. Pure helper sanity (no DB involved — these are genuinely unit-level) ──
  console.log("1. gradedPricePrecedence.ts helpers");
  check("parseGradeString('PSA 10') → company PSA, gradeValue 10",
    JSON.stringify(parseGradeString("PSA 10")) === JSON.stringify({ company: "PSA", gradeValue: "10", flatKey: "psa_10" }));
  check("parseGradeString('BGS 10 Black') → gradeValue '10 Black'",
    parseGradeString("BGS 10 Black")?.gradeValue === "10 Black");
  check("parseGradeString('CGC 10 Pristine') → flatKey 'cgc_10 Pristine'",
    parseGradeString("CGC 10 Pristine")?.flatKey === "cgc_10 Pristine");
  check("parseGradeString(null) → null", parseGradeString(null) === null);
  check("parseGradeString('PSA') (no grade token) → null", parseGradeString("PSA") === null);
  check("isTenPlusGrade('10') → true", isTenPlusGrade("10") === true);
  check("isTenPlusGrade('10 Black') → true", isTenPlusGrade("10 Black") === true);
  check("isTenPlusGrade('9.5') → false", isTenPlusGrade("9.5") === false);
  check("isTenPlusGrade('1') → false", isTenPlusGrade("1") === false);
  check("sourceAllowedAtTier('poketrace', '9.5') → true (sub-10, poketrace)", sourceAllowedAtTier("poketrace", "9.5") === true);
  check("sourceAllowedAtTier('pricecharting', '9.5') → false (sub-10, PC dead field)", sourceAllowedAtTier("pricecharting", "9.5") === false);
  check("sourceAllowedAtTier('pricecharting', '10') → true (10-tier, PC)", sourceAllowedAtTier("pricecharting", "10") === true);
  check("sourceAllowedAtTier('poketrace', '10') → false (10-tier, PokeTrace excluded)", sourceAllowedAtTier("poketrace", "10") === false);
  check("sourceAllowedAtTier('poketrace', '10 Black') → false (Black Label, PokeTrace excluded)", sourceAllowedAtTier("poketrace", "10 Black") === false);

  // ── 2. aggregateCardPrices against LIVE rows ────────────────────────────
  console.log("\n2. aggregateCardPrices (fetchCardPrices' precedence logic) — live rows");

  const sharpedoRows = await fetchAllRows("662193");
  const kangaskhanRows = await fetchAllRows("654521");
  const char125Rows = await fetchAllRows("662184");
  const char130Rows = await fetchAllRows("662185");
  const umbreonRows = await fetchAllRows("602681");
  const gengarRows = await fetchAllRows("515364");
  const charizardBaseRows = await fetchAllRows("42382"); // Black Label case

  const sharpedoPT = priceFor(sharpedoRows, "poketrace", "BGS 10");
  const sharpedoPC = priceFor(sharpedoRows, "pricecharting", "BGS 10");
  const kangaskhanPT = priceFor(kangaskhanRows, "poketrace", "BGS 10");
  const kangaskhanPC = priceFor(kangaskhanRows, "pricecharting", "BGS 10");
  const char125PC = priceFor(char125Rows, "pricecharting", "BGS 10");
  const char130PC = priceFor(char130Rows, "pricecharting", "BGS 10");
  const umbreonPT = priceFor(umbreonRows, "poketrace", "PSA 10");
  const umbreonPC = priceFor(umbreonRows, "pricecharting", "PSA 10");
  const gengarPT = priceFor(gengarRows, "poketrace", "PSA 10");
  const gengarPC = priceFor(gengarRows, "pricecharting", "PSA 10");
  const charizardBasePT_Black = priceFor(charizardBaseRows, "poketrace", "BGS 10 Black");
  const charizardBasePC_Black = priceFor(charizardBaseRows, "pricecharting", "BGS 10 Black");

  console.log(
    `  (live: Sharpedo PT=$${sharpedoPT} PC=$${sharpedoPC} | Kangaskhan PT=$${kangaskhanPT} PC=$${kangaskhanPC} | ` +
    `Charizard125 PC=$${char125PC} | Charizard130 PC=$${char130PC} | Umbreon PT=$${umbreonPT} PC=$${umbreonPC} | ` +
    `Gengar PT=$${gengarPT} PC=$${gengarPC} | Charizard(Base) Black PT=$${charizardBasePT_Black} PC=$${charizardBasePC_Black})`,
  );

  // 2a. Precedence beats max() — PT is HIGHER than PC on both real cards.
  const sharpedoOn = aggregateCardPrices(["662193"], sharpedoRows, true);
  const sharpedoOff = aggregateCardPrices(["662193"], sharpedoRows, false);
  check(
    `Sharpedo BGS 10, flag ON → resolves to live PC $${sharpedoPC} (not PT's higher $${sharpedoPT})`,
    sharpedoOn.get("662193")?.bgs_10 === sharpedoPC && sharpedoPC !== null,
    `got ${sharpedoOn.get("662193")?.bgs_10}`,
  );
  check(
    "Sharpedo BGS 10, flag OFF → still resolves to PT (byte-identical to today, PC row invisible)",
    sharpedoOff.get("662193")?.bgs_10 === sharpedoPT,
    `got ${sharpedoOff.get("662193")?.bgs_10}`,
  );

  const kangaskhanOn = aggregateCardPrices(["654521"], kangaskhanRows, true);
  const kangaskhanOff = aggregateCardPrices(["654521"], kangaskhanRows, false);
  check(
    `Kangaskhan BGS 10, flag ON → resolves to live PC $${kangaskhanPC} (not PT's higher $${kangaskhanPT})`,
    kangaskhanOn.get("654521")?.bgs_10 === kangaskhanPC && kangaskhanPC !== null,
    `got ${kangaskhanOn.get("654521")?.bgs_10}`,
  );
  check(
    "Kangaskhan BGS 10, flag OFF → still resolves to PT (byte-identical to today)",
    kangaskhanOff.get("654521")?.bgs_10 === kangaskhanPT,
  );

  // 2b. Mega Charizard X ex 125 & 130 — resolve to PC regardless of how
  // close/identical PT's number happens to be.
  check(
    `Mega Charizard X ex 125, flag ON → resolves to live PC $${char125PC}`,
    aggregateCardPrices(["662184"], char125Rows, true).get("662184")?.bgs_10 === char125PC && char125PC !== null,
  );
  check(
    `Mega Charizard X ex 130, flag ON → resolves to live PC $${char130PC}`,
    aggregateCardPrices(["662185"], char130Rows, true).get("662185")?.bgs_10 === char130PC && char130PC !== null,
  );

  // 2c. THE SHARPEST EDGE — PT-only at 10+, live: Gengar has a real
  // PokeTrace PSA 10 row; PriceCharting's search genuinely found no
  // matching product (confirmed by the full sync's unmatched list). No
  // pricecharting row exists for this card at all — gengarPC should be null.
  const gengarOn = aggregateCardPrices(["515364"], gengarRows, true);
  check(
    `Gengar PSA 10 (PT-only, live PC=${gengarPC === null ? "null, confirmed no match" : "UNEXPECTEDLY MATCHED"}), flag ON → BLANK, not PT's $${gengarPT}`,
    gengarPC === null && gengarOn.get("515364")?.psa_10 === undefined,
    `got ${gengarOn.get("515364")?.psa_10}, live PC was ${gengarPC}`,
  );
  check(
    "Gengar PSA 10, flag OFF → still resolves to PT (unaffected, exactly today's behavior)",
    aggregateCardPrices(["515364"], gengarRows, false).get("515364")?.psa_10 === gengarPT,
  );

  // 2d. Negative control — PC ≥ PT already (Umbreon ex, PSA 10). Both
  // max() and precedence agree here; confirms nothing broke in the
  // "they happen to agree" case.
  check(
    `Umbreon ex PSA 10 (live PC $${umbreonPC} vs PT $${umbreonPT}), flag ON → resolves to PC`,
    aggregateCardPrices(["602681"], umbreonRows, true).get("602681")?.psa_10 === umbreonPC && umbreonPC !== null,
  );

  // 2e. SYNTHETIC (necessarily) — sub-10 stays PokeTrace-only even if a
  // stray PriceCharting row existed at that tier. The real sync NEVER
  // writes one (it only fetches/writes 10-tier fields), so there is no
  // live row to test this against — constructed here as defense-in-depth
  // against the read path ever trusting a source blindly.
  const subTenRows: MarketPriceRow[] = [
    { card_id: "SYNTH_SUBTEN", source: "poketrace", variant: null, grade: "BGS 9.5", market_price: 139.5 },
    { card_id: "SYNTH_SUBTEN", source: "pricecharting", variant: null, grade: "BGS 9.5", market_price: 62 },
  ];
  check(
    "SYNTHETIC — BGS 9.5 (sub-10) with a hypothetical stray PC row, flag ON → resolves to PT $139.50, PC's dead field never read",
    aggregateCardPrices(["SYNTH_SUBTEN"], subTenRows, true).get("SYNTH_SUBTEN")?.["bgs_9.5"] === 139.5,
  );

  // 2f. Black Label — now LIVE. Base Set Charizard (42382) has a real
  // PriceCharting BGS 10 Black row from the full sync; PokeTrace has zero
  // Black Label rows anywhere (verified Phase 0) — charizardBasePT_Black
  // should be null, confirming the exclusion has nothing to exclude in
  // practice, not just in theory.
  const charizardBlackOn = aggregateCardPrices(["42382"], charizardBaseRows, true);
  check(
    `BGS 10 Black Label (LIVE, Base Set Charizard), flag ON → resolves to PC $${charizardBasePC_Black}`,
    charizardBlackOn.get("42382")?.["bgs_10 Black"] === charizardBasePC_Black && charizardBasePC_Black !== null,
    `got ${charizardBlackOn.get("42382")?.["bgs_10 Black"]}`,
  );
  check(
    "BGS 10 Black Label — PokeTrace genuinely has zero rows at this tier (live confirmation of the Phase 0 finding)",
    charizardBasePT_Black === null,
  );

  // SYNTHETIC (necessarily) — prove exclusion holds even IF PokeTrace had
  // a Black Label row (it never does, per the above — this is the
  // adversarial case that can't be constructed from real data).
  const bogusBlackRows: MarketPriceRow[] = [
    { card_id: "SYNTH_BLACK", source: "poketrace", variant: null, grade: "BGS 10 Black", market_price: 999999 },
    { card_id: "SYNTH_BLACK", source: "pricecharting", variant: null, grade: "BGS 10 Black", market_price: 1730.68 },
  ];
  check(
    "SYNTHETIC — BGS 10 Black with a hypothetical PokeTrace row too, flag ON → still resolves to PC $1730.68, not the bogus PT row",
    aggregateCardPrices(["SYNTH_BLACK"], bogusBlackRows, true).get("SYNTH_BLACK")?.["bgs_10 Black"] === 1730.68,
  );

  // ── 3. filterGradedPriceRows against LIVE rows ──────────────────────────
  console.log("\n3. filterGradedPriceRows (getGradedPricesForCard's precedence logic) — live rows");

  const kangaskhanGraded: RawGradedPriceRow[] = kangaskhanRows
    .filter((r) => r.grade === "BGS 10")
    .map((r) => ({ source: r.source, grade: r.grade, market_price: r.market_price, fetched_at: "2026-08-25T00:00:00Z" }));
  const kangaskhanGradedOn = filterGradedPriceRows(kangaskhanGraded, true);
  const kangaskhanGradedOff = filterGradedPriceRows(kangaskhanGraded, false);
  check(
    `getGradedPricesForCard-equivalent: Kangaskhan BGS 10 (live), flag ON → 1 row, PC's $${kangaskhanPC}`,
    kangaskhanGradedOn.length === 1 && kangaskhanGradedOn[0].marketPrice === kangaskhanPC,
    JSON.stringify(kangaskhanGradedOn),
  );
  check(
    `getGradedPricesForCard-equivalent: Kangaskhan BGS 10 (live), flag OFF → 1 row, PokeTrace's $${kangaskhanPT} (this function ALWAYS hardcoded source='poketrace' pre-contract too)`,
    kangaskhanGradedOff.length === 1 && kangaskhanGradedOff[0].marketPrice === kangaskhanPT,
  );

  const gengarGraded: RawGradedPriceRow[] = gengarRows
    .filter((r) => r.grade === "PSA 10")
    .map((r) => ({ source: r.source, grade: r.grade, market_price: r.market_price, fetched_at: "2026-08-25T00:00:00Z" }));
  check(
    "getGradedPricesForCard-equivalent: Gengar PSA 10 (live, PT-only), flag ON → EMPTY array, not the PokeTrace row",
    filterGradedPriceRows(gengarGraded, true).length === 0,
    JSON.stringify(filterGradedPriceRows(gengarGraded, true)),
  );
  check(
    "getGradedPricesForCard-equivalent: Gengar PSA 10 (live), flag OFF → 1 row (unaffected)",
    filterGradedPriceRows(gengarGraded, false).length === 1,
  );

  const subTenGraded: RawGradedPriceRow[] = [
    { source: "poketrace", grade: "BGS 9.5", market_price: 139.5, fetched_at: "2026-08-25T00:00:00Z" },
    { source: "pricecharting", grade: "BGS 9.5", market_price: 62, fetched_at: "2026-08-25T00:00:00Z" },
  ];
  check(
    "SYNTHETIC — getGradedPricesForCard-equivalent: BGS 9.5 sub-10 with hypothetical PC row, flag ON → 1 row (PT only, PC's dead field excluded)",
    filterGradedPriceRows(subTenGraded, true).length === 1 &&
      filterGradedPriceRows(subTenGraded, true)[0].marketPrice === 139.5,
  );

  // ── 4. gradingArbitrage / regradeTracker — the two paid-decision surfaces ──
  // (build-26 blocker, Omar's ruling 2026-08-26): these read market_prices
  // unconditionally with no source gate until this fix — a stray PokeTrace
  // 10 could be considered, or picked as "best," right alongside/instead of
  // PriceCharting once the flag opens. Same headline cards as sections 2-3
  // (Kangaskhan BGS 10, Umbreon PSA 10) so a failure here is directly
  // comparable to the fetchCardPrices/getGradedPricesForCard results above.
  console.log("\n4. gradingArbitrage.service.ts / regradeTracker.service.ts — live rows (paid-decision surfaces)");

  const toRawGradeRow = (r: MarketPriceRow): RawGradeRow => ({
    source: r.source,
    grade: r.grade,
    market_price: r.market_price,
    source_product_id: null, // not selected by fetchAllRows above; irrelevant to the filter/sort assertions here
  });

  // KNOWN PRE-EXISTING BUG (found by this script, not caused by this ruling,
  // NOT fixed here — see BACKLOG.md "grade-string truncation collides
  // multi-word grades"): both services' `grade: parts[1] ?? ...` parsing
  // collapses "BGS 10 Black" down to "10", identical to plain "BGS 10". A
  // real pricecharting BGS 10 Black row ($2,943.66 on Kangaskhan) therefore
  // masquerades as a BGS "10" entry, and since filterGradePricesForCard
  // sorts by price descending, it can beat the genuine BGS 10 row
  // ($247.77) to any `.find(company==="BGS" && grade==="10")` lookup —
  // ladder order isn't price-sorted, so its own .find() is order-dependent
  // instead. Neither is deterministic proof of anything. So: don't assert
  // via that lookup. Assert the literal, bug-proof requirement instead —
  // the exact PokeTrace 10-tier price must never appear anywhere in the
  // gated output, full stop, regardless of what label it would've sorted
  // under.
  const neverLeaksPokeTracePrice = (
    rows: { price: number; source: string }[],
    forbiddenPrice: number | null,
  ) =>
    // null means there's no live PokeTrace row for this card/tier to leak in
    // the first place — vacuously true, not a gap in coverage.
    forbiddenPrice === null ||
    !rows.some((r) => r.source === "poketrace" && r.price === forbiddenPrice);

  const kangaskhanArbOn = filterGradePricesForCard(kangaskhanRows.map(toRawGradeRow), true);
  const kangaskhanArbOff = filterGradePricesForCard(kangaskhanRows.map(toRawGradeRow), false);
  check(
    `filterGradePricesForCard (arbitrage): Kangaskhan, flag ON → PokeTrace's BGS 10 price ($${kangaskhanPT}) never leaks into the output, at any label`,
    neverLeaksPokeTracePrice(kangaskhanArbOn, kangaskhanPT),
  );
  const kangaskhanArbOnBgs10 = kangaskhanArbOn.find((g) => g.company === "BGS" && g.grade === "10");
  note(
    `filterGradePricesForCard (arbitrage): Kangaskhan BGS 10, flag ON → if a "BGS"/"10" entry is present it's PriceCharting's $${kangaskhanPC} (informational — see truncation-bug note above for why this lookup itself is unreliable)`,
    !kangaskhanArbOnBgs10 || (kangaskhanArbOnBgs10.price === kangaskhanPC && kangaskhanArbOnBgs10.source === "pricecharting"),
    JSON.stringify(kangaskhanArbOnBgs10),
  );
  const kangaskhanArbOffBgs10 = kangaskhanArbOff.find((g) => g.company === "BGS" && g.grade === "10");
  check(
    `filterGradePricesForCard (arbitrage): Kangaskhan BGS 10, flag OFF → PokeTrace's $${kangaskhanPT} (byte-identical to pre-fix behavior for the off state)`,
    kangaskhanArbOffBgs10?.price === kangaskhanPT && kangaskhanArbOffBgs10?.source === "poketrace",
  );

  const umbreonArbOn = filterGradePricesForCard(umbreonRows.map(toRawGradeRow), true);
  check(
    `filterGradePricesForCard (arbitrage): Umbreon ex, flag ON → PokeTrace's PSA 10 price ($${umbreonPT}) never leaks into the output, at any label`,
    neverLeaksPokeTracePrice(umbreonArbOn, umbreonPT),
  );
  const umbreonArbOnPsa10 = umbreonArbOn.find((g) => g.company === "PSA" && g.grade === "10");
  note(
    `filterGradePricesForCard (arbitrage): Umbreon ex PSA 10, flag ON → if a "PSA"/"10" entry is present it's PriceCharting's $${umbreonPC} (informational)`,
    !umbreonArbOnPsa10 || (umbreonArbOnPsa10.price === umbreonPC && umbreonArbOnPsa10.source === "pricecharting"),
    JSON.stringify(umbreonArbOnPsa10),
  );

  // getGradeLadder — a real DB round trip (unlike the pure function above),
  // same two cards, same truncation caveat, same fix: assert the price
  // never leaks rather than trusting a company+grade lookup.
  const kangaskhanLadderOn = await getGradeLadder("654521", true);
  const kangaskhanLadderOff = await getGradeLadder("654521", false);
  check(
    `getGradeLadder: Kangaskhan, flag ON → PokeTrace's BGS 10 price ($${kangaskhanPT}) never leaks into the ladder, at any label`,
    neverLeaksPokeTracePrice(kangaskhanLadderOn.ladder, kangaskhanPT),
  );
  const kangaskhanLadderOnBgs10 = kangaskhanLadderOn.ladder.find((e) => e.company === "BGS" && e.grade === "10");
  note(
    `getGradeLadder: Kangaskhan BGS 10, flag ON → if a "BGS"/"10" entry is present it's PriceCharting's $${kangaskhanPC} (or absent — informational)`,
    !kangaskhanLadderOnBgs10 || (kangaskhanLadderOnBgs10.price === kangaskhanPC && kangaskhanLadderOnBgs10.source === "pricecharting"),
    JSON.stringify(kangaskhanLadderOnBgs10),
  );
  const kangaskhanLadderOffBgs10 = kangaskhanLadderOff.ladder.find((e) => e.company === "BGS" && e.grade === "10");
  check(
    `getGradeLadder: Kangaskhan BGS 10, flag OFF → PokeTrace's $${kangaskhanPT}`,
    kangaskhanLadderOffBgs10?.price === kangaskhanPT && kangaskhanLadderOffBgs10?.source === "poketrace",
  );

  const umbreonLadderOn = await getGradeLadder("602681", true);
  check(
    `getGradeLadder: Umbreon ex, flag ON → PokeTrace's PSA 10 price ($${umbreonPT}) never leaks into the ladder, at any label`,
    neverLeaksPokeTracePrice(umbreonLadderOn.ladder, umbreonPT),
  );
  const umbreonLadderOnPsa10 = umbreonLadderOn.ladder.find((e) => e.company === "PSA" && e.grade === "10");
  note(
    `getGradeLadder: Umbreon ex PSA 10, flag ON → if a "PSA"/"10" entry is present it's PriceCharting's $${umbreonPC} (informational)`,
    !umbreonLadderOnPsa10 || (umbreonLadderOnPsa10.price === umbreonPC && umbreonLadderOnPsa10.source === "pricecharting"),
    JSON.stringify(umbreonLadderOnPsa10),
  );

  // ── Verdict ─────────────────────────────────────────────────────────────
  console.log(
    failures === 0
      ? "\n✅ PASS — precedence logic matches the amended contract on every case (live data)\n"
      : `\n❌ FAIL — ${failures} check(s) failed\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
