import { afterAll, describe, expect, it } from "vitest";
import { extractPages } from "../src/agent/pdf.js";
import { extractRuleset } from "../src/agent/extract.js";
import { openRouterModel } from "../src/agent/model.js";
import { CASES, canonical } from "../evals/cases.js";
import { scoreCase, summarize, toMarkdown } from "../evals/score.js";
import { metroV2Extraction, startMockOpenRouter, toolCallCompletion } from "./fixtures.js";

const metroV2Case = CASES.find((c) => c.file.endsWith("metro-bank-v2.pdf"))!;
const pages = await extractPages(metroV2Case.file);

describe("canonical rule form", () => {
  it("eq X equals in [X]; lists ignore order and case", () => {
    expect(canonical({ field: "employment_type", op: "eq", value: "salaried" })).toBe(canonical({ field: "employment_type", op: "in", value: ["Salaried"] }));
    expect(canonical({ field: "city", op: "in", value: ["pune", "delhi"] })).toBe(canonical({ field: "city", op: "in", value: ["Delhi", "PUNE"] }));
    expect(canonical({ field: "employment_type", op: "not_in", value: ["self_employed", "business_owner"] })).toBe(canonical({ field: "employment_type", op: "eq", value: "salaried" }));
  });
});

describe("OpenRouter client + scoring, end to end against a mock server", async () => {
  let attempt = 0;
  const mock = await startMockOpenRouter((_body, n) => {
    attempt = n;
    if (n === 1) return { status: 429, json: { error: { message: "rate limited" } } }; // first call: OpenRouter busy
    if (n === 2) {
      const wrong = metroV2Extraction();
      wrong.rules[1].value = 780; // model copies the OLD cutoff; quote says 750
      wrong.rules[1].citation.quote = "CIBIL score of 780 is required"; // and makes up a quote for it
      return { json: toolCallCompletion(wrong, 0.011) };
    }
    return { json: toolCallCompletion(metroV2Extraction(), 0.009) };
  });
  afterAll(() => mock.close());

  const model = openRouterModel({ model: "test/model", apiKey: "sk-or-test", baseUrl: mock.baseUrl });
  const report = await extractRuleset({ pages, lenderId: "metro-bank", model });

  it("sends a well-formed OpenRouter request", () => {
    const req = mock.requests[1];
    expect(req.headers.authorization).toBe("Bearer sk-or-test");
    expect(req.body.model).toBe("test/model");
    expect(req.body.tools[0].function.name).toBe("submit_ruleset");
    expect(req.body.tool_choice).toEqual({ type: "function", function: { name: "submit_ruleset" } });
    expect(req.body.messages[0].role).toBe("system");
  });

  it("retries a 429, catches the fabricated quote, and the model fixes it", () => {
    expect(attempt).toBe(3); // 429, wrong answer, corrected answer
    expect(report.ok).toBe(true);
    expect(report.attempts).toBe(2);
    expect(report.history[0].errors.join()).toContain("not found in the document");
    const feedback = mock.requests[2].body.messages.at(-1);
    expect(feedback).toMatchObject({ role: "tool", tool_call_id: "call_x" });
    expect(report.usage.cost).toBeCloseTo(0.02);
  });

  it("scores a perfect extraction as perfect", () => {
    const s = scoreCase(metroV2Case, report);
    expect(s).toMatchObject({ ok: true, firstTry: false, recall: 1, precision: 1, rateCorrect: true });
    expect(s.traps.every((t) => t.passed)).toBe(true);
  });

  it("explains a wrong extraction: wrong value vs missing vs extra, and which trap failed", () => {
    const ex = metroV2Extraction();
    const ruleset = { lenderId: "metro-bank", lenderName: "Metro", interestRateMin: 10.75, interestRateMax: 16.5, rules: [
      { ...ex.rules[0], value: ["mumbai", "delhi", "bengaluru", "hyderabad", "pune", "chennai"] }, // forgot new cities
      ex.rules[1], ex.rules[2], ex.rules[3],                                                          // amount missing
      { id: "x", field: "age" as const, op: "gte" as const, value: 21, message: "made up" },          // invented
    ] } as any;
    const fake = { ...report, attempts: 1, result: { ok: true, errors: [], warnings: [], ruleset } };
    const s = scoreCase(metroV2Case, fake);
    expect(s.recall).toBe(0.6);
    expect(s.wrong[0]).toContain("city|in");
    expect(s.missing[0]).toContain("loan_amount");
    expect(s.extra.some((e) => e.startsWith("age"))).toBe(true);
    expect(s.traps.find((t) => t.name.includes("Tier-2"))!.passed).toBe(false);
  });

  it("summarises and renders markdown", () => {
    const s = scoreCase(metroV2Case, report);
    const sum = summarize("test/model", [s]);
    expect(sum).toMatchObject({ passedValidation: 1, exactRulesets: 1, trapsPassed: 3, trapsTotal: 3 });
    expect(toMarkdown([sum], [s], { date: "2026-10-14", runs: 1 })).toContain("| `test/model` | 1/1 |");
  });
});