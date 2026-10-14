import type pg from "pg";
import { pool, withTx } from "../db/client.js";
import { evaluateLender } from "../rules/engine.js";
import { ApplicantProfileSchema, LenderRulesetSchema, type LenderRuleset, type Rule } from "../rules/schema.js";
import { checkRulesetCitations } from "../agent/validate.js";
import type { ExtractionReport } from "../agent/extract.js";

/**
 * Ruleset lifecycle:
 *
 *   agent ──> DRAFT ──approve──> ACTIVE ──(next approval)──> RETIRED
 *               │                   ▲                           │
 *               └──reject──> REJECTED └──────── rollback ───────┘
 *
 * Only ACTIVE rules route loans, and at most one per lender (a unique index
 * enforces it). Every transition is recorded in ruleset_events.
 */

export class ReviewError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
  }
}

export type RulesetRow = {
  id: number;
  lender_id: string;
  version: number;
  status: "draft" | "active" | "retired" | "rejected";
  source: "manual" | "agent";
  ruleset: LenderRuleset;
  agent_ruleset: LenderRuleset | null;
  report: any;
  source_document: string | null;
  source_pages: string[] | null;
  created_by: string | null;
  approved_by: string | null;
  review_note: string | null;
  created_at: string;
  approved_at: string | null;
};

const toRow = (r: any): RulesetRow => ({ ...r, id: Number(r.id) });

async function event(c: pg.PoolClient, rulesetId: number, lenderId: string, name: string, actor: string, data: unknown = {}) {
  await c.query(`INSERT INTO ruleset_events (ruleset_id, lender_id, event, actor, data) VALUES ($1, $2, $3, $4, $5)`, [rulesetId, lenderId, name, actor, data]);
}

/** Locks the ruleset AND its lender, so two reviewers can't activate versions of the same lender at once. */
async function lockRuleset(c: pg.PoolClient, id: number): Promise<RulesetRow> {
  const { rows } = await c.query(`SELECT * FROM rulesets WHERE id = $1`, [id]);
  if (!rows[0]) throw new ReviewError(404, `ruleset ${id} not found`);
  await c.query(`SELECT 1 FROM lenders WHERE id = $1 FOR UPDATE`, [rows[0].lender_id]);
  const fresh = await c.query(`SELECT * FROM rulesets WHERE id = $1`, [id]); // re-read after waiting for the lock
  return toRow(fresh.rows[0]);
}

function requireActor(actor: string | undefined): string {
  const a = actor?.trim();
  if (!a) throw new ReviewError(400, "reviewer name is required (x-reviewer header)");
  return a.slice(0, 80);
}

export async function saveDraft(input: {
  lenderId: string;
  ruleset: LenderRuleset;
  report: ExtractionReport;
  sourceDocument: string;
  sourcePages: string[];
  actor: string;
}): Promise<{ id: number; version: number }> {
  return withTx(async (c) => {
    await c.query(`INSERT INTO lenders (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`, [input.lenderId, input.ruleset.lenderName]);
    await c.query(`SELECT 1 FROM lenders WHERE id = $1 FOR UPDATE`, [input.lenderId]); // serialise version numbers
    const { rows } = await c.query(`SELECT COALESCE(MAX(version), 0) + 1 AS v FROM rulesets WHERE lender_id = $1`, [input.lenderId]);
    const r = input.report;
    const ins = await c.query(
      `INSERT INTO rulesets (lender_id, version, status, source, ruleset, agent_ruleset, report, source_document, source_pages, created_by)
       VALUES ($1, $2, 'draft', 'agent', $3, $3, $4, $5, $6, $7) RETURNING id, version`,
      [
        input.lenderId, rows[0].v, input.ruleset,
        { warnings: r.result.warnings, unsupported: r.raw?.unsupported_clauses ?? [], ambiguities: r.raw?.ambiguities ?? [], rateNote: r.raw?.rateNote, rateCitation: r.raw?.rateCitation, attempts: r.attempts, model: r.model, history: r.history, usage: r.usage, durationMs: r.durationMs },
        input.sourceDocument, JSON.stringify(input.sourcePages), input.actor,
      ],
    );
    const id = Number(ins.rows[0].id);
    await event(c, id, input.lenderId, "draft.created", input.actor, { model: r.model, attempts: r.attempts, warnings: r.result.warnings.length });
    return { id, version: ins.rows[0].version };
  });
}

export async function listRulesets() {
  const { rows } = await pool.query(
    `SELECT r.id, r.lender_id, l.name AS lender_name, r.version, r.status, r.source, r.created_at, r.approved_at, r.approved_by, r.created_by,
            jsonb_array_length(r.ruleset->'rules') AS rule_count,
            COALESCE(jsonb_array_length(r.report->'warnings'), 0) AS warning_count
       FROM rulesets r JOIN lenders l ON l.id = r.lender_id
      ORDER BY r.lender_id, r.version DESC`,
  );
  return rows.map((r) => ({ ...r, id: Number(r.id) }));
}

