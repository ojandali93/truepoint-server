// scripts/validateCounterfeitCalibration.ts
//
// Golden-set runner for the counterfeit-screening prompt
// (fixtures/counterfeit-calibration/) — see
// AUDITS/counterfeit-screening-plan.md for the full design and Phase 0's
// gate. Replays every case in the golden set against the LIVE Gemini
// prompt (screenCardForCounterfeits) — real API calls, real images, no
// mocking — and checks:
//   - "known-genuine" cases: must NOT come back with concernCount > 0,
//     and the backlight_result finding must explicitly say "skipped" when
//     no backlit.jpg is present (never silently blank, never read as a pass)
//   - "known-fake" cases: must come back with concernCount > 0, and
//     handVerifiedFindings (once you've confirmed the physical card) are
//     printed for a manual cross-check against what the model actually
//     found — not string-matched, since finding phrasing is free text
//   - "pattern" cases (no ground truth yet): printed for a directional
//     read only, never gated
//
// Rerun this on any future prompt change to catch calibration regressions
// before they ship — same role fixtures/grading-calibration's runner plays
// for the grading prompt.
//
// Usage: npx ts-node scripts/validateCounterfeitCalibration.ts
//        (or: node scripts/validateCounterfeitCalibration.ts on Node >= 22)

import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import { screenCardForCounterfeits } from "../src/services/counterfeitScreening.service";

const FIXTURES_DIR = path.join(__dirname, "..", "fixtures", "counterfeit-calibration");

interface CaseFile {
  id: string;
  kind: "known-fake" | "known-genuine" | "pattern" | "control";
  card: string;
  source: string;
  sourceNote: string;
  groundTruth: "counterfeit" | "genuine" | "unknown";
  expectedFindings?: string[];
  handVerifiedFindings?: string[];
  expectedTopLineDirection?: "concerns found" | "no red flags" | null;
  notes?: string;
}

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(`  ${ok ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

function loadImageIfExists(
  dir: string,
  name: string,
): { base64: string; mime: "image/jpeg" } | undefined {
  const p = path.join(dir, name);
  if (!fs.existsSync(p)) return undefined;
  const buf = fs.readFileSync(p);
  return { base64: buf.toString("base64"), mime: "image/jpeg" };
}

async function runCase(caseDir: string) {
  const caseJsonPath = path.join(caseDir, "case.json");
  if (!fs.existsSync(caseJsonPath)) return;
  const c: CaseFile = JSON.parse(fs.readFileSync(caseJsonPath, "utf-8"));

  console.log(`\n=== ${c.id} (${c.kind}, ground truth: ${c.groundTruth}) — ${c.card} ===`);

  const front = loadImageIfExists(caseDir, "front.jpg");
  const back = loadImageIfExists(caseDir, "back.jpg");
  const backlit = loadImageIfExists(caseDir, "backlit.jpg");

  if (!front || !back) {
    console.log("  ❌ missing front.jpg or back.jpg — skipping");
    failures++;
    return;
  }

  const result = await screenCardForCounterfeits({
    frontBase64: front.base64,
    frontMime: front.mime,
    backBase64: back.base64,
    backMime: back.mime,
    backlitBase64: backlit?.base64,
    backlitMime: backlit?.mime,
  });

  console.log(`  identified: ${result.identifiedCard.name ?? "(not identified)"} — match: ${result.identifiedCard.matchConfidence}`);
  console.log(`  reference image used: ${result.referenceImageUsed}`);
  console.log(`  backlit included: ${result.backlitIncluded}`);
  console.log(`  top line: ${result.topLineResult}`);
  console.log(`  overall confidence: ${result.analysis.overallConfidence}`);
  console.log(`  findings:`);
  for (const f of result.analysis.findings) {
    console.log(
      `    [${f.severity.padEnd(10)}] ${f.property} (conf ${f.confidence}, ref ${f.referenceUsed}): ${f.findingText}`,
    );
  }
  console.log(`  notes: ${result.analysis.notes}`);

  // Structural checks, every case regardless of kind.
  check(
    "all 10 properties present exactly once",
    result.analysis.findings.length === 10,
    `got ${result.analysis.findings.length}`,
  );
  check(
    "top-line result never claims authenticity",
    !/\b(authentic|genuine|real|verified|passed)\b/i.test(result.topLineResult) ||
      result.topLineResult.includes("not an authentication"),
  );

  if (!result.backlitIncluded) {
    const bl = result.analysis.findings.find((f) => f.property === "backlight_result");
    check(
      "backlight finding explicitly notes it was skipped (not silently blank)",
      !!bl &&
        /skip|not (?:provided|included|performed|taken)|no backlit/i.test(
          bl.findingText,
        ),
      bl?.findingText,
    );
  }

  if (c.kind === "known-genuine" || c.kind === "control") {
    check(
      "no concerning/strong findings on a known-genuine card",
      result.concernCount === 0,
      `concernCount=${result.concernCount}`,
    );
  } else if (c.kind === "known-fake") {
    check(
      "at least one concerning/strong finding on a known-fake card",
      result.concernCount > 0,
      `concernCount=${result.concernCount}`,
    );
    if (c.handVerifiedFindings?.length) {
      console.log("  hand-verified findings (manual cross-check, not string-matched):");
      for (const hv of c.handVerifiedFindings) console.log(`    - ${hv}`);
    }
  } else if (c.kind === "pattern") {
    console.log(`  (pattern case, no gate — directional read only)`);
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

  console.log(`Found ${dirs.length} case(s) in ${FIXTURES_DIR}`);

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
