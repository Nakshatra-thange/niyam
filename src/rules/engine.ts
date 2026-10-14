import type { ApplicantProfile, Field, LenderRuleset, Rule } from "./schema.js";

export type RuleResult = {
  ruleId: string;
  field: Field;
  passed: boolean;
  actual: unknown;
  expected: unknown;
  message: string;
  citation?: Rule["citation"];
};

export type LenderDecision = {
  lenderId: string;
  lenderName: string;
  eligible: boolean;
  interestRateMin: number;
  interestRateMax: number;
  headroom: number; // 0..1, how comfortably the applicant clears numeric rules
  reasons: string[]; // plain-English, one per failed rule (or a success summary)
  results: RuleResult[];
};

export type RoutingResult = {
  eligible: LenderDecision[]; // ranked best first
  ineligible: LenderDecision[];
};

/** Turns the profile into the flat field map the rules test against. */
export function deriveFields(p: ApplicantProfile): Record<Field, unknown> {
  return {
    cibil_score: p.cibil_score,
    monthly_income: p.monthly_income,
    age: p.age,
    city: p.city,
    employment_type: p.employment_type,
    business_vintage_months: p.business_vintage_months ?? null,
    loan_amount: p.loan_amount,
    foir: p.monthly_income > 0 ? round(p.existing_emi / p.monthly_income, 4) : null,
  };
}

const norm = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase() : v);

export function evaluateRule(rule: Rule, fields: Record<Field, unknown>): RuleResult {
  const actual = fields[rule.field];
  const base = { ruleId: rule.id, field: rule.field, actual, expected: rule.value, message: rule.message, citation: rule.citation };

  // Missing data fails closed: we never approve on data we don't have.
  if (actual === null || actual === undefined) return { ...base, passed: false };

  let passed = false;
  switch (rule.op) {
    case "gte":
      passed = typeof actual === "number" && actual >= (rule.value as number);
      break;
    case "lte":
      passed = typeof actual === "number" && actual <= (rule.value as number);
      break;
    case "eq":
      passed = norm(actual) === norm(rule.value);
      break;
    case "in":
      passed = (rule.value as string[]).map(norm).includes(norm(actual));
      break;
    case "not_in":
      passed = !(rule.value as string[]).map(norm).includes(norm(actual));
      break;
    case "between": {
      const [min, max] = rule.value as [number, number];
      passed = typeof actual === "number" && actual >= min && actual <= max;
      break;
    }
  }
  return { ...base, passed };
}

/**
 * Headroom: for each passed numeric threshold, how far above/below the line
 * the applicant is, capped at 1. Averaged. An applicant at CIBIL 800 vs a
 * 700 cutoff has more headroom than one at 705 — and is likelier to be approved.
 */
function headroomOf(rules: Rule[], results: RuleResult[]): number {
  const margins: number[] = [];
  results.forEach((r, i) => {
    const rule = rules[i];
    if (!r.passed || typeof r.actual !== "number") return;
    if (rule.op === "gte" && typeof rule.value === "number" && rule.value > 0)
      margins.push(Math.min((r.actual - rule.value) / rule.value, 1));
    if (rule.op === "lte" && typeof rule.value === "number" && rule.value > 0)
      margins.push(Math.min((rule.value - r.actual) / rule.value, 1));
  });
  if (margins.length === 0) return 0.5;
  return round(margins.reduce((a, b) => a + b, 0) / margins.length, 3);
}

function describeFailure(r: RuleResult): string {
  const actual = r.actual === null || r.actual === undefined ? "not provided" : String(r.actual);
  return `${r.message} (you: ${actual})`;
}

export function evaluateLender(ruleset: LenderRuleset, profile: ApplicantProfile): LenderDecision {
  const fields = deriveFields(profile);
  const results = ruleset.rules.map((rule) => evaluateRule(rule, fields));
  const failed = results.filter((r) => !r.passed);
  const eligible = failed.length === 0;

  return {
    lenderId: ruleset.lenderId,
    lenderName: ruleset.lenderName,
    eligible,
    interestRateMin: ruleset.interestRateMin,
    interestRateMax: ruleset.interestRateMax,
    headroom: eligible ? headroomOf(ruleset.rules, results) : 0,
    reasons: eligible
      ? [`Meets all ${results.length} criteria for ${ruleset.lenderName}`]
      : failed.map(describeFailure),
    results,
  };
}

/**
 * Ranks eligible lenders: cheapest rate first, then most headroom.
 * Deterministic, so the same input always gives the same order (important
 * for audits and for idempotent retries).
 */
export function route(rulesets: LenderRuleset[], profile: ApplicantProfile): RoutingResult {
  const decisions = rulesets.map((rs) => evaluateLender(rs, profile));
  const eligible = decisions
    .filter((d) => d.eligible)
    .sort(
      (a, b) =>
        a.interestRateMin - b.interestRateMin ||
        b.headroom - a.headroom ||
        a.lenderId.localeCompare(b.lenderId),
    );
  const ineligible = decisions.filter((d) => !d.eligible).sort((a, b) => a.lenderId.localeCompare(b.lenderId));
  return { eligible, ineligible };
}

function round(n: number, dp: number) {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}