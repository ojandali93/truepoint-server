# Collection CSV Import (Collectr → ReverseHolo) — Phase 1 Design

Status: **DESIGN ONLY, no code.** Stop point for review before Phase 2.

Fixture: `truepoint-server/fixtures/export (1).csv` — 522 rows, Omar's real
Collectr export, committed alongside this doc so Phase 2's validation harness
runs against the exact same data this design was built against. All numbers
below are measured against that file plus live production data (Supabase,
queried read-only 2026-08-26), not estimated.

---

## 0. Corrections to the input brief

Two of the stated fixture facts didn't reproduce exactly when checked — noted
here rather than silently used as given, per repo convention:

- **1st Edition variance rows: 9, not 10.** 8× `1st Edition` + 1×
  `1st Edition Holofoil`. Full list in §5.
- **"1st Edition" is not an unmatched/unmodeled variant.** It's already a
  live `card_variants` row (`variant_type: "1stedition"`) on at least the
  vintage cards checked, and `variantKey()` normalizes Collectr's `"1st
  Edition"` string to exactly that key already — no new normalization code
  needed for the *match*. The real gap is downstream and narrower than
  "variant unmodeled" — see §1c.

---

## 1a. Matching pipeline

### Column contract (verified against the live fixture header)

```
Portfolio Name, Category, Set, Product Name, Card Number, Rarity, Variance,
Grade, Card Condition, Average Cost Paid, Quantity,
Market Price (As of <date>), Price Override, Watchlist, Date Added, Notes
```

`Category ∈ {Pokemon, One Piece}` (measured: 519 / 3 in this fixture) routes
straight to `cards.game ∈ {pokemon, onepiece}` — no ambiguity, first filter
applied to every row. Prices (`Average Cost Paid`, `Market Price`) carry
comma thousands-separators (`"1,055.48"`) — strip before parsing; only
`Average Cost Paid` is ever written (it's `inventory.purchase_price`),
Collectr's own `Market Price` column is never trusted or stored (see §1f —
we value from our own data, not theirs). `Card Condition` is 100% `"Near
Mint"` in this export — treated as a Collectr default, not observed data;
mapped to `CardCondition = "NM"` on import but never used as a matching
signal. `Notes` is discarded.

### Set resolution

Reuse the existing dead-row filter from `card.repository.ts`'s
`findAllSets()` — `.not("tcgapis_group_id", "is", null)` — as the base
predicate for every set lookup. This isn't optional hygiene: the live `sets`
table has orphaned legacy rows with **zero cards** sharing names with real
sets (confirmed: a `sets` row named `"Jungle"` with `id: "base2"` and 0 cards
sits alongside the real TCGAPIs-native `"Jungle"` at `id: "635"` with 64
cards). Without this filter, a naive name match has a real chance of
resolving to a dead id and importing to a card with no price data.

**Structural finding, not 74 hand-typed aliases:** checked all 74 distinct
`Set` values in the fixture against live `sets.name` (game-scoped, dead rows
excluded). Only 19/72 Pokémon set labels match `sets.name` exactly. The
other 53 are not 53 unrelated aliases — **our catalog prefixes almost every
set name with a block code** Collectr omits: `SWSH10: Astral Radiance`,
`SV: Prismatic Evolutions`, `SM - Crimson Invasion`, `XY - Evolutions`,
`ME: Ascended Heroes`, `S6a: Eevee Heroes`, etc. Stripping a leading
`<block-code><":"|"-"|" ">` token and requiring an **exact** match on what's
left resolves the large majority of these automatically.

Recommended mechanism for Phase 2 (not a static hand-maintained list):

1. Build the strip-prefix index **once at import time**, from the live
   `sets` table (game-scoped, dead rows excluded) — not hand-authored, so it
   never drifts from the real catalog as new sets sync in.
2. For each Collectr `Set` value: exact match on `sets.name` first; if none,
   exact match against the stripped-prefix index.
3. Exactly one candidate at either step → resolved, no alias table entry
   needed.
4. Zero or 2+ candidates → falls through to the small manual override table
   below, then to needs-review/unmatched. Never guess between multiple
   candidates.

