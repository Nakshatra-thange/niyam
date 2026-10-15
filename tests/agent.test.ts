import { describe, expect, it } from "vitest";
import { extractPages } from "../src/agent/pdf.js";
import { extractRuleset } from "../src/agent/extract.js";
import type { ChatMessage, Model } from "../src/agent/model.js";
import { numbersIn, validateExtraction } from "../src/agent/validate.js";
import { compareRulesets } from "../src/agent/compare.js";
import { SEED_RULESETS } from "../src/rules/seed-rules.js";

// Tests run against the real generated PDF (npm run policies:pdf),
// so they also prove quote-matching survives PDF line wrapping.
const pages = await extractPages("policies/suvidha.pdf");

const cite = (page: number, quote: string) => ({ page, quote });

/** What a correct model answer for suvidha.pdf looks like. */
const goodExtraction = () => ({
  lenderName: "Suvidha Finance",
  interestRateMin: 11.5,
  interestRateMax: 18,
  rateCitation: cite(2, "Rate of interest: 11.50% to 18.00% per annum"),
  rules: [
    { id: "cibil-min", field: "cibil_score", op: "gte", value: 750, message: "Requires a CIBIL score of 750 or above", citation: cite(2, "the minimum CIBIL score is revised to 750") },
    { id: "income-min", field: "monthly_income", op: "gte", value: 30000, message: "Requires monthly income of at least Rs. 30,000 (Rs. 3.6 lakh a year)", citation: cite(1, "Minimum net annual income of Rs. 3,60,000") },
    { id: "salaried-only", field: "employment_type", op: "eq", value: "salaried", message: "Salaried applicants only", citation: cite(1, "Self-employed individuals and business owners are not covered under this policy") },
    { id: "age-range", field: "age", op: "between", value: [21, 58], message: "Age must be between 21 and 58", citation: cite(1, "Minimum age of the applicant shall be 21 years. Maximum age shall be 58 years") },
    { id: "foir-max", field: "foir", op: "lte", value: 0.5, message: "Existing EMIs at most 50% of income", citation: cite(2, "shall not exceed 50% of net monthly income") },
    { id: "amount-range", field: "loan_amount", op: "between", value: [50000, 1500000], message: "Loan amount Rs. 50,000 to Rs. 15 lakh", citation: cite(2, "minimum Rs. 50,000 and maximum Rs. 15 lakh") },
  ],
  unsupported_clauses: [{ page: 1, quote: "Minimum continuous employment of 1 year with the current employer is required", why: "job tenure is not a supported field" }],
  ambiguities: [],
});

/** A fake model: returns scripted tool calls, one per call, and records what it was sent. */
function fakeModel(answers: unknown[]) {
  const calls: ChatMessage[][] = [];
  const model: Model = {
    name: "fake",
    call: async (messages) => {
      calls.push(structuredClone(messages));
      const input = answers[Math.min(calls.length - 1, answers.length - 1)];
      return {
        message: { role: "assistant", content: null, tool_calls: [{ id: `call_${calls.length}`, type: "function", function: { name: "submit_ruleset", arguments: JSON.stringify(input) } }] },
        usage: { promptTokens: 1000, completionTokens: 500, cost: 0.01 },
      };
    },
  };
  return { model, calls };
}

