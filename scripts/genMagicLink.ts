import "dotenv/config";
import { supabaseAdmin } from "../src/lib/supabase";

async function main() {
  const { data, error } = await supabaseAdmin.auth.admin.generateLink({
    type: "magiclink",
    email: "omarjandali93@gmail.com",
    options: { redirectTo: "http://localhost:3000/api/auth/callback" },
  });
  if (error) throw error;
  console.log(data.properties?.action_link);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
