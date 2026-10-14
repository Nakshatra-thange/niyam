import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { extractPages } from "../src/agent/pdf.js";
import { extractRuleset, type ExtractionReport } from "../src/agent/extract.js";
import { DEFAULT_MODEL, openRouterModel } from "../src/agent/model.js";
import { CASES } from "./cases.js";
import { scoreCase, summarize, toMarkdown, type CaseScore } from "./score.js";

/**
 * Runs the agent over every policy and scores it against hand-written rules.
 *
 *   npm run eval                                   # default model, 1 run
 *   npm run eval -- --models nvidia/nemotron-3.5-lightning:free,openai/gpt-4.1-mini,google/gemini-2.5-flash
 *   npm run eval -- --runs 3                       # check consistency
 *   npm run eval -- --only suvidha,kirana-credit
 *
 * Writes evals/results/latest.md (paste into README) and a timestamped JSON.
 */
const { values } = parseArgs({
  options: {
    models: { type: "string", default: DEFAULT_MODEL },
    runs: { type: "string", default: "1" },
    only: { type: "string" },
  },
});
if (!process.env.OPENROUTER_API_KEY) {
  console.error("OPENROUTER_API_KEY is not set.");
  process.exit(1);
}

const models = values.models!.split(",").map((m) => m.trim()).filter(Boolean);
const runs = Math.max(1, Number(values.runs));
const only = values.only?.split(",").map((s) => s.trim());
const cases = CASES.filter((c) => !only || only.includes(c.lenderId) || only.some((o) => c.file.includes(o)));

const all: CaseScore[] = [];
for (const name of models) {
  console.log(`\n▶ ${name}`);
  const model = openRouterModel({ model: name });
  for (let run = 1; run <= runs; run++) {
    for (const c of cases) {
      let score: CaseScore;
      try {
        const pages = await extractPages(c.file);
        const report: ExtractionReport = await extractRuleset({ pages, lenderId: c.lenderId, model });
        score = scoreCase(c, report);
      } catch (err) {
        score = { ...scoreCase(c, null, (err as Error).message.slice(0, 200)), model: name };
      }
      all.push(score);
      const traps = `${score.traps.filter((t) => t.passed).length}/${score.traps.length}`;
      console.log(
        `  ${score.ok ? "✓" : "✗"} ${score.case.padEnd(22)} rules ${score.matched}/${score.expected}  traps ${traps}  ` +
          `${score.attempts} attempt(s)  ${(score.durationMs / 1000).toFixed(1)}s  $${score.cost.toFixed(4)}` +
          (score.error ? `  — ${score.error}` : ""),
      );
    }
  }
}

const summaries = models.map((m) => summarize(m, all.filter((s) => s.model === m)));
console.log("\n" + summaries.map((s) =>
  `${s.model}: recall ${Math.round(s.recall * 100)}%, precision ${Math.round(s.precision * 100)}%, traps ${s.trapsPassed}/${s.trapsTotal}, ` +
  `exact ${s.exactRulesets}/${s.cases}, first-try ${Math.round(s.firstTryRate * 100)}%, $${s.totalCost.toFixed(4)}`).join("\n"));

mkdirSync("evals/results", { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
writeFileSync(`evals/results/${stamp}.json`, JSON.stringify({ models, runs, summaries, scores: all }, null, 2));
writeFileSync("evals/results/latest.md", toMarkdown(summaries, all, { date: new Date().toISOString().slice(0, 10), runs }));
console.log(`\n📝 evals/results/latest.md`);