describe("validator", () => {
  it("accepts a correct extraction from the real PDF", () => {
    const v = validateExtraction(goodExtraction(), pages, "suvidha");
    expect(v.errors).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.warnings.some((w) => w.startsWith("needs human"))).toBe(true); // unsupported clause surfaced
  });

  it("catches a hallucinated quote", () => {
    const ex = goodExtraction();
    ex.rules[0].citation = cite(1, "CIBIL of 750 is mandatory for all customers");
    expect(validateExtraction(ex, pages, "suvidha").errors.join()).toContain("not found in the document");
  });

  it("catches a right quote on the wrong page", () => {
    const ex = goodExtraction();
    ex.rules[4].citation.page = 1;
    expect(validateExtraction(ex, pages, "suvidha").errors.join()).toContain("NOT on page 1");
  });

  it("catches unit mistakes: annual income as monthly, FOIR as 50", () => {
    const ex = goodExtraction();
    ex.rules[1].value = 360000;
    ex.rules[4].value = 50;
    const errs = validateExtraction(ex, pages, "suvidha").errors.join("\n");
    expect(errs).toContain("ANNUAL figure but 360000 was used as monthly_income");
    expect(errs).toContain("foir value 50 is outside");
  });

  it("catches the un-applied amendment (720 AND 750)", () => {
    const ex = goodExtraction();
    ex.rules.push({ id: "cibil-old", field: "cibil_score", op: "gte", value: 720, message: "CIBIL 720+", citation: cite(1, "Applicants must have a CIBIL score of 720 or above") });
    expect(validateExtraction(ex, pages, "suvidha").errors.join()).toContain("all test cibil_score gte");
  });
  it("warns the reviewer when the policy restricts employment but no rule does (the real gpt-4o-mini miss)", () => {
    const ex = goodExtraction();
    ex.rules = ex.rules.filter((r) => r.field !== "employment_type");
    const v = validateExtraction(ex, pages, "suvidha");
    expect(v.ok).toBe(true); // not an error: sometimes leaving it out is right
    expect(v.warnings.join()).toContain("mentions employment type but no rule uses it");
  });

  it("a complete extraction triggers no coverage warnings", () => {
    expect(validateExtraction(goodExtraction(), pages, "suvidha").warnings.filter((w) => w.startsWith("coverage"))).toEqual([]);
  });

  it("warns when a number doesn't appear in its own quote", () => {
    const ex = goodExtraction();
    ex.rules[5].value = [50000, 1000000];
    expect(validateExtraction(ex, pages, "suvidha").warnings.join()).toContain("1000000 does not visibly appear");
  });

  it("rejects a split min/max and asks for one between rule", () => {
    const ex = goodExtraction();
    ex.rules.splice(3, 1,
      { id: "age-min", field: "age", op: "gte", value: 21, message: "21+", citation: cite(1, "Minimum age of the applicant shall be 21 years") },
      { id: "age-max", field: "age", op: "lte", value: 58, message: "58 max", citation: cite(1, "Maximum age shall be 58 years") } as any);
    const errs = validateExtraction(ex, pages, "suvidha").errors.join();
    expect(errs).toContain('Merge them into ONE rule: op "between", value [21, 58]');
  });

  it("understands Indian number formats", () => {
    expect(numbersIn("Rs. 15 lakh")).toContain(1500000);
    expect(numbersIn("Rs. 3,60,000 per annum")).toContain(30000);
    expect(numbersIn("Rs. 20k per month")).toContain(20000);
    expect(numbersIn("FOIR cap of 50%")).toContain(0.5);
    expect(numbersIn("2.5% per month")).toContain(30);
  });
});

describe("agent loop", () => {
  it("passes first time when the model is right, and matches the hand-written rules 100%", async () => {
    const { model, calls } = fakeModel([goodExtraction()]);
    const report = await extractRuleset({ pages, lenderId: "suvidha", model });
    expect(report.ok).toBe(true);
    expect(report.attempts).toBe(1);
    expect(calls).toHaveLength(1);
    expect(report.usage.cost).toBeCloseTo(0.01);
    const cmp = compareRulesets(SEED_RULESETS.find((s) => s.lenderId === "suvidha")!, report.result.ruleset!);
    expect(cmp.score).toBe(1);
  });

  it("feeds validation errors back as a tool message and accepts the corrected answer", async () => {
    const bad = goodExtraction();
    bad.rules[1].value = 360000; // forgot to convert annual -> monthly
    const { model, calls } = fakeModel([bad, goodExtraction()]);
    const report = await extractRuleset({ pages, lenderId: "suvidha", model });

    expect(report.ok).toBe(true);
    expect(report.attempts).toBe(2);
    expect(report.usage.cost).toBeCloseTo(0.02);
    // Second request = system, user, assistant(tool_call), tool(errors)
    const feedback = calls[1].at(-1)!;
    expect(feedback.role).toBe("tool");
    expect(feedback.role === "tool" && feedback.tool_call_id).toBe("call_1");
    expect(feedback.content).toContain("Divide by 12");
  });

  it("gives up after 3 attempts instead of looping forever", async () => {
    const bad = goodExtraction();
    bad.rules[0].citation = cite(1, "made up quote that is not in the doc");
    const { model, calls } = fakeModel([bad]);
    const report = await extractRuleset({ pages, lenderId: "suvidha", model });
    expect(report.ok).toBe(false);
    expect(calls).toHaveLength(3);
  });

  it("accepts JSON in plain text from models that ignore tool_choice", async () => {
    const model: Model = { name: "texty", call: async () => ({ message: { role: "assistant", content: "Here you go:\n" + JSON.stringify(goodExtraction()) } }) };
    const report = await extractRuleset({ pages, lenderId: "suvidha", model });
    expect(report.ok).toBe(true);
  });
});