**Verified manual-override cases** (multi-candidate or zero-candidate after
steps 1–3 — these are genuinely irreducible, not a harness bug):

| Collectr `Set` | Resolution | Why it's not automatic |
|---|---|---|
| `Base Set (Unlimited)` | → `Base Set` (`604`) | 5 candidates share "Base Set" as a substring (`Base Set`, `Base Set (Shadowless)`, `Base Set 2`, plus SWSH/SV "Base Set" reprints). `(Unlimited)` is print status, not a set — matches the Jungle-card `card_variants` pattern (`variant_type: "unlimited"` lives ON the card, not a separate set). Recommend: strip a trailing `(Unlimited)`/`(1st Edition)` qualifier from the SET label specifically (this is a Collectr set-naming convention for early WOTC sets, distinct from the `Variance` column) and route it into variant matching instead. |
| `Evolutions` | → `XY - Evolutions` (not `SV: Prismatic Evolutions`) | 2 candidates contain "Evolutions"; only `XY - Evolutions` is an *exact* match after prefix-strip. Rule: prefer exact-after-strip over substring-after-strip; this case is already unambiguous once that rule is applied. |
| `SV: 151` | Ambiguous — `SV2a: Pokemon Card 151` vs `SV: Scarlet & Violet 151` | The fixture separately has a `Pokemon 151` row mapping cleanly to `SV2a: Pokemon Card 151`, so `SV: 151` is presumably Collectr's label for the *other* candidate — but that's inference, not a verified fact. Needs one manual confirmation from Omar, then locked in as an override. |
| `Mega Evolution Promos` | → `ME: Mega Evolution Promo` | Singular/plural mismatch defeats exact-after-strip. Manual override, one entry. |
| `Gem Pack 2` | **No candidate at any confidence level.** | Real catalog gap, not an aliasing problem — nothing in `sets` resembles this name under `game=pokemon`. Row(s) in this set land in **unmatched**, not needs-review, until/unless the set turns out to exist under a name with zero string overlap (would need eyeballing the actual card to identify it). |
| `Trading Card Game Classic (Japanese)` | **No candidate.** | Only English `Trading Card Game Classic` exists in the live catalog — there is no Japanese-language edition of this specific set synced. This is a genuine catalog gap (see JP routing below), not a match failure. |

Everything else in the 53 resolves cleanly via the strip-prefix rule with a
single exact candidate (`Ascended Heroes`→`ME: Ascended Heroes`,
`Crimson Haze`→`SV5a: Crimson Haze`, `Sun & Moon Base Set`→`SM Base Set`,
`Sword & Shield Promo`→`SWSH: Sword & Shield Promo Cards`, etc.) — full list
is a Phase 2 harness output, not hand-enumerated here since it's mechanical
once the rule is coded.

One Piece: 2/2 distinct set labels in this fixture match `sets.name`
exactly, zero aliasing needed for the sample — **but see the OP
number/qualifier section below, which is the real One Piece hazard, not set
naming.**

### Number normalization

`cards.number` is TCGAPIs-native and stored as printed on the catalog
(`"33/64"`, `"OP05-007"`, `"ST15-005"`). Collectr's `Card Number` column, on
this fixture, already matches that format 1:1 for every populated row
checked (Pokémon `NNN` bare vintage numbers like `62`, `66`, `77` still need
the `/total` suffix reconstructed from the resolved set — the CSV drops it,
the catalog doesn't). No GG/TG-subset or SVP-promo rows exist in this
specific fixture to verify against; design the normalizer to handle them
(strip promo-prefix variants, preserve subset letter suffixes) but flag as
**unverified against real data** until a fixture row exercises that path —
don't claim parity Phase 2 hasn't actually tested.

### Name normalization

Reuse `variantKey()`'s normalization *shape* (lowercase, strip
non-alphanumeric) for fuzzy name comparison, but name matching itself is
secondary to set+number once both resolve — see the OP section below for
why leading with name is actively dangerous for One Piece.

One useful confirmation: TCGAPIs' own catalog already disambiguates
same-named cards within a set by appending `(N)` to the `name` field itself
(verified: `Clefable (17)`, `Mr. Mime (22)` inside `Jungle`/`635`) — the same
convention the fixture's `Dragons Exalted | Hydreigon (97)` follows. This
isn't a Collectr quirk to special-case; it's Collectr mirroring the
catalog's own naming, so plain name+number matching handles it for free.

