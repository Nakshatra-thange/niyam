import { z } from "zod";
import { CitationSchema, LenderRulesetSchema, RuleSchema, type Field, type LenderRuleset } from "../rules/schema.js";

/**
 * The agent's output is untrusted until it passes these checks.
 *   errors   -> sent back to the model to fix (it gets up to 2 retries)
 *   warnings -> shown to the human reviewer, never auto-fixed
 */

export const ExtractionSchema = z.object({
  lenderName: z.string().min(1),
  interestRateMin: z.number(),
  interestRateMax: z.number(),
  rateCitation: CitationSchema,
  rateNote: z.string().optional(),
  rules: z.array(z.unknown()),
  unsupported_clauses: z.array(z.object({ page: z.number(), quote: z.string(), why: z.string() })),
  ambiguities: z.array(z.object({ page: z.number(), quote: z.string(), note: z.string() })),
});
export type Extraction = z.infer<typeof ExtractionSchema>;

export type ValidationResult = {
  ok: boolean;
  errors: string[];
  warnings: string[];
  ruleset?: LenderRuleset;
};

// Plausible ranges. A value outside these is almost certainly a unit mistake
// (50 instead of 0.5 for FOIR, lakh vs rupees, months vs years).
const BOUNDS: Partial<Record<Field, [number, number]>> = {
  cibil_score: [300, 900],
  monthly_income: [1_000, 1_000_000],
  age: [18, 80],
  business_vintage_months: [0, 600],
  loan_amount: [1_000, 100_000_000],
  foir: [0.05, 1],
};

/** Lowercase, collapse whitespace, unify quotes and dashes: PDF text is messy. */
export const normalize = (s: string) =>
  s.toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/[\u2013\u2014]/g, "-").replace(/\s+/g, " ").trim();

/** Every number a quote could reasonably mean: "Rs. 3,60,000 per annum" -> 360000, 30000 (monthly), ... */
export function numbersIn(quote: string): number[] {
  const out = new Set<number>();
  const re = /(\d[\d,]*(?:\.\d+)?)\s*(lakhs?|lacs?|crores?|cr\b|k\b|%)?/gi;
  for (const m of quote.matchAll(re)) {
    const n = Number(m[1].replace(/,/g, ""));
    if (!Number.isFinite(n)) continue;
    const unit = (m[2] ?? "").toLowerCase();
    let v = n;
    if (unit.startsWith("lakh") || unit.startsWith("lac")) v = n * 1e5;
    else if (unit.startsWith("cr")) v = n * 1e7;
    else if (unit === "k") v = n * 1e3;
    for (const x of [v, v / 12, v * 12, v / 100, n * 12]) out.add(Math.round(x * 10000) / 10000);
    if (unit === "%") out.add(n / 100);
  }
  return [...out];
}

const ANNUAL = /\b(annual|annually|per annum|p\.\s?a\.?|yearly|a year|per year)\b/i;

/** Numbers exactly as written (with lakh/k/crore applied), no unit conversions. */
function rawNumbersIn(quote: string): number[] {
  return [...quote.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*(lakhs?|lacs?|crores?|cr\b|k\b)?/gi)].map((m) => {
    const n = Number(m[1].replace(/,/g, ""));
    const u = (m[2] ?? "").toLowerCase();
    return u.startsWith("lakh") || u.startsWith("lac") ? n * 1e5 : u.startsWith("cr") ? n * 1e7 : u === "k" ? n * 1e3 : n;
  });
}

const grounded = (value: number, quote: string) => numbersIn(quote).some((n) => Math.abs(n - value) <= Math.max(0.01 * Math.abs(value), 0.001));

function quoteIsOnPage(quote: string, pages: string[], page: number): "yes" | "other_page" | "no" {
  const q = normalize(quote);
  if (pages[page - 1] && normalize(pages[page - 1]).includes(q)) return "yes";
  return pages.some((p) => normalize(p).includes(q)) ? "other_page" : "no";
}

