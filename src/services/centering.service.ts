import { calculateCentering, validateBorders } from "../lib/centeringEngine";
import {
  insertCenteringReport,
  findReportById,
  findReportsByUser,
  findReportsByCard,
  deleteReport,
} from "../repositories/centering.repository";
import { CenteringInput, CenteringReport } from "../types/centering.types";

// Analyze only — no persistence, useful for live preview before saving
export const analyzeOnly = (input: CenteringInput) => {
  const validationError = validateBorders(input.borders);
  if (validationError) throw { status: 400, message: validationError };

  return calculateCentering(
    input.borders,
    input.imageWidth,
    input.imageHeight,
    input.dpi,
  );
};

// Analyze + persist — the standard save flow
export const analyzeAndSave = async (
  userId: string,
  input: CenteringInput,
): Promise<CenteringReport> => {
  const validationError = validateBorders(input.borders);
  if (validationError) throw { status: 400, message: validationError };

  const calc = calculateCentering(
    input.borders,
    input.imageWidth,
    input.imageHeight,
    input.dpi,
  );

  return insertCenteringReport(userId, {
    cardId: input.cardId ?? null,
    inventoryItemId: input.inventoryItemId ?? null,
    side: input.side,
    imageWidth: input.imageWidth,
    imageHeight: input.imageHeight,
    dpi: input.dpi,
    rotation: input.rotation,
    borders: input.borders,
    measurements: calc.measurements,
    percentages: calc.percentages,
    truepointScore: calc.truepointScore,
    grades: calc.grades,
    label: input.label ?? null,
  });
};

export const getReportById = async (
  id: string,
  userId: string,
): Promise<CenteringReport> => {
  const report = await findReportById(id);
  if (!report) throw { status: 404, message: "Centering report not found" };
  if (report.userId !== userId) throw { status: 403, message: "Access denied" };
  return report;
};

export const getMyReports = async (userId: string, page = 1) => {
  return findReportsByUser(userId, page);
};

export const getReportsForCard = async (userId: string, cardId: string) => {
  return findReportsByCard(userId, cardId);
};

export const removeReport = async (
  id: string,
  userId: string,
): Promise<void> => {
  const report = await findReportById(id);
  if (!report) throw { status: 404, message: "Report not found" };
  if (report.userId !== userId) throw { status: 403, message: "Access denied" };
  await deleteReport(id, userId);
};
