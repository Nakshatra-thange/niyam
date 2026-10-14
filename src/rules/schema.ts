import { z } from "zod";

export const FIELDS = [
  "cibil_score",
  "monthly_income",
  "age",
  "city",
  "employment_type",
  "business_vintage_months",
  "loan_amount",
  "foir", // fixed obligations to income ratio = existing_emi / monthly_income
] as const;
export type Field = (typeof FIELDS)[number];

export const OPERATORS = ["gte", "lte", "eq", "in", "not_in", "between"] as const;
export type Operator = (typeof OPERATORS)[number];

// Where in the policy document a rule came from. Required for agent-extracted
// rules, optional for hand-written ones.
export const CitationSchema = z.object({
  page: z.number().int().positive(),
  quote: z.string().min(3),
});

export const RuleSchema = z
  .object({
    id: z.string().min(1),
    field: z.enum(FIELDS),
    op: z.enum(OPERATORS),
    value: z.union([
      z.number(),
      z.string(),
      z.array(z.string()).min(1),
      z.tuple([z.number(), z.number()]),
    ]),
    message: z.string().min(3), // human-readable, shown when the rule fails
    citation: CitationSchema.optional(),
  })
  .superRefine((r, ctx) => {
    const v = r.value;
    const bad = (msg: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message: msg });
    if ((r.op === "gte" || r.op === "lte") && typeof v !== "number")
      bad(`${r.id}: ${r.op} needs a number`);
    if ((r.op === "in" || r.op === "not_in") && !Array.isArray(v))
      bad(`${r.id}: ${r.op} needs a list`);
    if (r.op === "between") {
      if (!Array.isArray(v) || v.length !== 2 || typeof v[0] !== "number" || typeof v[1] !== "number")
        bad(`${r.id}: between needs [min, max]`);
      else if ((v[0] as number) > (v[1] as number)) bad(`${r.id}: between min > max`);
    }
    if (r.op === "eq" && Array.isArray(v)) bad(`${r.id}: eq needs a single value`);
  });
export type Rule = z.infer<typeof RuleSchema>;

export const LenderRulesetSchema = z.object({
  lenderId: z.string().min(1),
  lenderName: z.string().min(1),
  interestRateMin: z.number().positive(), // annual %, used for ranking
  interestRateMax: z.number().positive(),
  rules: z.array(RuleSchema).min(1),
});
export type LenderRuleset = z.infer<typeof LenderRulesetSchema>;

// What a loan applicant sends us.
export const ApplicantProfileSchema = z.object({
  name: z.string().min(1),
  phone: z.string().regex(/^[6-9]\d{9}$/, "10-digit Indian mobile number"),
  pan: z.string().regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, "valid PAN format"),
  age: z.number().int().min(18).max(80),
  city: z.string().min(1).transform((s) => s.trim().toLowerCase()),
  employment_type: z.enum(["salaried", "self_employed", "business_owner"]),
  monthly_income: z.number().nonnegative(),
  existing_emi: z.number().nonnegative().default(0),
  cibil_score: z.number().int().min(300).max(900).nullable(), // null = new to credit
  business_vintage_months: z.number().int().nonnegative().optional(),
  loan_amount: z.number().positive(),
});
export type ApplicantProfile = z.infer<typeof ApplicantProfileSchema>;