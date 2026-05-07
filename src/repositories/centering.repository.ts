import { supabase, supabaseAdmin } from "../lib/supabase";
import { CenteringReport } from "../types/centering.types";

type CenteringRow = {
  id: string;
  user_id: string;
  card_id: string | null;
  inventory_item_id: string | null;
  side: "front" | "back";
  image_width: number;
  image_height: number;
  dpi: number;
  rotation: number;
  outer_left: number;
  outer_right: number;
  outer_top: number;
  outer_bottom: number;
  inner_left: number;
  inner_right: number;
  inner_top: number;
  inner_bottom: number;
  left_border_mm: number;
  right_border_mm: number;
  top_border_mm: number;
  bottom_border_mm: number;
  left_pct: number;
  right_pct: number;
  top_pct: number;
  bottom_pct: number;
  lr_worse: number;
  tb_worse: number;
  worst_axis: number;
  truepoint_score: number;
  psa_grade: string;
  bgs_grade: string;
  cgc_grade: string;
  sgc_grade: string;
  tag_grade: string;
  created_at: string;
};

const rowToReport = (row: CenteringRow): CenteringReport => ({
  id: row.id,
  userId: row.user_id,
  cardId: row.card_id,
  inventoryItemId: row.inventory_item_id,
  side: row.side,
  imageWidth: row.image_width,
  imageHeight: row.image_height,
  dpi: row.dpi,
  rotation: row.rotation,
  borders: {
    outerLeft: row.outer_left,
    outerRight: row.outer_right,
    outerTop: row.outer_top,
    outerBottom: row.outer_bottom,
    innerLeft: row.inner_left,
    innerRight: row.inner_right,
    innerTop: row.inner_top,
    innerBottom: row.inner_bottom,
  },
  measurements: {
    leftMm: row.left_border_mm,
    rightMm: row.right_border_mm,
    topMm: row.top_border_mm,
    bottomMm: row.bottom_border_mm,
  },
  percentages: {
    leftPct: row.left_pct,
    rightPct: row.right_pct,
    topPct: row.top_pct,
    bottomPct: row.bottom_pct,
    lrWorse: row.lr_worse,
    tbWorse: row.tb_worse,
    worstAxis: row.worst_axis,
  },
  truepointScore: row.truepoint_score,
  grades: {
    psa: row.psa_grade,
    bgs: row.bgs_grade,
    cgc: row.cgc_grade,
    sgc: row.sgc_grade,
    tag: row.tag_grade,
  },
  createdAt: row.created_at,
});

export const insertCenteringReport = async (
  userId: string,
  input: Omit<CenteringReport, "id" | "userId" | "createdAt">,
): Promise<CenteringReport> => {
  const { data, error } = await supabaseAdmin
    .from("centering_reports")
    .insert({
      user_id: userId,
      card_id: input.cardId ?? null,
      inventory_item_id: input.inventoryItemId ?? null,
      side: input.side,
      image_width: input.imageWidth,
      image_height: input.imageHeight,
      dpi: input.dpi,
      rotation: input.rotation,
      outer_left: input.borders.outerLeft,
      outer_right: input.borders.outerRight,
      outer_top: input.borders.outerTop,
      outer_bottom: input.borders.outerBottom,
      inner_left: input.borders.innerLeft,
      inner_right: input.borders.innerRight,
      inner_top: input.borders.innerTop,
      inner_bottom: input.borders.innerBottom,
      left_border_mm: input.measurements.leftMm,
      right_border_mm: input.measurements.rightMm,
      top_border_mm: input.measurements.topMm,
      bottom_border_mm: input.measurements.bottomMm,
      left_pct: input.percentages.leftPct,
      right_pct: input.percentages.rightPct,
      top_pct: input.percentages.topPct,
      bottom_pct: input.percentages.bottomPct,
      lr_worse: input.percentages.lrWorse,
      tb_worse: input.percentages.tbWorse,
      worst_axis: input.percentages.worstAxis,
      truepoint_score: input.truepointScore,
      psa_grade: input.grades.psa,
      bgs_grade: input.grades.bgs,
      cgc_grade: input.grades.cgc,
      sgc_grade: input.grades.sgc,
      tag_grade: input.grades.tag,
    })
    .select()
    .single();

  if (error) throw error;
  return rowToReport(data as CenteringRow);
};

export const findReportById = async (
  id: string,
): Promise<CenteringReport | null> => {
  const { data, error } = await supabase
    .from("centering_reports")
    .select("*")
    .eq("id", id)
    .single();
  if (error && error.code !== "PGRST116") throw error;
  return data ? rowToReport(data as CenteringRow) : null;
};

export const findReportsByUser = async (
  userId: string,
  page = 1,
  limit = 20,
): Promise<CenteringReport[]> => {
  const offset = (page - 1) * limit;
  const { data, error } = await supabase
    .from("centering_reports")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) throw error;
  return (data ?? []).map((row) => rowToReport(row as CenteringRow));
};

export const findReportsByCard = async (
  userId: string,
  cardId: string,
): Promise<CenteringReport[]> => {
  const { data, error } = await supabase
    .from("centering_reports")
    .select("*")
    .eq("user_id", userId)
    .eq("card_id", cardId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []).map((row) => rowToReport(row as CenteringRow));
};

export const deleteReport = async (
  id: string,
  userId: string,
): Promise<void> => {
  const { error } = await supabase
    .from("centering_reports")
    .delete()
    .eq("id", id)
    .eq("user_id", userId);
  if (error) throw error;
};
