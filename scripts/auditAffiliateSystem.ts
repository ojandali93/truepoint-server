// One-off, read-only: full audit of the existing affiliate/referral system
// for AUDITS/affiliate-system-plan.md. Findings from the 2026-09-02 run are
// in that doc, not duplicated here — this is the reusable tool.
import "dotenv/config";
import { supabaseAdmin } from "../src/lib/supabase";

async function main() {
  console.log("=== affiliates table (all rows) ===");
  const { data: affiliates, error: affErr } = await supabaseAdmin
    .from("affiliates")
    .select(
      "id, name, slug, type, status, active, user_id, contact_email, collector_rate, pro_rate, source, requested_slug, created_at, approved_at, rejected_at",
    )
    .order("created_at", { ascending: true });
  if (affErr) throw affErr;
  console.log(`total rows: ${affiliates?.length ?? 0}`);
  for (const a of affiliates ?? []) {
    console.log(
      JSON.stringify({
        id: a.id,
        name: a.name,
        slug: a.slug,
        type: a.type,
        status: a.status,
        active: a.active,
        has_user_id: !!a.user_id,
        source: a.source,
        requested_slug: a.requested_slug,
        rates: { collector_rate: a.collector_rate, pro_rate: a.pro_rate },
        created_at: a.created_at,
        approved_at: a.approved_at,
      }),
    );
  }

  console.log(
    "\n=== profiles.affiliation_id set (real attribution, links to affiliates.id) ===",
  );
  const { count: idCount, error: cErr } = await supabaseAdmin
    .from("profiles")
    .select("id", { count: "exact", head: true })
    .not("affiliation_id", "is", null);
  if (cErr) throw cErr;
  console.log(`count: ${idCount}`);

  console.log(
    "\n=== profiles.affiliation set (free-text, from the signup-form code field — NOT validated against affiliates table) ===",
  );
  const { data: freeText, error: ftErr } = await supabaseAdmin
    .from("profiles")
    .select("id, affiliation, affiliation_id, created_at")
    .not("affiliation", "is", null)
    .order("created_at", { ascending: true });
  if (ftErr) throw ftErr;
  console.log(`count: ${freeText?.length ?? 0}`);
  for (const p of freeText ?? []) console.log(JSON.stringify(p));

  const ids = (freeText ?? []).map((p: { id: string }) => p.id);
  if (ids.length > 0) {
    console.log("\n=== of those, subscription rows (paid vs. comp vs. never subscribed) ===");
    const { data: subs, error: sErr } = await supabaseAdmin
      .from("subscriptions")
      .select("user_id, plan, status, platform, current_period_end, created_at")
      .in("user_id", ids);
    if (sErr) throw sErr;
    console.log(`subscription rows: ${subs?.length ?? 0}`);
    for (const s of subs ?? []) console.log(JSON.stringify(s));
  }

  console.log(
    "\n=== confirmed via direct probe: no commission/ledger/payout/referral/clicks table exists (all PGRST205) ===",
  );
}
main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
