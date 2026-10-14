import type { LenderRuleset, Rule } from "../rules/schema.js";

/**
 * Compares agent-extracted rules with known-correct rules. This is the core
 * of the Day 6 eval harness; on Day 4 it's a quick sanity check in the CLI.
 */
export type RuleComparison = {
  matched: string[];
  wrong: { field: string; expected: string; got: string }[];
  missing: string[];
  extra: string[];
  score: number; // matched / expected
};

const show = (r: Rule) => `${r.field} ${r.op} ${JSON.stringify(r.value)}`;
const sameValue = (a: Rule["value"], b: Rule["value"]) => {
  const norm = (v: Rule["value"]) => (Array.isArray(v) ? [...v].map((x) => (typeof x === "string" ? x.toLowerCase() : x)).sort() : typeof v === "string" ? v.toLowerCase() : v);
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
};

export function compareRulesets(expected: LenderRuleset, got: LenderRuleset): RuleComparison {
  const out: RuleComparison = { matched: [], wrong: [], missing: [], extra: [], score: 0 };
  const used = new Set<Rule>();

  for (const e of expected.rules) {
    const sameField = got.rules.filter((g) => g.field === e.field && !used.has(g));
    const exact = sameField.find((g) => g.op === e.op && sameValue(g.value, e.value));
    if (exact) { used.add(exact); out.matched.push(show(e)); continue; }
    if (sameField[0]) { used.add(sameField[0]); out.wrong.push({ field: e.field, expected: show(e), got: show(sameField[0]) }); continue; }
    out.missing.push(show(e));
  }
  out.extra = got.rules.filter((g) => !used.has(g)).map(show);
  out.score = expected.rules.length ? Math.round((out.matched.length / expected.rules.length) * 100) / 100 : 0;
  return out;
}