export function validateExtraction(raw: unknown, pages: string[], lenderId: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const top = ExtractionSchema.safeParse(raw);
  if (!top.success) {
    return { ok: false, errors: top.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`), warnings };
  }
  const ex = top.data;

  const checkCitation = (label: string, c: { page: number; quote: string } | undefined) => {
    if (!c) return errors.push(`${label}: missing citation`);
    if (c.page < 1 || c.page > pages.length) return errors.push(`${label}: page ${c.page} does not exist (document has ${pages.length})`);
    const where = quoteIsOnPage(c.quote, pages, c.page);
    if (where === "other_page") errors.push(`${label}: quote exists but NOT on page ${c.page}. Fix the page number.`);
    if (where === "no") errors.push(`${label}: quote "${c.quote.slice(0, 80)}" not found in the document. Copy it exactly.`);
  };

  // Rules: schema, citation, bounds, grounding.
  const rules = [];
  const seenIds = new Set<string>();
  for (const [i, r] of ex.rules.entries()) {
    const parsed = RuleSchema.safeParse(r);
    const label = `rule[${i}]${(r as any)?.id ? ` (${(r as any).id})` : ""}`;
    if (!parsed.success) {
      parsed.error.issues.forEach((iss) => errors.push(`${label}: ${iss.path.join(".") || "rule"}: ${iss.message}`));
      continue;
    }
    const rule = parsed.data;
    if (seenIds.has(rule.id)) errors.push(`${label}: duplicate rule id`);
    seenIds.add(rule.id);
    checkCitation(label, rule.citation);

    const nums = typeof rule.value === "number" ? [rule.value] : Array.isArray(rule.value) && typeof rule.value[0] === "number" ? (rule.value as number[]) : [];
    const bounds = BOUNDS[rule.field];
    for (const n of nums) {
      if (bounds && (n < bounds[0] || n > bounds[1])) errors.push(`${label}: ${rule.field} value ${n} is outside the plausible range ${bounds[0]}–${bounds[1]}. Check units.`);
      // A plausible-looking monthly income can still be an un-converted annual figure.
      if (rule.field === "monthly_income" && rule.citation && ANNUAL.test(rule.citation.quote) && rawNumbersIn(rule.citation.quote).includes(n))
        errors.push(`${label}: the quote states an ANNUAL figure but ${n} was used as monthly_income unchanged. Divide by 12.`);
      if (rule.citation && !grounded(n, rule.citation.quote)) warnings.push(`${label}: value ${n} does not visibly appear in its quote ("${rule.citation.quote.slice(0, 60)}"). Verify the conversion.`);
    }
    rules.push(rule);
  }

  // Two rules testing the same field the same way usually means an amendment was double-counted.
  const byFieldOp = new Map<string, string[]>();
  rules.forEach((r) => byFieldOp.set(`${r.field}:${r.op}`, [...(byFieldOp.get(`${r.field}:${r.op}`) ?? []), r.id]));
  for (const [k, ids] of byFieldOp) if (ids.length > 1) errors.push(`rules ${ids.join(", ")} all test ${k.replace(":", " ")}. Keep one (the latest amendment) or merge into a between rule.`);

  // Rates.
  checkCitation("rateCitation", ex.rateCitation);
  if (ex.interestRateMin > ex.interestRateMax) errors.push(`interestRateMin (${ex.interestRateMin}) is greater than interestRateMax (${ex.interestRateMax})`);
  if (ex.interestRateMin < 5 || ex.interestRateMax > 60) errors.push(`interest rate ${ex.interestRateMin}–${ex.interestRateMax}% looks wrong. Annual % expected.`);

  if (rules.length === 0) errors.push("no rules extracted");
  ex.unsupported_clauses.forEach((u) => warnings.push(`needs human: clause not representable (p${u.page}): "${u.quote.slice(0, 80)}" — ${u.why}`));
  ex.ambiguities.forEach((a) => warnings.push(`ambiguous (p${a.page}): "${a.quote.slice(0, 80)}" — ${a.note}`));

  if (errors.length) return { ok: false, errors, warnings };

  const ruleset = LenderRulesetSchema.safeParse({
    lenderId, lenderName: ex.lenderName, interestRateMin: ex.interestRateMin, interestRateMax: ex.interestRateMax, rules,
  });
  if (!ruleset.success) return { ok: false, errors: ruleset.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`), warnings };
  return { ok: true, errors, warnings, ruleset: ruleset.data };
}


/**
 * Re-checks citations on a ruleset a human has edited. A reviewer may change a
 * value, but must not leave a rule pointing at text that isn't in the document.
 * Rules without a citation are allowed (a human added them) but flagged.
 */
export function checkRulesetCitations(rules: LenderRuleset["rules"], pages: string[]): { errors: string[]; warnings: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];
    for (const r of rules) {
      if (!r.citation) {
        warnings.push(`${r.id}: no citation (added by a human reviewer)`);
        continue;
      }
      if (pages.length === 0) continue; // hand-written ruleset: no source document to check against
      const where = quoteIsOnPage(r.citation.quote, pages, r.citation.page);
      if (where === "other_page") errors.push(`${r.id}: quote is not on page ${r.citation.page}`);
      if (where === "no") errors.push(`${r.id}: quote "${r.citation.quote.slice(0, 60)}" is not in the source document`);
    }
    return { errors, warnings };
  }