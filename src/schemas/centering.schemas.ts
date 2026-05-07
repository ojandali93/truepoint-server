import { z } from "zod";

const borderValue = z
  .number()
  .min(0, "Border value must be >= 0")
  .max(1, "Border value must be <= 1");

export const analyzeCenteringSchema = z.object({
  borders: z.object({
    outerLeft: borderValue,
    outerRight: borderValue,
    outerTop: borderValue,
    outerBottom: borderValue,
    innerLeft: borderValue,
    innerRight: borderValue,
    innerTop: borderValue,
    innerBottom: borderValue,
  }),
  imageWidth: z.number().int().min(100, "Image width too small"),
  imageHeight: z.number().int().min(100, "Image height too small"),
  dpi: z.number().int().min(72).max(9600).default(1600),
  rotation: z.number().min(-45).max(45).default(0),
  side: z.enum(["front", "back"]).default("front"),
  cardId: z.string().optional(),
  inventoryItemId: z.string().uuid().optional(),
  label: z.string().max(200).optional(),
});

export const saveCenteringReportSchema = analyzeCenteringSchema;
// saving is the same payload as analyzing — backend calculates and persists in one step
