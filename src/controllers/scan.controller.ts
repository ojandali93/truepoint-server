// src/controllers/scan.controller.ts
import { Request, Response } from "express";

import { identifyAndMatch } from "../services/scan.service";
import { logError } from "../lib/Logger";

// POST /api/v1/scan/identify
// Body: { imageBase64: string, mime?: string }
// Returns: { data: ScanResult[] }  (one entry per detected card)
export async function identify(req: Request, res: Response): Promise<void> {
  try {
    const { imageBase64, mime } = (req.body ?? {}) as {
      imageBase64?: string;
      mime?: string;
    };

    if (!imageBase64 || typeof imageBase64 !== "string") {
      res.status(400).json({ error: "imageBase64 is required" });
      return;
    }

    const results = await identifyAndMatch(
      imageBase64,
      typeof mime === "string" ? mime : "image/jpeg",
    );
    res.json({ data: results });
  } catch (err: any) {
    await logError({
      source: "scan-identify",
      message: err?.message ?? "scan identify failed",
      error: err,
      userId: (req as unknown as { user?: { id?: string } }).user?.id ?? null,
      requestPath: req.path,
      requestMethod: req.method,
      metadata: {},
    });
    res
      .status(502)
      .json({ error: "Card identification failed. Please try again." });
  }
}