### (JP) routing

`sets.language ∈ {English, Japanese}` and `cards.language` both exist
already (TCGAPIs ingests English Pokémon + Pokémon Japan as separate
category pulls). Routing rule: a `(JP)` suffix on `Product Name` → strip the
suffix, then require the resolved set to have `language = "Japanese"`. This
worked cleanly on paper for the fixture's JP rows **except** the
`Trading Card Game Classic (Japanese)` gap noted above, where there's simply
no JP-language edition of that set in the catalog to route to — that row is
unmatched regardless of how good the JP-detection logic is.

### Variance → `card_variants` mapping

`variantKey()` already normalizes every Variance value seen in this fixture
(`1st Edition`, `1st Edition Holofoil`, `Foil`, `Holofoil`, `Normal`,
`Reverse Holofoil`) to keys that either directly match live `card_variants
.variant_type` rows or match `VARIANT_MAP` entries in `tcgapisClient.ts`
after the same normalization (`"1stEditionHolofoil"` → `"1steditionholofoil"`
== `variantKey("1st Edition Holofoil")`). `Poke Ball Reverse Holo` (fixture's
literal string) doesn't match either scheme verbatim — needs a small
explicit map entry (`"Poke Ball Reverse Holo"` → the `pokeball`
`variant_type` family), not a new normalization primitive.

### Compound grade-string parser

Collectr's `Grade` column format, measured (all 16 distinct values in this
fixture):

```
"<COMPANY> <N.N> <qualifier text>"   e.g. "CGC 10.0 Pristine", "BGS 8.0 NM-MT"
"Ungraded"
```

Target: `market_prices.grade`'s locked `"COMPANY VALUE"` format
(`gradedPricePrecedence.ts`, CLAUDE.md §6). Parser: split on whitespace,
`company = parts[0]`, `numeric = parts[1]` (strip trailing `.0`; keep `.5`),
`qualifier = parts[2:]`. Then:

- **Sub-10 (numeric < 10):** target is `"<COMPANY> <numeric>"`, qualifier
  text discarded entirely — sub-10 pricing (PokeTrace) carries no qualifier
  dimension in our schema regardless of what Collectr's condition label
  says. `"BGS 8.0 NM-MT"` → `"BGS 8"`. Verified against every sub-10 value in
  the fixture; no exceptions.
- **10-tier:** qualifier decides which LOCKED tier, per
  `pricechartingClient.ts`'s field map — not a free-form suffix:
  - No qualifier, or a qualifier meaning "this company's default 10"
    (`"GEM - MT"`, `"GEM MINT"`, `"Gem Mint"`) → bare `"<COMPANY> 10"`.
    Verified: `CGC 10.0 Gem Mint` → `CGC 10`, `PSA 10.0 GEM - MT` → `PSA 10`,
    `TAG 10.0 GEM MINT` → `TAG 10`.
  - `"Pristine"` on CGC → `"CGC 10 Pristine"` (locked tier, exists). Verified
    1:1 on the fixture's `CGC 10.0 Pristine` rows.
  - **`"Pristine"` on BGS → no locked target tier exists.** Confirmed by
    reading `pricechartingClient.ts`'s field map directly: BGS's only 10+
    tiers are bare `BGS 10` and `BGS 10 Black` (Black Label,
    `condition-20-price`). There is no `BGS 10 Pristine` price field. This
    fixture has **2 rows** with `Grade = "BGS 10.0 Pristine"` that hit this
    exact gap. Do not silently coerce to `BGS 10` (undervalues — Pristine is
    a real, rarer BGS tier colloquially, just not one PriceCharting prices
    separately from Black Label) or to `BGS 10 Black` (overclaims — Pristine
    ≠ confirmed Black Label). **Land as needs-review with the specific
    reason "BGS Pristine tier not priced by our locked contract"**, not a
    generic unmatched. Real product decision, not a parsing bug — flag to
    Omar; candidate backlog item added (§6).
