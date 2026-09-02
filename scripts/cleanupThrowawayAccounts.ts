// One-off: delete the throwaway signup accounts created for Part A's
// live stitch-proof gate. Delete after use.
import "dotenv/config";
import { supabaseAdmin } from "../src/lib/supabase";

const EMAILS = [
  "posthog-stitch-proof-20260902@reverseholo.io",
  "posthog-stitch-proof-2-20260902@reverseholo.io",
  "posthog-stitch-proof-3-20260902@reverseholo.io",
];

async function main() {
  const { data, error } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 });
  if (error) throw error;
  for (const email of EMAILS) {
    const user = data.users.find((u) => u.email === email);
    if (!user) {
      console.log(email, "-> not found, skipping");
      continue;
    }
    const { error: delErr } = await supabaseAdmin.auth.admin.deleteUser(user.id);
    console.log(email, "->", delErr ? `FAILED: ${delErr.message}` : "deleted");
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
