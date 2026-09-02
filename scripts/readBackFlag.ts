import "dotenv/config";
import { supabaseAdmin } from "../src/lib/supabase";

async function main() {
  const { data, error } = await supabaseAdmin
    .from("admin_flagged_reports")
    .select("*")
    .eq("report_id", "3f2ddc0d-55c6-45c9-b4a7-87e085b474a8")
    .eq("report_type", "ai_grading")
    .maybeSingle();
  if (error) throw error;
  console.log(JSON.stringify(data, null, 2));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