- `"Ungraded"` → no grade at all; row is a raw card, priced off
  `card_variants`/`market_prices` with `grade IS NULL`, not the graded path.

**The actual "known gap" behind 1st Edition, precisely stated:** it's not
matching (see correction above) — it's that every *graded* `market_prices`
row for the one vintage card checked (Jungle Pikachu, `id 45163`) carries
`variant: null`. PokeTrace's graded pricing has no variant dimension at all
in this data — a graded 1st Edition Jungle Pikachu and a graded Unlimited
one would resolve to the identical price today. That's real and worth
knowing, but it's a **pricing-attribution gap that predates this project**
(affects portfolio valuation for any 1st-Edition item already in inventory
today, CSV import or not) — out of scope to fix here. Import should surface
it (e.g. a "variant price not distinguished" flag on the item) rather than
silently presenting a 1st Edition graded card's value as if it were
variant-accurate. Backlog item added (§6).

---

## 1b. Confidence taxonomy

| Tier | Definition | Fixture row classes that land here |
|---|---|---|
| **exact** | Set resolves to exactly one live (non-dead) row via literal name or unambiguous strip-prefix match, AND number resolves to exactly one card in that set, AND (if graded) grade parses to a locked tier. | The 19 sets matching `sets.name` verbatim + the ~29 resolving via unambiguous strip-prefix, with a clean number hit. Majority of the 522 rows. |
| **high** | Same as exact, but required a verified manual-override table entry (§1a) to resolve the set, OR a variance/grade qualifier needed the small explicit map (`Poke Ball Reverse Holo`) rather than falling straight out of `variantKey()`. Deterministic, not fuzzy — just not zero-config. | `Base Set (Unlimited)`, `Mega Evolution Promos`, `Poke Ball Reverse Holo` rows, DON!! card rows where set+exact-qualifier-text narrows a multi-candidate number to exactly one row (see OP section — e.g. `Carrying On His Will` DON card, 2 candidates, exact "(Gold)"/no-"(Gold)" text picks one). |
| **needs-review** | Resolves to 2+ live candidates with no deterministic tiebreaker (ambiguous set label, ambiguous OP number+qualifier group), OR a recognized-but-unpriced grade tier (`BGS 10 Pristine`), OR a numberless non-sealed row (DON!! cards *when* set+qualifier don't cleanly narrow to one — not all of them; see below), OR a parenthetical qualifier that denotes a different print/edition rather than a known variant-pattern token. Never auto-imported; surfaced with candidates for the user to pick. | `SV: 151` (2 set candidates), OP promo rows where set+number still leaves 2+ candidates and qualifier text doesn't exact-match any of them, `BGS 10.0 Pristine` rows (2), any row whose Variance/parenthetical text reads as a print-identity marker rather than a finish (see below). |
| **unmatched** | Zero candidates at any step — real catalog gap, not a matching failure to fix. Reported, never guessed at. | `Gem Pack 2` rows, `Trading Card Game Classic (Japanese)` row. |

### The parenthetical-qualifier rule, precisely (not "all parens = review")

Inspecting the fixture's 37 parenthetical `Product Name` rows (excluding
`(JP)`) split cleanly into two classes that need opposite handling:

1. **Known variant-pattern tokens** — `(Poke Ball Pattern)`,
   `(Master Ball Pattern)`, `(Cosmos Holo)`, `(Full Art)`, `(Secret)`,
   `(Holo Common)`, `(Mega Evolution Stamped)`, `(Holiday Calendar)` — these
   are literally `VARIANT_MAP` keys in `tcgapisClient.ts` (Poke
   Ball/Master Ball confirmed directly in the source). 10 of the 37 rows are
   `Prismatic Evolutions (Poke Ball Pattern)` / `(Master Ball Pattern)`
   alone. Routing these to needs-review would tank the match rate on a
   whole set for no reason — they're a finish/print-pattern tag, safe to
   fold into variant matching same as `Variance` column values.
