import { pool, withTx } from "./client.js";
import { SEED_RULESETS } from "../rules/seed-rules.js";
import { LenderRulesetSchema } from "../rules/schema.js";

// Inserts the 5 lenders and makes their hand-written rules version 1 (active).
// Skips any lender that already has an active ruleset, so it's safe to re-run.
for (const raw of SEED_RULESETS) {
  const ruleset = LenderRulesetSchema.parse(raw); // fail loudly if seed data is invalid

  await withTx(async (c) => {
    await c.query(`INSERT INTO lenders (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`, [ruleset.lenderId, ruleset.lenderName]);

    const existing = await c.query(`SELECT 1 FROM rulesets WHERE lender_id = $1 AND status = 'active'`, [ruleset.lenderId]);
    if (existing.rowCount) {
      console.log(`- ${ruleset.lenderId}: already has active rules, skipped`);
      return;
    }

    const { rows } = await c.query(`SELECT COALESCE(MAX(version), 0) + 1 AS v FROM rulesets WHERE lender_id = $1`, [ruleset.lenderId]);
    await c.query(
      `INSERT INTO rulesets (lender_id, version, status, source, ruleset, approved_at)
       VALUES ($1, $2, 'active', 'manual', $3, now())`,
      [ruleset.lenderId, rows[0].v, ruleset],
    );
    console.log(`✓ ${ruleset.lenderId}: v${rows[0].v} active (${ruleset.rules.length} rules)`);
  });
}

await pool.end();