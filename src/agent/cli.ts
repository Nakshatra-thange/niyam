import "dotenv/config";
import { basename } from "node:path";
import { parseArgs } from "node:util";
import { extractPages } from "./pdf.js";
import { extractRuleset } from "./extract.js";
import { openRouterModel } from "./model.js";
import { compareRulesets } from "./compare.js";
import { SEED_RULESETS } from "../rules/seed-rules.js";

/**
 *   npm run agent:extract -- policies/suvidha.pdf --lender suvidha
 *   npm run agent:extract -- policies/suvidha.pdf --lender suvidha --model openai/gpt-4.1
 *   npm run agent:extract -- policies/suvidha.pdf --lender suvidha --save
 *
 * --save stores the result as a DRAFT ruleset. Drafts never route loans;
 * a human approves them in the review UI first.
 */
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    lender: { type: "string" },
    model: { type: "string" },
    save: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
  },
});
const file = positionals[0];
const lenderId = values.lender;
if (!file || !lenderId) {
  console.error("usage: npm run agent:extract -- <policy.pdf|.txt> --lender <id> [--model <openrouter-model>] [--save] [--json]");
  process.exit(1);
}
if (!process.env.OPENROUTER_API_KEY) {
  console.error("OPENROUTER_API_KEY is not set. Add it to .env (openrouter.ai/keys).");
  process.exit(1);
}

const pages = await extractPages(file);
console.log(`📄 ${basename(file)}: ${pages.length} page(s), ${pages.join(" ").length} chars`);

const model = openRouterModel({ model: values.model });
const report = await extractRuleset({
  pages,
  lenderId,
  model,
  onAttempt: (n, errors) =>
    console.log(errors.length ? `🔁 attempt ${n}: ${errors.length} validation error(s), asking the model to fix:\n   - ${errors.join("\n   - ")}` : `✅ attempt ${n}: passed validation`),
});
const u = report.usage;
console.log(`⏱  ${(report.durationMs / 1000).toFixed(1)}s, ${report.attempts} attempt(s), ${model.name}, ${u.promptTokens + u.completionTokens} tokens, $${u.cost.toFixed(4)}\n`);

if (values.json) console.log(JSON.stringify(report, null, 2));

if (!report.ok || !report.result.ruleset) {
  console.log("❌ Extraction failed validation after all retries. Remaining errors:");
  report.result.errors.forEach((e) => console.log(`   - ${e}`));
  process.exit(2);
}

const rs = report.result.ruleset;
console.log(`${rs.lenderName}  |  ${rs.interestRateMin}–${rs.interestRateMax}% p.a.${report.raw?.rateNote ? `  (${report.raw.rateNote})` : ""}`);
for (const r of rs.rules) {
  console.log(`  • ${r.field} ${r.op} ${JSON.stringify(r.value)}`);
  console.log(`      p${r.citation?.page}: "${r.citation?.quote}"`);
}
if (report.result.warnings.length) {
  console.log(`\n⚠️  For the human reviewer:`);
  report.result.warnings.forEach((w) => console.log(`   - ${w}`));
}

const known = SEED_RULESETS.find((s) => s.lenderId === lenderId);
if (known) {
  const cmp = compareRulesets(known, rs);
  console.log(`\n🎯 vs hand-written rules: ${cmp.matched.length}/${known.rules.length} exact (${Math.round(cmp.score * 100)}%)`);
  cmp.wrong.forEach((w) => console.log(`   ✗ expected ${w.expected}, got ${w.got}`));
  cmp.missing.forEach((m) => console.log(`   ✗ missing ${m}`));
  cmp.extra.forEach((x) => console.log(`   + extra ${x}`));
}

if (values.save) {
  const { pool } = await import("../db/client.js");
  const { saveDraft } = await import("../rulesets/repo.js");
  const saved = await saveDraft({ lenderId, ruleset: rs, report, sourceDocument: basename(file), sourcePages: pages, actor: process.env.USER ?? "cli" });
  console.log(`\n💾 saved as DRAFT ruleset #${saved.id} (${lenderId} v${saved.version}). Review it at http://localhost:3000/review`);
  await pool.end();
}