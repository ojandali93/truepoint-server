// src/controllers/ebayArbitrage.controller.ts
//
// Admin-first eBay arbitrage:
//   GET  /ebay/search?q=...                 → active listings
//   POST /ebay/analyze   { itemId, ... }    → fetch listing images → Gemini
//                                              grade prediction → save report
//   GET  /ebay/reports                      → saved reports
//   DELETE /ebay/reports/:id                → delete a report
//
// Reuses the EXISTING grader (analyzeCardForGrading) and the URL→base64 fetch
// pattern from geminiClient. Gated to admin for now (swap/extend the gate when
// rolling out to Pro).

import axios from "axios";
import { Response } from "express";

import { analyzeCardForGrading } from "../lib/geminiClient";
import { logError } from "../lib/Logger";
import { supabaseAdmin } from "../lib/supabase";
import {
  getListing,
  searchListings,
  type EbayListingDetail,
  type SearchFilters,
} from "../lib/ebayClient";
import { AuthenticatedRequest } from "../types/user.types";

// ─── admin gate (feature is admin-first) ──────────────────────────────────────

const requireAdmin = (req: AuthenticatedRequest, res: Response): boolean => {
  if (req.user?.role !== "admin") {
    res.status(403).json({ error: "eBay arbitrage is currently admin-only." });
    return false;
  }
  return true;
};

// fetch an image URL → { base64, mime }
const urlToBase64 = async (
  url: string,
): Promise<{
  base64: string;
  mime: "image/jpeg" | "image/png" | "image/webp";
}> => {
  const r = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: 20000,
  });
  const base64 = Buffer.from(r.data).toString("base64");
  const ct = (r.headers["content-type"] ?? "image/jpeg") as string;
  const mime = ct.includes("png")
    ? "image/png"
    : ct.includes("webp")
      ? "image/webp"
      : "image/jpeg";
  return { base64, mime };
};

// recommendation logic (same thresholds as AI grading controller)
const recommend = (a: any): { recommendation: string; reason: string } => {
  const psa = a?.predictions?.psa?.grade ?? 0;
  const subs = [a?.centering, a?.corners, a?.edges, a?.surface].filter(
    (n) => typeof n === "number",
  );
  const avg = subs.length
    ? subs.reduce((x: number, y: number) => x + y, 0) / subs.length
    : 0;
  if (a?.predictions?.bgs?.isBlackLabel)
    return {
      recommendation: "grade",
      reason: "Potential BGS Black Label — submit immediately.",
    };
  if (psa >= 10)
    return {
      recommendation: "grade",
      reason: `Predicted PSA 10 (avg ${avg.toFixed(2)}). Strong candidate.`,
    };
  if (psa >= 9)
    return {
      recommendation: "grade",
      reason: `Predicted PSA 9 (avg ${avg.toFixed(2)}). Worth grading if value supports it.`,
    };
  if (psa >= 8)
    return {
      recommendation: "borderline",
      reason: `Predicted PSA ${psa} (avg ${avg.toFixed(2)}). Borderline — depends on raw vs graded spread.`,
    };
  return {
    recommendation: "skip",
    reason: `Predicted PSA ${psa} (avg ${avg.toFixed(2)}). Grading cost likely exceeds value added.`,
  };
};

// ─── GET /ebay/search ─────────────────────────────────────────────────────────

export const searchEbay = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  try {
    const q = String(req.query.q ?? "").trim();
    if (!q) {
      res.status(400).json({ error: "Missing search query" });
      return;
    }
    const limit = Math.min(Number(req.query.limit ?? 20) || 20, 50);

    // Parse filters from query params (all optional)
    const b = (v: unknown) => v === "true" || v === "1";
    const num = (v: unknown) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    };
    const filters: SearchFilters = {
      buyItNow:
        req.query.buyItNow !== undefined ? b(req.query.buyItNow) : undefined,
      auction:
        req.query.auction !== undefined ? b(req.query.auction) : undefined,
      bestOffer:
        req.query.bestOffer !== undefined ? b(req.query.bestOffer) : undefined,
      minPrice: num(req.query.minPrice),
      maxPrice: num(req.query.maxPrice),
      conditionIds: req.query.conditionIds
        ? String(req.query.conditionIds)
            .split(",")
            .map((x) => Number(x))
            .filter((n) => Number.isFinite(n))
        : undefined,
      graded:
        req.query.graded === undefined
          ? undefined
          : req.query.graded === "true"
            ? true
            : req.query.graded === "false"
              ? false
              : undefined,
      sort: ["best", "price_asc", "price_desc", "newest"].includes(
        String(req.query.sort),
      )
        ? (String(req.query.sort) as SearchFilters["sort"])
        : undefined,
    };

    const listings = await searchListings(q, limit, filters);
    res.json({ data: listings });
  } catch (err: any) {
    await logError({
      source: "ebay-search",
      message: err?.message ?? "eBay search failed",
      error: err,
      userId: req.user?.id ?? null,
      requestPath: req.path,
      requestMethod: req.method,
      metadata: { q: req.query.q },
    });
    res
      .status(err?.status ?? 502)
      .json({ error: err?.message ?? "eBay search failed" });
  }
};

