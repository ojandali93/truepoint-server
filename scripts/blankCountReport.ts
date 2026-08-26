// One-off: quantify the blank-count for Omar's inventory under the amended
// contract — cards where PokeTrace has a company-10 price today but the
// (now fully synced, real) PriceCharting data does not, meaning that
// company+grade goes from "priced" to "blank" the moment the flag flips on.

import "dotenv/config";
import { supabaseAdmin } from "../src/lib/supabase";
import { fetchAllByIn } from "../src/lib/pgFetchAll";

const USER_ID = "25e63b99-c664-430b-a48d-6ffa548b5818";

async function main() {
  const { data: invRows, error: invErr } = await supabaseAdmin
    .from("inventory")
    .select("item_type, card_id, grading_company, grade")
    .eq("user_id", USER_ID)
    .eq("status", "active")
    .not("card_id", "is", null);
  if (invErr) throw invErr;

  const cardIds = [...new Set((invRows ?? []).map((r) => r.card_id as string))];
  const gradedItems = (invRows ?? []).filter((r) => r.item_type === "graded_card");
  const rawCardIds = [...new Set((invRows ?? []).filter((r) => r.item_type === "raw_card").map((r) => r.card_id as string))];

  // fetchAllByIn — NOT a plain .in() chunk loop. A single graded card can
  // carry 30-60 market_prices rows; 200+ cards' worth of poketrace +
  // pricecharting rows blows past PostgREST's 1000-row-per-request cap
  // well within one id-chunk, so an unpaginated per-chunk query silently
  // truncates (caught this the hard way: Sharpedo — confirmed moments ago
  // via validateGradedPricePrecedence.ts to have both a poketrace AND a
  // pricecharting BGS 10 row — first showed up here as "PT:no PC:no").
  // fetchAllByIn pages within each id-chunk via .range(), which is what
  // actually defeats the cap.
  type Row = { card_id: string; source: string; grade: string | null; market_price: number | null };
  const allRows = await fetchAllByIn<Row>({
    table: "market_prices",
    columns: "card_id, source, grade, market_price",
    column: "card_id",
    ids: cardIds,
    modify: (q) =>
      q.in("source", ["poketrace", "pricecharting"]).not("grade", "is", null).not("market_price", "is", null),
  });

  const ptTenByCard = new Map<string, Set<string>>(); // card_id -> Set(company) at grade 10
  const pcTenByCard = new Map<string, Set<string>>();
  for (const r of allRows) {
    const m = String(r.grade).match(/^([A-Z]+)\s+10$/); // plain "10" only — not Black/Pristine
    if (!m) continue;
    const map = r.source === "poketrace" ? ptTenByCard : r.source === "pricecharting" ? pcTenByCard : null;
    if (!map) continue;
    const set = map.get(r.card_id) ?? new Set<string>();
    set.add(m[1]);
    map.set(r.card_id, set);
  }

  // ── A. Owned graded-at-10 holdings — actual portfolio-value blanks ──────
  const tenGradedItems = gradedItems.filter((g) => String(g.grade) === "10");
  console.log(`\n=== A. Owned graded-at-10 holdings (n=${tenGradedItems.length}) ===`);
  let gradedLosses = 0;
  for (const g of tenGradedItems) {
    const co = g.grading_company as string;
    const ptHas = ptTenByCard.get(g.card_id as string)?.has(co) ?? false;
    const pcHas = pcTenByCard.get(g.card_id as string)?.has(co) ?? false;
    const losesIt = ptHas && !pcHas;
    if (losesIt) gradedLosses++;
    console.log(`  ${g.card_id} ${co} 10 — PT:${ptHas ? "yes" : "no"} PC:${pcHas ? "yes" : "no"}${losesIt ? "  ⚠️  GOES BLANK" : ""}`);
  }
  console.log(`Graded holdings losing their displayed portfolio value: ${gradedLosses}/${tenGradedItems.length}`);

  // ── B. Raw holdings — arbitrage/regrade-ladder blanks (per company+card) ──
  console.log(`\n=== B. Raw holdings arbitrage tiers (n=${rawCardIds.length} unique cards) ===`);
  const losses: Array<{ cardId: string; company: string }> = [];
  for (const cardId of rawCardIds) {
    const pt = ptTenByCard.get(cardId) ?? new Set();
    const pc = pcTenByCard.get(cardId) ?? new Set();
    for (const co of pt) {
      if (!pc.has(co)) losses.push({ cardId, company: co });
    }
  }
  const cardsLosingAny = new Set(losses.map((l) => l.cardId));
  console.log(`Card+company 10-tier prices that go BLANK: ${losses.length}`);
  console.log(`Unique raw cards losing >=1 company: ${cardsLosingAny.size}/${rawCardIds.length}`);

  const byCompany: Record<string, number> = {};
  for (const l of losses) byCompany[l.company] = (byCompany[l.company] ?? 0) + 1;
  console.log("By company:", byCompany);

  // Names, for reference
  if (cardsLosingAny.size) {
    const { data: cardRows } = await supabaseAdmin
      .from("cards")
      .select("id, name, number")
      .in("id", [...cardsLosingAny]);
    const nameMap = new Map((cardRows ?? []).map((c) => [c.id, `${c.name} (${c.number})`]));
    console.log("\nCards losing >=1 company-10 price:");
    for (const cardId of cardsLosingAny) {
      const cos = losses.filter((l) => l.cardId === cardId).map((l) => l.company);
      console.log(`  ${nameMap.get(cardId) ?? cardId} — loses: ${cos.join(", ")}`);
    }
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
