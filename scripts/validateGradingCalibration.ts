// scripts/validateGradingCalibration.ts
//
// Golden-set runner for the AI grading prompt (fixtures/grading-calibration/).
// Recalibration context: a real miscall — heavy back-edge whitening on all
// four edges + fuzzed corners — received a PSA-equivalent 8 under the old
// blended-front+back prompt; realistic is 4-5. This replays every case in
// the golden set against the LIVE Gemini prompt (analyzeCardForGrading) —
// real API calls, real images, no mocking — and checks:
//   - "anchor"/"control" cases: PSA-equivalent grade lands in expectedGradeRange
//   - "pattern" cases: no pinned range (no hand-verification), just printed
//     for a directional read against their old-prompt result
//
// Rerun this on any future prompt change to catch calibration regressions
// before they ship.
//
// Usage: npx ts-node scripts/validateGradingCalibration.ts
//        (or: node scripts/validateGradingCalibration.ts on Node >= 22)

import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import { analyzeCardForGrading } from "../src/lib/geminiClient";

const FIXTURES_DIR = path.join(__dirname, "..", "fixtures", "grading-calibration");

interface CaseFile {
  id: string;
  kind: "anchor" | "pattern" | "control";
  card: string;
  sourceReportId: string;
  sourceNote: string;
  expectedGradeRange: [number, number] | null;
  expectedGradeBasis?: string;
  expectedDirection?: string;
  handVerifiedFindings?: string[];
  oldPromptResult: {
    predictions: Record<string, number>;
    issues?: string[];
    strengths?: string[];
    notes?: string;
  };
}

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(`  ${ok ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

function loadImage(dir: string, name: string): { base64: string; mime: "image/jpeg" } {
  const buf = fs.readFileSync(path.join(dir, name));
  return { base64: buf.toString("base64"), mime: "image/jpeg" };
}

async function runCase(caseDir: string) {
  const caseJsonPath = path.join(caseDir, "case.json");
  if (!fs.existsSync(caseJsonPath)) return;
  const c: CaseFile = JSON.parse(fs.readFileSync(caseJsonPath, "utf-8"));

  console.log(`\n=== ${c.id} (${c.kind}) — ${c.card} ===`);
  console.log(`  old prompt: PSA ${c.oldPromptResult.predictions.psa}`);

  const front = loadImage(caseDir, "front.jpg");
  const back = loadImage(caseDir, "back.jpg");

  const result = await analyzeCardForGrading(
    front.base64,
    front.mime,
    back.base64,
    back.mime,
  );

  const psa = result.predictions.psa.grade;
  console.log(`  new prompt: PSA ${psa} (TP ${result.tpScore}/100)`);
  console.log(`  front sub: ${JSON.stringify(result.report.sub)}`);
  console.log(`  centering: front ${result.centeringRatio.front} / back ${result.centeringRatio.back}`);
  console.log(`  issues:`);
  for (const issue of result.issues) console.log(`    - ${issue}`);
  console.log(`  strengths:`);
  for (const s of result.strengths) console.log(`    - ${s}`);
  console.log(`  notes: ${result.notes}`);

  if (c.expectedGradeRange) {
    const [lo, hi] = c.expectedGradeRange;
    check(
      `PSA-equivalent grade ${psa} in expected range [${lo}, ${hi}]`,
      psa >= lo && psa <= hi,
      `basis: ${c.expectedGradeBasis ?? "n/a"}`,
    );
    if (c.handVerifiedFindings?.length) {
      const issuesText = result.issues.join(" ").toLowerCase();
      const mentionsBack = issuesText.includes("back");
      const mentionsEdge = issuesText.includes("edge");
      const mentionsCorner = issuesText.includes("corner");
      check(
        "findings cite back-face edge/corner damage (not just a low number)",
        mentionsBack && mentionsEdge && mentionsCorner,
      );
    }
  } else if (c.expectedDirection) {
    // Informational only — no hand-verification exists for these (they're
    // from the Reddit-scraper pipeline, not a card anyone has confirmed
    // against the physical original), so a clean read here isn't a gate
    // failure the way it would be for a control case. Printed for a
    // directional read against the old prompt, not asserted.
    console.log(`  (pattern case, no pinned range) expected: ${c.expectedDirection}`);
    const movedDown = psa < c.oldPromptResult.predictions.psa;
    console.log(
      `  ${movedDown ? "↓" : "•"} PSA-equivalent grade ${psa} vs. old prompt's ${c.oldPromptResult.predictions.psa} (informational, not gated)`,
    );
  }
}

async function main() {
  if (!process.env.GEMINI_API_KEY) {
    console.error("GEMINI_API_KEY not set — cannot run live golden-set validation.");
    process.exit(1);
  }

  const dirs = fs
    .readdirSync(FIXTURES_DIR)
    .map((name) => path.join(FIXTURES_DIR, name))
    .filter((p) => fs.statSync(p).isDirectory());

  for (const dir of dirs) {
    await runCase(dir);
  }

  console.log(`\n${failures === 0 ? "✅ ALL CHECKS PASSED" : `❌ ${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