// ─── GET /ebay/listing/:itemId ────────────────────────────────────────────────
// Full listing detail (all images, description) for the detail screen — lets the
// user review a listing before spending a Gemini call to analyze it.

export const getEbayListingDetail = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  try {
    const itemId = req.params.itemId;
    if (!itemId) {
      res.status(400).json({ error: "Missing itemId" });
      return;
    }
    const listing = await getListing(itemId);
    res.json({ data: listing });
  } catch (err: any) {
    await logError({
      source: "ebay-listing-detail",
      message: err?.message ?? "eBay listing fetch failed",
      error: err,
      userId: req.user?.id ?? null,
      requestPath: req.path,
      requestMethod: req.method,
      metadata: { itemId: req.params.itemId },
    });
    res
      .status(err?.status ?? 502)
      .json({ error: err?.message ?? "Couldn't load listing" });
  }
};

// ─── POST /ebay/analyze ───────────────────────────────────────────────────────

export const analyzeEbayListing = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  try {
    const { itemId, cardName, setName, notes } = req.body ?? {};
    if (!itemId) {
      res.status(400).json({ error: "Missing itemId" });
      return;
    }

    // 1) Pull the full listing (all images)
    const listing: EbayListingDetail = await getListing(itemId);
    if (!listing.imageUrls.length) {
      res
        .status(422)
        .json({ error: "Listing has no usable images to analyze." });
      return;
    }

    // 2) Pick front + back. eBay listings vary; use first image as front,
    //    second (if present) as back. If only one image, use it for both.
    const frontUrl = listing.imageUrls[0];
    const backUrl = listing.imageUrls[1] ?? listing.imageUrls[0];
    const [front, back] = await Promise.all([
      urlToBase64(frontUrl),
      urlToBase64(backUrl),
    ]);

    // 3) Reuse the EXISTING grader
    const analysis = await analyzeCardForGrading(
      front.base64,
      front.mime,
      back.base64,
      back.mime,
      cardName,
      setName,
    );

    const rec = recommend(analysis);

    // 4) Save the report
    const { data, error } = await supabaseAdmin
      .from("ebay_analysis_reports")
      .insert({
        user_id: req.user!.id,
        ebay_item_id: listing.itemId,
        title: listing.title,
        price_value: listing.price ? Number(listing.price.value) : null,
        price_currency: listing.price?.currency ?? null,
        condition: listing.condition,
        item_web_url: listing.itemWebUrl,
        primary_image: listing.imageUrl,
        image_urls: listing.imageUrls,
        analysis,
        recommendation: rec.recommendation,
        recommendation_reason: rec.reason,
        card_name: cardName ?? null,
        set_name: setName ?? null,
        notes: notes ?? null,
        status: "complete",
      })
      .select()
      .single();

    if (error) throw error;
    res.json({ data });
  } catch (err: any) {
    await logError({
      source: "ebay-analyze",
      message: err?.message ?? "eBay analyze failed",
      error: err,
      userId: req.user?.id ?? null,
      requestPath: req.path,
      requestMethod: req.method,
      metadata: { itemId: req.body?.itemId },
    });
    res
      .status(err?.status ?? 500)
      .json({ error: err?.message ?? "Analysis failed" });
  }
};

// ─── GET /ebay/reports ────────────────────────────────────────────────────────

export const getEbayReports = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  try {
    const { data, error } = await supabaseAdmin
      .from("ebay_analysis_reports")
      .select("*")
      .eq("user_id", req.user!.id)
      .order("created_at", { ascending: false });
    if (error) throw error;
    res.json({ data: data ?? [] });
  } catch (err: any) {
    res
      .status(err?.status ?? 500)
      .json({ error: err?.message ?? "Couldn't load reports" });
  }
};

// ─── DELETE /ebay/reports/:id ─────────────────────────────────────────────────

export const deleteEbayReport = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  try {
    const { error } = await supabaseAdmin
      .from("ebay_analysis_reports")
      .delete()
      .eq("id", req.params.id)
      .eq("user_id", req.user!.id);
    if (error) throw error;
    res.json({ data: { deleted: true } });
  } catch (err: any) {
    res
      .status(err?.status ?? 500)
      .json({ error: err?.message ?? "Couldn't delete report" });
  }
};
