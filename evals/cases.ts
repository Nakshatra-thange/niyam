import { SEED_RULESETS } from "../src/rules/seed-rules.js";
import { ApplicantProfileSchema, type LenderRuleset, type Rule } from "../src/rules/schema.js";
const EMPLOYMENT_TYPES: string[] = [...ApplicantProfileSchema.shape.employment_type.options];

export type Trap = { name: string; check: (rs: LenderRuleset) => boolean };
export type EvalCase = {
  lenderId: string;
  file: string;
  expected: LenderRuleset;
  traps: Trap[];
  /** Extra rules on these fields are a defensible reading, so they don't count against precision. */
  tolerateExtraOn?: Rule["field"][];
};

/** Canonical form so equivalent rules compare equal: eq X == in [X], lists are order/case-insensitive. */
export function canonical(r: Pick<Rule, "field" | "op" | "value">): string {
  let op = r.op;
  let value: unknown = r.value;
  if (op === "eq") { op = "in"; value = [value]; }
    // employment_type is a closed set, so "not self-employed or business owner" == "salaried".
    if (r.field === "employment_type" && op === "not_in") {
      const excluded = (value as string[]).map((s) => s.trim().toLowerCase());
      op = "in";
      value = EMPLOYMENT_TYPES.filter((e) => !excluded.includes(e));
    }
  if (Array.isArray(value) && typeof value[0] === "string") value = (value as string[]).map((s) => s.trim().toLowerCase()).sort();
  return `${r.field}|${op}|${JSON.stringify(value)}`;
}

const seed = (id: string) => SEED_RULESETS.find((s) => s.lenderId === id)!;
const has = (field: Rule["field"], op: Rule["op"], value: Rule["value"]) => (rs: LenderRuleset) =>
  rs.rules.some((r) => canonical(r) === canonical({ field, op, value }));
const hasNo = (field: Rule["field"]) => (rs: LenderRuleset) => !rs.rules.some((r) => r.field === field);
const rate = (min: number, max: number) => (rs: LenderRuleset) => Math.abs(rs.interestRateMin - min) < 0.01 && Math.abs(rs.interestRateMax - max) < 0.01;

const METRO_V2: LenderRuleset = {
  lenderId: "metro-bank",
  lenderName: "Metro Small Finance Bank",
  interestRateMin: 10.75,
  interestRateMax: 16.5,
  rules: [
    { id: "city", field: "city", op: "in", value: ["mumbai", "delhi", "bengaluru", "hyderabad", "pune", "chennai", "indore", "ahmedabad", "jaipur"], message: "-" },
    { id: "cibil", field: "cibil_score", op: "gte", value: 750, message: "-" },
    { id: "income", field: "monthly_income", op: "gte", value: 40000, message: "-" },
    { id: "foir", field: "foir", op: "lte", value: 0.45, message: "-" },
    { id: "amount", field: "loan_amount", op: "between", value: [100000, 2500000], message: "-" },
  ],
};

export const CASES: EvalCase[] = [
  {
    lenderId: "suvidha",
    file: "policies/suvidha.pdf",
    expected: seed("suvidha"),
    traps: [
      { name: "applies the annexure amendment (CIBIL 750, not 720)", check: (rs) => has("cibil_score", "gte", 750)(rs) && !has("cibil_score", "gte", 720)(rs) },
      { name: "annual ₹3,60,000 → ₹30,000/month", check: has("monthly_income", "gte", 30000) },
      { name: "FOIR 50% → 0.5", check: has("foir", "lte", 0.5) },
    ],
  },
  {
    lenderId: "dhanrekha",
    file: "policies/dhanrekha.pdf",
    expected: seed("dhanrekha"),
    tolerateExtraOn: ["employment_type"], // "salaried as well as self-employed" is a fair rule to add
    traps: [
      { name: "Hinglish '23 se 60 saal' → age 23–60", check: has("age", "between", [23, 60]) },
      { name: "'Rs. 20k per month' → 20000", check: has("monthly_income", "gte", 20000) },
      { name: "'8 lakh', no minimum → loan ≤ 800000", check: has("loan_amount", "lte", 800000) },
    ],
  },
  {
    lenderId: "kirana-credit",
    file: "policies/kirana-credit.pdf",
    expected: seed("kirana-credit"),
    traps: [
      { name: "monthly interest 1.5–2.5% → 18–30% p.a.", check: rate(18, 30) },
      { name: "'score not mandatory' → no CIBIL rule", check: hasNo("cibil_score") },
      { name: "reads the table: loan ₹10,000–₹3,00,000", check: has("loan_amount", "between", [10000, 300000]) },
    ],
  },
  {
    lenderId: "metro-bank",
    file: "policies/metro-bank.pdf",
    expected: seed("metro-bank"),
    traps: [
      { name: "all six metro cities", check: has("city", "in", ["mumbai", "delhi", "bengaluru", "hyderabad", "pune", "chennai"]) },
      { name: "FOIR 40% → 0.4", check: has("foir", "lte", 0.4) },
    ],
  },
  {
    lenderId: "pragati",
    file: "policies/pragati.pdf",
    expected: seed("pragati"),
    traps: [
      { name: "annual household ₹1,20,000 → ₹10,000/month", check: has("monthly_income", "gte", 10000) },
      { name: "'not offered in Mumbai or Delhi' → not_in", check: has("city", "not_in", ["mumbai", "delhi"]) },
      { name: "states (MP, MH…) are not invented as cities", check: (rs) => !rs.rules.some((r) => r.field === "city" && r.op === "in") },
    ],
  },
  {
    lenderId: "metro-bank",
    file: "policies/metro-bank-v2.pdf",
    expected: METRO_V2,
    traps: [
      { name: "new Tier-2 cities included (9 total)", check: has("city", "in", METRO_V2.rules[0].value) },
      { name: "uses revised CIBIL 750, not old 780", check: (rs) => has("cibil_score", "gte", 750)(rs) && !has("cibil_score", "gte", 780)(rs) },
      { name: "rate 10.75–16.5%", check: rate(10.75, 16.5) },
    ],
  },
];