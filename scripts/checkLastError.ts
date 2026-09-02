import "dotenv/config";
import { supabaseAdmin } from "../src/lib/supabase";

async function main() {
  const { data, error } = await supabaseAdmin
    .from("error_logs")
    .select("id, source, message, created_at")
    .eq("source", "inventory")
    .gte("created_at", new Date(Date.now() - 30 * 60 * 1000).toISOString())
    .order("created_at", { ascending: false })
    .limit(3);
  if (error) throw error;
  console.log(JSON.stringify(data, null, 2));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
