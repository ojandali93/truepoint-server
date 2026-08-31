// src/controllers/adminSetLogo.controller.ts
//
// Manual set-logo path (Phase 2, 2026-09-01): for sets no automated source
// covers at all — today that's all 87 One Piece sets, plus whatever stays
// genuinely gapped after pokemontcg.io + TCGdex (see
// setImageBackfill.service.ts's needs-alias backlog and the TCGdex
// adapter's honest 0-match limitation). Omar hand-harvests art from
// official product pages and uploads it here one set at a time.
//
// Auth: mounted under admin.routes.ts, which gates authenticateUser +
// requireAdmin on every route in the router — no separate check needed
// here.
//
// Unlike the automated backfills, this ALWAYS overwrites whatever's in
// logo_url/symbol_url — an explicit admin upload for a specific set is
// authoritative, not a "fill nulls only" sweep.

import { Response } from "express";
import multer from "multer";
import { supabaseAdmin } from "../lib/supabase";
import { logError } from "../lib/Logger";
import {
  ALLOWED_MIME_TYPES,
  LogoKind,
  uploadBufferToBucket,
} from "../lib/setLogoStorage";
import { AuthenticatedRequest } from "../types/user.types";

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5MB, matches the bucket's own limit

export const setLogoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
}).single("file");

export const uploadSetLogo = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  try {
    const { setId } = req.params;
    const kind = (req.body?.kind ?? req.query?.kind ?? "logo") as LogoKind;

    if (kind !== "logo" && kind !== "symbol") {
      res.status(400).json({ error: "kind must be 'logo' or 'symbol'" });
      return;
    }

    const file = (req as any).file as Express.Multer.File | undefined;
    if (!file) {
      res.status(400).json({ error: "No file uploaded (field name: file)" });
      return;
    }

    if (!ALLOWED_MIME_TYPES[file.mimetype]) {
      res.status(400).json({
        error: `Unsupported file type: ${file.mimetype}. Allowed: ${Object.keys(ALLOWED_MIME_TYPES).join(", ")}`,
      });
      return;
    }

    const { data: set, error: findErr } = await supabaseAdmin
      .from("sets")
      .select("id, name")
      .eq("id", setId)
      .single();

    if (findErr || !set) {
      res.status(404).json({ error: `No set with id ${setId}` });
      return;
    }

    const url = await uploadBufferToBucket(
      setId,
      kind,
      file.buffer,
      file.mimetype,
    );

    const column = kind === "logo" ? "logo_url" : "symbol_url";
    const { error: updateErr } = await supabaseAdmin
      .from("sets")
      .update({ [column]: url })
      .eq("id", setId);

    if (updateErr) throw updateErr;

    res.json({ setId, name: set.name, kind, url });
  } catch (err: any) {
    console.error("[AdminSetLogo] upload failed:", err?.message);
    await logError({
      source: "admin-set-logo-upload",
      message: err?.message ?? "Unknown error",
      error: err,
      userId: (req as AuthenticatedRequest).user?.id ?? null,
      requestPath: req.originalUrl,
      requestMethod: req.method,
      metadata: { setId: req.params?.setId },
    });
    res.status(500).json({ error: "Upload failed" });
  }
};

// GET /api/v1/admin/sets/needs-logo?game=onepiece&language=English
// Drives the hand-harvest workflow — enumerates what's still missing so the
// admin doesn't have to re-derive the list from a session report each time.
export const listSetsNeedingLogo = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  try {
    const { game, language } = req.query as Record<string, string>;

    let query = supabaseAdmin
      .from("sets")
      .select("id, name, game, language, release_date, logo_url, symbol_url")
      .order("game")
      .order("release_date", { ascending: false });

    if (game) query = query.eq("game", game);
    if (language) query = query.eq("language", language);

    const { data, error } = await query;
    if (error) throw error;

    const needsLogo = (data ?? []).filter(
      (s) => !s.logo_url || !s.symbol_url,
    );

    res.json({ total: needsLogo.length, sets: needsLogo });
  } catch (err: any) {
    console.error("[AdminSetLogo] list failed:", err?.message);
    res.status(500).json({ error: "Failed to list sets needing logos" });
  }
};