export async function getRuleset(id: number): Promise<RulesetRow | null> {
  const { rows } = await pool.query(`SELECT * FROM rulesets WHERE id = $1`, [id]);
  return rows[0] ? toRow(rows[0]) : null;
}

export async function getActive(lenderId: string): Promise<RulesetRow | null> {
  const { rows } = await pool.query(`SELECT * FROM rulesets WHERE lender_id = $1 AND status = 'active'`, [lenderId]);
  return rows[0] ? toRow(rows[0]) : null;
}

export async function getEvents(lenderId: string) {
  const { rows } = await pool.query(`SELECT ruleset_id, event, actor, data, created_at FROM ruleset_events WHERE lender_id = $1 ORDER BY id DESC LIMIT 50`, [lenderId]);
  return rows.map((r) => ({ ...r, ruleset_id: Number(r.ruleset_id) }));
}

// ---------------------------------------------------------------- diff

type RuleView = Pick<Rule, "id" | "field" | "op" | "value" | "message">;
export type RulesetDiff = {
  added: RuleView[];
  removed: RuleView[];
  changed: { before: RuleView; after: RuleView }[]; // the value changed: affects who qualifies
  reworded: { before: RuleView; after: RuleView }[]; // only the message changed: cosmetic
  rate: { before: [number, number]; after: [number, number] } | null;
  hasChanges: boolean;
};

const ruleKey = (r: Rule) => `${r.field}:${r.op}`;
const view = (r: Rule): RuleView => ({ id: r.id, field: r.field, op: r.op, value: r.value, message: r.message });

/** Rules are matched by field + operator (the validator guarantees that's unique per ruleset). */
export function diffRulesets(before: LenderRuleset | null, after: LenderRuleset): RulesetDiff {
  const b = new Map((before?.rules ?? []).map((r) => [ruleKey(r), r]));
  const a = new Map(after.rules.map((r) => [ruleKey(r), r]));
  const added = [...a].filter(([k]) => !b.has(k)).map(([, r]) => view(r));
  const removed = [...b].filter(([k]) => !a.has(k)).map(([, r]) => view(r));
  const both = [...a].filter(([k]) => b.has(k)).map(([k, r]) => ({ before: b.get(k)!, after: r }));
  const sameValue = (x: { before: Rule; after: Rule }) => JSON.stringify(x.before.value) === JSON.stringify(x.after.value);
  const changed = both.filter((x) => !sameValue(x)).map((x) => ({ before: view(x.before), after: view(x.after) }));
  const reworded = both.filter((x) => sameValue(x) && x.before.message !== x.after.message).map((x) => ({ before: view(x.before), after: view(x.after) }));
  const rate =
    before && (before.interestRateMin !== after.interestRateMin || before.interestRateMax !== after.interestRateMax)
      ? { before: [before.interestRateMin, before.interestRateMax] as [number, number], after: [after.interestRateMin, after.interestRateMax] as [number, number] }
      : null;
  return { added, removed, changed, reworded, rate, hasChanges: added.length + removed.length + changed.length + reworded.length > 0 || rate !== null };
}

// ---------------------------------------------------------------- impact

/**
 * "If I approve this, what happens?" Replays recent applicants against the
 * currently active rules and against this version, and reports who would
 * gain or lose eligibility for this lender. No PII leaves this function.
 */
export async function impactOf(id: number, sampleSize = 500) {
  const row = await getRuleset(id);
  if (!row) throw new ReviewError(404, `ruleset ${id} not found`);
  const candidate = LenderRulesetSchema.parse(row.ruleset);
  const activeRow = await getActive(row.lender_id);
  // Compare against what's live now. Viewing the live version itself = no change.
  const baseline = activeRow ? LenderRulesetSchema.parse(activeRow.ruleset) : null;

  const { rows } = await pool.query(`SELECT profile FROM applications ORDER BY created_at DESC LIMIT $1`, [sampleSize]);
  let sampled = 0, eligibleBefore = 0, eligibleAfter = 0, gained = 0, lost = 0;
  const examples: { gained: unknown[]; lost: unknown[] } = { gained: [], lost: [] };

  for (const r of rows) {
    const p = ApplicantProfileSchema.safeParse(r.profile);
    if (!p.success) continue;
    sampled++;
    const was = baseline ? evaluateLender(baseline, p.data).eligible : false;
    const now = evaluateLender(candidate, p.data);
    if (was) eligibleBefore++;
    if (now.eligible) eligibleAfter++;

    const summary = { city: p.data.city, cibil: p.data.cibil_score, income: p.data.monthly_income, employment: p.data.employment_type, amount: p.data.loan_amount };
    if (!was && now.eligible) {
      gained++;
      if (examples.gained.length < 5) examples.gained.push(summary);
    }
    if (was && !now.eligible) {
      lost++;
      if (examples.lost.length < 5) examples.lost.push({ ...summary, why: now.reasons });
    }
  }

  return {
    sampled,
    comparedTo: activeRow ? { id: activeRow.id, version: activeRow.version } : null,
    eligibleBefore,
    eligibleAfter,
    gained,
    lost,
    examples,
  };
}

