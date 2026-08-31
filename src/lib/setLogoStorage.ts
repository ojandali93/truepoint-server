// src/lib/setLogoStorage.ts
//
// Shared storage layer for set logo/symbol art, backing:
//   - setImageBackfill.service.ts   (pokemontcg.io + TCGdex adapters — mirror
//     a matched external URL into our own bucket instead of hotlinking)
//   - setLogoMigration.service.ts   (one-time migration of pre-existing
//     external hotlinks, e.g. the 343 pokemontcg.io URLs written before this
//     file existed, into the same bucket)
//   - adminSetLogo.controller.ts    (manual admin upload — same bucket, same
//     path scheme, direct write instead of a mirrored download)
//
// Bucket: "set-logos" (public — logos are meant to be displayed in-app,
// same visibility class as the existing "Centering Images"/"Profile
// Pictures" buckets). Path scheme: `{setId}.{ext}` for the logo,
// `{setId}-symbol.{ext}` for the symbol. `{ext}` is png for every mirrored
// source (pokemontcg.io and TCGdex are both PNG) and whatever the admin
// actually uploads for the manual path (see ALLOWED_MIME_TYPES).

import axios from "axios";
import { supabaseAdmin } from "../lib/supabase";

export const SET_LOGO_BUCKET = "set-logos";

export const ALLOWED_MIME_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

export type LogoKind = "logo" | "symbol";

const objectPath = (setId: string, kind: LogoKind, ext: string): string =>
  kind === "logo" ? `${setId}.${ext}` : `${setId}-symbol.${ext}`;

export const getBucketPublicUrl = (path: string): string => {
  const { data } = supabaseAdmin.storage
    .from(SET_LOGO_BUCKET)
    .getPublicUrl(path);
  return data.publicUrl;
};

// True once a sets.logo_url/symbol_url already points at our own bucket —
// used to make the migration and mirror paths idempotent (skip re-download
// on re-run instead of re-fetching + re-uploading an already-mirrored file).
export const isOurBucketUrl = (url: string | null | undefined): boolean =>
  !!url && url.includes(`/storage/v1/object/public/${SET_LOGO_BUCKET}/`);

// Downloads `sourceUrl` and uploads it into the bucket at the standard path
// for (setId, kind), returning our own public URL. Always PNG — every
// source that calls this (pokemontcg.io, TCGdex) serves PNG. Throws on
// download or upload failure; caller decides how to log/count that.
export const mirrorUrlToBucket = async (
  setId: string,
  kind: LogoKind,
  sourceUrl: string,
): Promise<string> => {
  const res = await axios.get<ArrayBuffer>(sourceUrl, {
    responseType: "arraybuffer",
    timeout: 30000,
  });
  const path = objectPath(setId, kind, "png");
  const { error } = await supabaseAdmin.storage
    .from(SET_LOGO_BUCKET)
    .upload(path, Buffer.from(res.data), {
      contentType: "image/png",
      upsert: true,
    });
  if (error) throw error;
  return getBucketPublicUrl(path);
};

// Uploads an admin-provided buffer directly (no download step) — used by
// the manual upload endpoint. mimeType must be a key of ALLOWED_MIME_TYPES;
// caller validates that before calling this.
export const uploadBufferToBucket = async (
  setId: string,
  kind: LogoKind,
  buffer: Buffer,
  mimeType: string,
): Promise<string> => {
  const ext = ALLOWED_MIME_TYPES[mimeType];
  if (!ext) throw new Error(`Unsupported mime type: ${mimeType}`);
  const path = objectPath(setId, kind, ext);
  const { error } = await supabaseAdmin.storage
    .from(SET_LOGO_BUCKET)
    .upload(path, buffer, { contentType: mimeType, upsert: true });
  if (error) throw error;
  return getBucketPublicUrl(path);
};
