// One-off: read every feature_flags row live, for a manual audit of
// audience vs. whether the gated feature is actually built/shipped.
// Read-only. Delete after use.
import "dotenv/config";
import { supabaseAdmin } from "../src/lib/supabase";

async function main() {
  const { data, error } = await supabaseAdmin
    .from("feature_flags")
    .select(
      "key, enabled, audience, allowed_user_ids, rollout_percentage, description, created_at, updated_at",
    )
    .order("key");
  if (error) {
    console.error("ERROR:", error);
    process.exit(1);
  }
  console.log(JSON.stringify(data, null, 2));
}
main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
