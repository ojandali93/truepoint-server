// scripts/repeatCalibrationCheck.ts
//
// One-off: characterize run-to-run consistency for the two cases that showed
// perception-level variance during prompt tuning (mew-gold-star-back-
// whitening and control-clean-2) — runs each N times and reports the PSA
// grade distribution. Not part of the permanent gate (validateGradingCalibration.ts
// is), just evidence for the recalibration report.
import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import { analyzeCardForGrading } from "../src/lib/geminiClient";

const FIXTURES_DIR = path.join(__dirname, "..", "fixtures", "grading-calibration");
const CASES = ["mew-gold-star-back-whitening", "control-clean-2"];
const REPS = 3;

function loadImage(dir: string, name: string) {
  const buf = fs.readFileSync(path.join(dir, name));
  return { base64: buf.toString("base64"), mime: "image/jpeg" as const };
}

async function main() {
  for (const caseId of CASES) {
    const dir = path.join(FIXTURES_DIR, caseId);
    const front = loadImage(dir, "front.jpg");
    const back = loadImage(dir, "back.jpg");
    console.log(`\n=== ${caseId} — ${REPS} reps ===`);
    const grades: number[] = [];
    for (let i = 0; i < REPS; i++) {
      const result = await analyzeCardForGrading(
        front.base64,
        front.mime,
        back.base64,
        back.mime,
      );
      grades.push(result.predictions.psa.grade);
      console.log(
        `  rep ${i + 1}: PSA ${result.predictions.psa.grade} — issues: ${result.issues.length}`,
      );
      for (const issue of result.issues) console.log(`    - ${issue}`);
    }
    console.log(`  grades: [${grades.join(", ")}]`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
