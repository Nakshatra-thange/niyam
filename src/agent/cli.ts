import "dotenv/config";
import { basename } from "node:path";
import { parseArgs } from "node:util";
import { extractPages } from "./pdf.js";
import { anthropicModel, extractRuleset } from "./extract.js";
import { compareRulesets } from "./compare.js";
import { SEED_RULESETS } from "../rules/seed-rules.js";

/**
 *   npm run agent:extract -- policies/suvidha.pdf --lender suvidha
 *   npm run agent:extract -- policies/suvidha.pdf --lender suvidha --save
 *
 * --save stores the result as a DRAFT ruleset. Drafts never route loans;
 * a human approves them first (Day 5).
 */
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { lender: { type: "string" }, save: { type: "boolean", default: false }, json: { type: "boolean", default: false } },
});
const file = positionals[0];
const lenderId = values.lender;
if (!file || !lenderId) {
  console.error("usage: npm run agent:extract -- <policy.pdf|.txt> --lender <id> [--save] [--json]");
  process.exit(1);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is not set. Add it to .env (get one at console.anthropic.com).");
  process.exit(1);
}

const pages = await extractPages(file);
console.log(`📄 ${basename(file)}: ${pages.length} page(s), ${pages.join(" ").length} chars`);

const started = Date.now();
const report = await extractRuleset({
  pages,
  lenderId,
  model: anthropicModel(),
  onAttempt: (n, errors) => console.log(errors.length ? `🔁 attempt ${n}: ${errors.length} validation error(s), asking the model to fix:\n   - ${errors.join("\n   - ")}` : `✅ attempt ${n}: passed validation`),
});
console.log(`⏱  ${((Date.now() - started) / 1000).toFixed(1)}s, ${report.attempts} attempt(s), model ${report.model}\n`);

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
  const { pool, withTx } = await import("../db/client.js");
  const saved = await withTx(async (c) => {
    await c.query(`INSERT INTO lenders (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`, [lenderId, rs.lenderName]);
    const { rows } = await c.query(`SELECT COALESCE(MAX(version), 0) + 1 AS v FROM rulesets WHERE lender_id = $1`, [lenderId]);
    const ins = await c.query(
      `INSERT INTO rulesets (lender_id, version, status, source, ruleset, report, source_document)
       VALUES ($1, $2, 'draft', 'agent', $3, $4, $5) RETURNING id, version`,
      [lenderId, rows[0].v, rs, { warnings: report.result.warnings, unsupported: report.raw?.unsupported_clauses, ambiguities: report.raw?.ambiguities, rateNote: report.raw?.rateNote, attempts: report.attempts, model: report.model, history: report.history }, basename(file)],
    );
    return ins.rows[0];
  });
  console.log(`\n💾 saved as DRAFT ruleset #${saved.id} (${lenderId} v${saved.version}). It will not route loans until approved.`);
  await pool.end();
}