2. **Print-identity qualifiers** — `(Illustration Box Vol.5)`, `(Gold)`,
   and (verified against live `cards` data, not assumed) genuinely
   necessary: querying every card sharing `number = "ST15-005"` inside
   `One Piece Promotion Cards` (the fixture's own stated set) returns **6**
   distinct rows — `(CS 25-26 Top Player Pack)`, `(Japanese Version 3rd
   Anniversary Set)`, `(CS 25-26 Finalist Card Set 1)`,
   `(Illustration Box Vol.5)`, and duplicates. Set+number alone does *not*
   disambiguate this one — only the exact qualifier text does. This is
   exactly why the user's original instinct (never silently base-print
   match on these) is correct, and it's specifically true for OP promo
   reprints, where the same number legitimately prints across many
   promotional batches. (Contrast: `OP05-007` inside the same set has only
   **1** row — set+number is enough there, no ambiguity, no review needed.
   The algorithm has to check uniqueness at each step rather than assume a
   fixed number of candidates either way.)

Rule: qualifier text is checked against class (1) first (known variant
vocabulary — safe); if it's not a recognized variant token AND set+number
resolves to 2+ candidates, it's class (2) — required exact-text tiebreak,
success = high confidence, no match = needs-review with the candidate list
attached. If set+number already resolves to exactly 1 candidate regardless
of qualifier text, the qualifier is corroboration only (log a mismatch
warning, don't block) — verified true for the `Carrying On His Will` DON!!
card and `OP05-007` Sabo in this fixture.

---

## 1c. 1st Edition decision

Reframed by §1a's correction: this isn't "is the variant modeled" (it is),
it's "does graded pricing carry the variant" (it doesn't, for at least the
one card sampled — needs a Phase 2 harness pass across more vintage cards to
know the real blast radius, not assumed universal from n=1).

Options, as asked, no pick made here:

- **(i) Import as base print, flagged "variant unmodeled."** Inaccurate as
  worded now that the variant *is* modeled for raw pricing — would need to
  be relabeled "flagged: graded value may not reflect 1st Edition premium"
  to be honest about what's actually missing. Simplest for the user,
  understates value on any graded 1st-Edition item.
- **(ii) Skip-with-report.** Loses the raw-priced ones (majority — 6 of 9
  fixture rows are `Ungraded`, which price correctly today) for a problem
  that only affects the graded 3.
- **(iii) Block on catalog/pricing modeling first (BACKLOG item).** Given
  the gap is specifically "graded PokeTrace prices don't carry a variant
  dimension" — a pre-existing, broader-than-import problem — blocking CSV
  import on fixing it conflates two projects.

