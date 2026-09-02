import "dotenv/config";
import { supabaseAdmin } from "../src/lib/supabase";

async function main() {
  const { data, error } = await supabaseAdmin
    .from("ai_grading_reports")
    .select("id, front_image, back_image, card_name")
    .eq("id", "3f2ddc0d-55c6-45c9-b4a7-87e085b474a8")
    .maybeSingle();
  if (error) throw error;
  console.log(JSON.stringify(data, null, 2));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
