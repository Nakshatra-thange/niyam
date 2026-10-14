import { describe, expect, it } from "vitest";
import { deriveFields, evaluateLender, evaluateRule, route } from "../src/rules/engine.js";
import { SEED_RULESETS } from "../src/rules/seed-rules.js";
import type { ApplicantProfile, Rule } from "../src/rules/schema.js";

const sampleProfile: ApplicantProfile = {
  name: "Aarav Sharma",
  phone: "9876543210",
  pan: "ABCDE1234F",
  age: 30,
  city: "mumbai",
  employment_type: "salaried",
  monthly_income: 60000,
  existing_emi: 15000,
  cibil_score: 800,
  loan_amount: 500000,
};

describe("engine: deriveFields", () => {
  it("derives all required fields and calculates FOIR correctly", () => {
    const fields = deriveFields(sampleProfile);
    expect(fields.cibil_score).toBe(800);
    expect(fields.monthly_income).toBe(60000);
    expect(fields.age).toBe(30);
    expect(fields.city).toBe("mumbai");
    expect(fields.employment_type).toBe("salaried");
    expect(fields.loan_amount).toBe(500000);
    expect(fields.business_vintage_months).toBeNull();
    // 15000 / 60000 = 0.25
    expect(fields.foir).toBe(0.25);
  });

  it("sets foir to null when monthly_income is 0", () => {
    const fields = deriveFields({ ...sampleProfile, monthly_income: 0, existing_emi: 5000 });
    expect(fields.foir).toBeNull();
  });

  it("preserves business_vintage_months when provided", () => {
    const fields = deriveFields({ ...sampleProfile, business_vintage_months: 36 });
    expect(fields.business_vintage_months).toBe(36);
  });
});

describe("engine: evaluateRule", () => {
  const fields = deriveFields(sampleProfile);

  it("handles gte and lte operators", () => {
    const gteRule: Rule = { id: "cibil-gte", field: "cibil_score", op: "gte", value: 750, message: "CIBIL >= 750" };
    expect(evaluateRule(gteRule, fields).passed).toBe(true);

    const gteFail: Rule = { id: "cibil-gte-fail", field: "cibil_score", op: "gte", value: 850, message: "CIBIL >= 850" };
    expect(evaluateRule(gteFail, fields).passed).toBe(false);

    const lteRule: Rule = { id: "foir-lte", field: "foir", op: "lte", value: 0.5, message: "FOIR <= 50%" };
    expect(evaluateRule(lteRule, fields).passed).toBe(true);

    const lteFail: Rule = { id: "foir-lte-fail", field: "foir", op: "lte", value: 0.2, message: "FOIR <= 20%" };
    expect(evaluateRule(lteFail, fields).passed).toBe(false);
  });

  it("handles eq operator (case and whitespace insensitive)", () => {
    const eqRule: Rule = { id: "emp-eq", field: "employment_type", op: "eq", value: "Salaried", message: "Salaried only" };
    expect(evaluateRule(eqRule, fields).passed).toBe(true);

    const eqFail: Rule = { id: "emp-eq-fail", field: "employment_type", op: "eq", value: "self_employed", message: "Self-employed only" };
    expect(evaluateRule(eqFail, fields).passed).toBe(false);
  });

  it("handles in and not_in operators", () => {
    const inRule: Rule = { id: "city-in", field: "city", op: "in", value: ["Mumbai", "Delhi"], message: "Metro only" };
    expect(evaluateRule(inRule, fields).passed).toBe(true);

    const inFail: Rule = { id: "city-in-fail", field: "city", op: "in", value: ["Pune", "Delhi"], message: "Selected cities only" };
    expect(evaluateRule(inFail, fields).passed).toBe(false);

    const notInRule: Rule = { id: "city-notin", field: "city", op: "not_in", value: ["Kolkata", "Chennai"], message: "Not in Kolkata or Chennai" };
    expect(evaluateRule(notInRule, fields).passed).toBe(true);

    const notInFail: Rule = { id: "city-notin-fail", field: "city", op: "not_in", value: ["Mumbai", "Chennai"], message: "Not in Mumbai" };
    expect(evaluateRule(notInFail, fields).passed).toBe(false);
  });

  it("handles between operator", () => {
    const betweenRule: Rule = { id: "age-between", field: "age", op: "between", value: [21, 58], message: "Age 21-58" };
    expect(evaluateRule(betweenRule, fields).passed).toBe(true);

    const betweenFail: Rule = { id: "age-between-fail", field: "age", op: "between", value: [35, 60], message: "Age 35-60" };
    expect(evaluateRule(betweenFail, fields).passed).toBe(false);
  });

  it("fails closed on null or undefined actual values", () => {
    const rule: Rule = { id: "vintage-rule", field: "business_vintage_months", op: "gte", value: 12, message: "Vintage >= 12" };
    const res = evaluateRule(rule, fields); // business_vintage_months is null
    expect(res.passed).toBe(false);
    expect(res.actual).toBeNull();
  });
});

describe("engine: evaluateLender and route", () => {
  it("evaluates a lender and calculates headroom when eligible", () => {
    const suvidha = SEED_RULESETS.find((s) => s.lenderId === "suvidha")!;
    const decision = evaluateLender(suvidha, sampleProfile);
    expect(decision.eligible).toBe(true);
    expect(decision.headroom).toBeGreaterThan(0);
    expect(decision.reasons[0]).toContain("Meets all");
  });

  it("marks decision ineligible with reasons when rules fail", () => {
    const suvidha = SEED_RULESETS.find((s) => s.lenderId === "suvidha")!;
    const poorScoreProfile: ApplicantProfile = { ...sampleProfile, cibil_score: 600 };
    const decision = evaluateLender(suvidha, poorScoreProfile);
    expect(decision.eligible).toBe(false);
    expect(decision.headroom).toBe(0);
    expect(decision.reasons.some((r) => r.includes("CIBIL") && r.includes("600"))).toBe(true);
  });

  it("routes lenders sorted by interestRateMin, headroom, and lenderId", () => {
    const result = route(SEED_RULESETS, sampleProfile);
    expect(result.eligible.length).toBeGreaterThan(0);

    // Verify ordering by interestRateMin ascending
    for (let i = 1; i < result.eligible.length; i++) {
      const prev = result.eligible[i - 1];
      const curr = result.eligible[i];
      if (prev.interestRateMin === curr.interestRateMin) {
        expect(prev.headroom).toBeGreaterThanOrEqual(curr.headroom);
      } else {
        expect(prev.interestRateMin).toBeLessThanOrEqual(curr.interestRateMin);
      }
    }
  });
});