**Recommendation: (i), scoped correctly.** Import raw 1st-Edition rows at
full accuracy (they already price correctly — no flag needed). Import graded
1st-Edition rows normally but attach a value-accuracy flag specifically
naming the real gap ("graded price not variant-specific — may understate a
1st Edition premium"), not a generic "unmodeled" flag. File the underlying
graded-pricing variant-blindness as its own backlog item (§6) since it's a
portfolio-valuation-wide issue, not an import-specific one — worth fixing
regardless of whether CSV import ships.

---

## 1d. Sealed products

Sealed signature confirmed exactly as briefed on real data: empty `Card
Number` AND empty `Rarity` — 4 rows in this fixture (2 ETBs, 1 booster box,
1 illustration collection), and the DON!! Gold card (empty number, populated
`Rarity: DON!!`) correctly falls outside that signature, confirming number
alone would have misfired on it.

This lines up with how the catalog itself splits: `catalogSync.service.ts`
buckets TCGAPIs items into `cards` vs `products` using the identical
heuristic server-side (`rarity.toLowerCase() === "sealed"`) at sync time —
sealed items never had a card-shaped rarity to begin with. So a CSV row
matching the sealed signature should resolve against `products`, scoped by
the same resolved `set_id` from §1a, then fuzzy-matched by name +
`product_type` (inferred from `Product Name` via the existing
`PRODUCT_TYPE_RULES` regex table in `catalogSync.service.ts` — reuse it
rather than reimplementing "Elite Trainer Box"/"Booster Box"/etc. detection).

**Recommendation: map to `products` matching, not skip-with-report** — the
infra (`product_price_cache`, `products.set_id`, `product_type`) already
exists and is populated, and this fixture's own 4 sealed rows are ordinary,
common products (ETB, booster box) that should resolve cleanly. Skip only
applies as the *fallback* when set+name+type doesn't resolve to exactly one
product — same needs-review/unmatched tiers as cards, not a blanket sealed
carve-out.

---

## 1e. Phase plan with gates

- **Phase 2 — parse + match endpoints, stateless, zero writes.** Implements
  §1a–§1d. Ships with a validation harness that runs the fixture end to end
  and prints a match-rate table (exact / high / needs-review / unmatched
  counts, broken down by set and by the specific reason for anything below
  exact) — the harness output is what actually pins down the residual
  strip-prefix aliases (§1a said "mechanical, Phase 2 harness output," this
  is that harness). Gate: `npx tsc --noEmit` clean, Omar hand-checks the
  exact-tier rows against the harness table before Phase 3 starts.
- **Phase 3 — commit endpoint.** Writes through existing inventory service
  paths (`addInventoryItem`/`insertInventoryItem`), idempotency-keyed
  (one import batch = one idempotency key, re-POSTing the same batch is a
  no-op), batch-chunked. **Real gap found in this design pass, not
  hypothetical:** `insertInventoryBatch` (the actual bulk-insert path)
  currently hardcodes `grading_company`, `grade`, `is_sealed`,
  `serial_number`, and `variant_type` to `null` for every row — it was built
  for a simpler raw-card-only flow. Most import rows are graded or carry a
  variant, so Phase 3 has to either extend `insertInventoryBatch` to accept
  those fields per-row, or the commit path loops chunked calls to
  `insertInventoryItem` instead (which already supports the full field set
  and the `itemType`-specific validation in `addInventoryItem`). Recommend
  extending the batch function — chunked single-inserts for 522 rows is 522
  round trips, extending the batch insert is one query per chunk. Flagging
  now so it isn't a Phase 3 surprise. Also note: `addInventoryItem` gates
  `sealed_product` behind `requireFeature(..., "sealed_inventory", ...)`
  separately from `inventory_tracking` — Phase 3 needs a decision (not made
  here) on whether the whole CSV-import feature sits behind its own plan
  gate, or inherits per-item gates and partially fails a batch for a
  Starter user with sealed rows. Flag to Omar, not decided in this doc.
- **Phase 4 — mobile UI.** `expo-document-picker` is a **native add**,
  forces a store build (next one is build 26, per the mobile app's remote
  auto-increment versioning). Checked `MIGRATION-TODO.md` for what else is
  queued for that same native build: **nothing else is currently queued.**
  Every open item there is either done, a deliberate post-launch
  deferral (opencv 1.x, native-tabs, Icon Composer assets), or explicitly
  non-blocking (SSR guard) — none of them are staged native additions
  waiting on the next build. `expo-document-picker` would be the first new
  native dependency queued for build 26 unless something else lands before
  Phase 4. Review screen: confidence-bucketed (exact auto-selected,
  high/needs-review require a tap to confirm, unmatched offer
  skip-or-search), matching the taxonomy in §1b directly — no separate UI
  taxonomy to invent.
- **Phase 5 — web**, same Phase 2/3 endpoints, no new server work.

---

## 1f. Hard rules

- No silent import below `exact` confidence, ever — `high` still writes
  (it's deterministic, just not zero-config), `needs-review` and
  `unmatched` never auto-write.
- User-uploaded files only — no server-side fetching of arbitrary CSVs.
- Import summary anchors to ReverseHolo's own valuation
  (`"522 items · valued at $X by ReverseHolo"`) — Collectr's own `Market
  Price` column is parsed only far enough to confirm the row exists
  (already true per §1a: never stored, never displayed as a promise of
  parity). This matters concretely here: `poketrace`/`pricecharting`
  numbers will diverge from Collectr's TCGPlayer-sourced numbers on plenty
  of rows in this exact fixture — that's expected and not a bug to reconcile.

---

## Verified against live data — summary

Everything in this doc marked "verified"/"confirmed" was checked against
production Supabase (read-only) and the actual fixture file on 2026-08-26,
not inferred from the brief. Where something couldn't be verified (GG/TG
subset numbers, SVP promo numbers — no fixture row exercises them), it's
called out explicitly rather than presented as tested.

---

STOP HERE for review. Phase 2 not started.
