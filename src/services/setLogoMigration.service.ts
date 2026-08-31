// src/services/setLogoMigration.service.ts
//
// ONE-TIME migration (Phase 2, 2026-09-01): every sets.logo_url/symbol_url
// written before the mirror-into-bucket change (src/lib/setLogoStorage.ts)
// is a direct hotlink to pokemontcg.io — 343 English Pokémon sets as of
// this date. Downloads each one and re-uploads it into our own "set-logos"
// bucket, then repoints the column at our bucket URL.
//
// Idempotent and safe to re-run: only touches rows whose logo_url/symbol_url
// is non-null AND not already one of our own bucket URLs (isOurBucketUrl),
// so a set already migrated (or a set already served by the manual-upload
// path) is skipped, not re-downloaded. Generic over game/language — this
// isn't pokemontcg.io-specific, it'll pick up TCGdex-sourced or
// manually-uploaded-then-somehow-external rows the same way, though today
// the 343 pokemontcg.io rows are the only ones that qualify.

import { supabaseAdmin } from "../lib/supabase";
import { logError } from "../lib/Logger";
import { mirrorUrlToBucket, isOurBucketUrl } from "../lib/setLogoStorage";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface FailedEntry {
  setId: string;
  name: string;
  field: "logo_url" | "symbol_url";
  message: string;
}

export const migrateExistingLogosToBucket = async (): Promise<{
  total: number;
  migrated: number;
  failed: number;
  failedDetail: FailedEntry[];
}> => {
  const { data } = await supabaseAdmin
    .from("sets")
    .select("id, name, logo_url, symbol_url");

  const targets = (data ?? []).filter(
    (s) =>
      (s.logo_url && !isOurBucketUrl(s.logo_url)) ||
      (s.symbol_url && !isOurBucketUrl(s.symbol_url)),
  );

  let migrated = 0;
  let failed = 0;
  const failedDetail: FailedEntry[] = [];

  for (const set of targets) {
    const update: Record<string, string> = {};

    if (set.logo_url && !isOurBucketUrl(set.logo_url)) {
      try {
        update.logo_url = await mirrorUrlToBucket(
          set.id,
          "logo",
          set.logo_url,
        );
      } catch (err: any) {
        failed++;
        failedDetail.push({
          setId: set.id,
          name: set.name,
          field: "logo_url",
          message: err?.message ?? "unknown error",
        });
        await logError({
          source: "set-logo-migration",
          message: `migrate logo failed: ${err?.message}`,
          error: err,
          userId: null,
          requestPath: set.logo_url,
          requestMethod: "GET",
          metadata: { setId: set.id, name: set.name },
        });
      }
    }

    if (set.symbol_url && !isOurBucketUrl(set.symbol_url)) {
      try {
        update.symbol_url = await mirrorUrlToBucket(
          set.id,
          "symbol",
          set.symbol_url,
        );
      } catch (err: any) {
        failed++;
        failedDetail.push({
          setId: set.id,
          name: set.name,
          field: "symbol_url",
          message: err?.message ?? "unknown error",
        });
        await logError({
          source: "set-logo-migration",
          message: `migrate symbol failed: ${err?.message}`,
          error: err,
          userId: null,
          requestPath: set.symbol_url,
          requestMethod: "GET",
          metadata: { setId: set.id, name: set.name },
        });
      }
    }

    if (Object.keys(update).length === 0) continue;

    const { error } = await supabaseAdmin
      .from("sets")
      .update(update)
      .eq("id", set.id);

    if (error) {
      failed++;
      failedDetail.push({
        setId: set.id,
        name: set.name,
        field: "logo_url",
        message: error.message,
      });
      await logError({
        source: "set-logo-migration",
        message: error.message,
        error,
        userId: null,
        requestPath: "",
        requestMethod: "",
        metadata: { setId: set.id, name: set.name },
      });
    } else {
      migrated++;
    }

    await sleep(20);
  }

  return { total: targets.length, migrated, failed, failedDetail };
};
