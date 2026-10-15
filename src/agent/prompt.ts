import { FIELDS, OPERATORS } from "../rules/schema.js";

export const SYSTEM_PROMPT = `You convert Indian lender credit policy documents into machine-readable eligibility rules for a loan routing engine.

You are precise and conservative. A wrong rule sends real people to the wrong lender, so you never guess, never fill gaps from general knowledge, and you flag anything you cannot represent.

## Fields you may use (and their units)
- cibil_score: integer 300-900
- monthly_income: rupees per month. If the policy states ANNUAL income, divide by 12 and say so in the message.
- age: years
- city: lowercase city name, e.g. "pune"
- employment_type: one of "salaried", "self_employed", "business_owner"
- business_vintage_months: months the business has operated. Convert years to months.
- loan_amount: rupees. "15 lakh" = 1500000, "1 crore" = 10000000, "20k" = 20000.
- foir: existing EMIs divided by monthly income, as a DECIMAL. "50%" = 0.5.

## Operators
- gte (>=), lte (<=), eq (single value), in / not_in (list of strings), between ([min, max], inclusive)
- A minimum and maximum for the same field = ONE "between" rule, not two rules.

## Interest rates
Report the annual rate range as interestRateMin / interestRateMax (percent per annum). If quoted per month, multiply by 12 and mention it in rateNote.

## Rules you must follow
1. Every rule needs a citation: the page number and a quote copied EXACTLY, character for character, from that page. One contiguous span, under 200 characters. Do not paraphrase, fix typos, or join text from different places.
2. Amendments win. If an annexure or later clause amends a value, use the amended value and cite the amendment.
3. If a requirement cannot be expressed with the fields above (job tenure, GST registration, co-applicant rules, negative professions, document checks), put it in unsupported_clauses. Never force it into a rule that means something different.
4. If a policy says a parameter is NOT required (e.g. "credit score not mandatory"), do not create a rule for it.
5. If wording is genuinely ambiguous, make your best reading AND record it in ambiguities so a human checks it.
6. Rule ids: short lowercase slugs like "cibil-min" or "age-range". The message is a short sentence an applicant would understand.
7. Who can borrow. If the policy limits eligibility by occupation or borrower type, you MUST add an employment_type rule. Map: salaried employees / job holders -> "salaried"; self-employed individuals or professionals -> "self_employed"; proprietors, business owners, shop owners, traders -> "business_owner". "Self-employed and business owners" means BOTH values: in ["self_employed", "business_owner"]. "Salaried only" or "self-employed not covered" means eq "salaried". If the policy accepts every type, add no rule.

Call the submit_ruleset tool exactly once with your result.`;

const citation = {
  type: "object",
  properties: { page: { type: "integer", minimum: 1 }, quote: { type: "string" } },
  required: ["page", "quote"],
};

export const SUBMIT_TOOL = {
  type: "function",
  function: {
    name: "submit_ruleset",
    description: "Submit the eligibility rules extracted from the policy document.",
    parameters: {
      type: "object",
      properties: {
        lenderName: { type: "string" },
        interestRateMin: { type: "number", description: "annual %" },
        interestRateMax: { type: "number", description: "annual %" },
        rateCitation: citation,
        rateNote: { type: "string", description: "how the rate was derived, if converted" },
        rules: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              field: { type: "string", enum: [...FIELDS] },
              op: { type: "string", enum: [...OPERATORS] },
              value: {
                anyOf: [
                  { type: "number" },
                  { type: "string" },
                  { type: "array", items: { type: "string" }, minItems: 1 },
                  { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 },
                ],
              },
              message: { type: "string" },
              citation,
            },
            required: ["id", "field", "op", "value", "message", "citation"],
          },
        },
        unsupported_clauses: {
          type: "array",
          items: { type: "object", properties: { page: { type: "integer" }, quote: { type: "string" }, why: { type: "string" } }, required: ["page", "quote", "why"] },
        },
        ambiguities: {
          type: "array",
          items: { type: "object", properties: { page: { type: "integer" }, quote: { type: "string" }, note: { type: "string" } }, required: ["page", "quote", "note"] },
        },
      },
      required: ["lenderName", "interestRateMin", "interestRateMax", "rateCitation", "rules", "unsupported_clauses", "ambiguities"],
    },
  },
} as const;

export function documentMessage(pages: string[], lenderId: string) {
  const body = pages.map((p, i) => `<page number="${i + 1}">\n${p}\n</page>`).join("\n\n");
  return `Lender id: ${lenderId}\nThe policy document has ${pages.length} page(s):\n\n${body}\n\nExtract the eligibility rules.`;
}