// ---------------------------------------------------------------- transitions

export async function approve(input: { id: number; actor?: string; edited?: unknown; note?: string }) {
  const actor = requireActor(input.actor);
  return withTx(async (c) => {
    const row = await lockRuleset(c, input.id);
    if (row.status !== "draft") throw new ReviewError(409, `ruleset is ${row.status}; only drafts can be approved`);

    let final = LenderRulesetSchema.parse(row.ruleset);
    let edits: RulesetDiff | null = null;
    let citationWarnings: string[] = [];

    if (input.edited !== undefined && input.edited !== null) {
      const parsed = LenderRulesetSchema.safeParse(input.edited);
      if (!parsed.success) throw new ReviewError(400, "edited ruleset is invalid", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
      if (parsed.data.lenderId !== row.lender_id) throw new ReviewError(400, "edited ruleset belongs to a different lender");
      const cites = checkRulesetCitations(parsed.data.rules, row.source_pages ?? []);
      if (cites.errors.length) throw new ReviewError(400, "edited ruleset has citations that are not in the source document", cites.errors);
      citationWarnings = cites.warnings;
      edits = diffRulesets(final, parsed.data);
      final = parsed.data;
    }

    const previous = await c.query(
      `UPDATE rulesets SET status = 'retired' WHERE lender_id = $1 AND status = 'active' RETURNING id, version`,
      [row.lender_id],
    );
    await c.query(
      `UPDATE rulesets SET status = 'active', ruleset = $2, approved_at = now(), approved_by = $3, review_note = $4 WHERE id = $1`,
      [row.id, final, actor, input.note ?? null],
    );
    const replaced = previous.rows[0] ? { id: Number(previous.rows[0].id), version: previous.rows[0].version } : null;
    const humanEdited = !!edits?.hasChanges;
    await event(c, row.id, row.lender_id, "approved", actor, { note: input.note, replaced, humanEdited, edits: humanEdited ? edits : undefined, citationWarnings });
    if (replaced) await event(c, replaced.id, row.lender_id, "retired", actor, { replacedBy: row.id });

    return { id: row.id, lenderId: row.lender_id, version: row.version, replaced, humanEdited, edits: humanEdited ? edits : null };
  });
}

export async function reject(input: { id: number; actor?: string; reason?: string }) {
  const actor = requireActor(input.actor);
  const reason = input.reason?.trim();
  if (!reason) throw new ReviewError(400, "a reason is required to reject");
  return withTx(async (c) => {
    const row = await lockRuleset(c, input.id);
    if (row.status !== "draft") throw new ReviewError(409, `ruleset is ${row.status}; only drafts can be rejected`);
    await c.query(`UPDATE rulesets SET status = 'rejected', review_note = $2 WHERE id = $1`, [row.id, reason]);
    await event(c, row.id, row.lender_id, "rejected", actor, { reason });
    return { id: row.id, status: "rejected" as const };
  });
}

/** Rollback: re-activate a previously retired version. */
export async function rollback(input: { id: number; actor?: string; note?: string }) {
  const actor = requireActor(input.actor);
  return withTx(async (c) => {
    const row = await lockRuleset(c, input.id);
    if (row.status !== "retired") throw new ReviewError(409, `ruleset is ${row.status}; only retired versions can be rolled back to`);
    const previous = await c.query(`UPDATE rulesets SET status = 'retired' WHERE lender_id = $1 AND status = 'active' RETURNING id, version`, [row.lender_id]);
    await c.query(`UPDATE rulesets SET status = 'active' WHERE id = $1`, [row.id]);
    const replaced = previous.rows[0] ? { id: Number(previous.rows[0].id), version: previous.rows[0].version } : null;
    await event(c, row.id, row.lender_id, "rolled_back_to", actor, { note: input.note, replaced });
    if (replaced) await event(c, replaced.id, row.lender_id, "retired", actor, { rolledBackTo: row.id });
    return { id: row.id, lenderId: row.lender_id, version: row.version, replaced };
  });
}