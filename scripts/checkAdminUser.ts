// One-off, read-only: check the two recurring tester UUIDs seen across
// feature-flag allowlists for admin role + real AI grading report data,
// for the Part B live-proof. Delete after use.
import "dotenv/config";
import { supabaseAdmin } from "../src/lib/supabase";

const CANDIDATES = [
  "93ba1448-db96-4aff-994a-ffdc20cfabe8",
  "25e63b99-c664-430b-a48d-6ffa548b5818",
  "1ffd8815-bc62-49b8-af28-ce375030df08",
];

async function main() {
  for (const id of CANDIDATES) {
    const { data, error } = await supabaseAdmin.auth.admin.getUserById(id);
    if (error || !data.user) {
      console.log(id, "-> not found");
      continue;
    }
    const { count } = await supabaseAdmin
      .from("ai_grading_reports")
      .select("id", { count: "exact", head: true })
      .eq("user_id", id);
    const { data: profile } = await supabaseAdmin
      .from("profiles")
      .select("username, full_name")
      .eq("id", id)
      .maybeSingle();
    console.log(
      id,
      "email:", data.user.email,
      "role:", data.user.app_metadata?.role ?? "(none)",
      "username:", profile?.username,
      "ai_grading_reports:", count ?? 0,
    );
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
