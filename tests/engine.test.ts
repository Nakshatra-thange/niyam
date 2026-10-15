import { describe, expect, it } from "vitest";
import { route, evaluateLender } from "../src/rules/engine.js";
import { SEED_RULESETS } from "../src/rules/seed-rules.js";
import { ApplicantProfileSchema, LenderRulesetSchema, RuleSchema } from "../src/rules/schema.js";

const profile = (overrides: Record<string, unknown> = {}) =>
  ApplicantProfileSchema.parse({
    name: "Asha Verma",
    phone: "9876543210",
    pan: "ABCDE1234F",
    age: 30,
    city: "Pune",
    employment_type: "salaried",
    monthly_income: 60000,
    existing_emi: 10000,
    cibil_score: 790,
    loan_amount: 300000,
    ...overrides,
  });

const byId = (id: string) => SEED_RULESETS.find((r) => r.lenderId === id)!;

describe("seed data", () => {
  it("every seed ruleset is valid against the DSL", () => {
    for (const rs of SEED_RULESETS) expect(() => LenderRulesetSchema.parse(rs)).not.toThrow();
  });
});

describe("DSL validation", () => {
  it("rejects between with min > max", () => {
    expect(() => RuleSchema.parse({ id: "x", field: "age", op: "between", value: [60, 21], message: "bad range" })).toThrow();
  });
  it("rejects gte with a string value", () => {
    expect(() => RuleSchema.parse({ id: "x", field: "cibil_score", op: "gte", value: "700", message: "wrong type" })).toThrow();
  });
  it("rejects unknown fields", () => {
    expect(() => RuleSchema.parse({ id: "x", field: "shoe_size", op: "gte", value: 9, message: "nope" })).toThrow();
  });
});

describe("evaluateLender", () => {
  it("strong salaried metro applicant clears Metro bank", () => {
    const d = evaluateLender(byId("metro-bank"), profile());
    expect(d.eligible).toBe(true);
    expect(d.headroom).toBeGreaterThan(0);
  });

  it("explains every failed rule with the applicant's actual value", () => {
    const d = evaluateLender(byId("metro-bank"), profile({ cibil_score: 720, city: "Indore" }));
    expect(d.eligible).toBe(false);
    expect(d.reasons).toHaveLength(2);
    expect(d.reasons.join(" ")).toContain("you: 720");
    expect(d.reasons.join(" ")).toContain("you: indore");
  });

  it("fails closed when data is missing (new-to-credit has no CIBIL)", () => {
    const d = evaluateLender(byId("suvidha"), profile({ cibil_score: null }));
    expect(d.eligible).toBe(false);
    expect(d.reasons.join(" ")).toContain("not provided");
  });

  it("computes FOIR from existing EMI / income", () => {
    // 35k EMI on 60k income = 0.58 FOIR, above Suvidha's 0.5 cap
    const d = evaluateLender(byId("suvidha"), profile({ existing_emi: 35000 }));
    expect(d.eligible).toBe(false);
    expect(d.results.find((r) => r.field === "foir")?.actual).toBeCloseTo(0.5833, 3);
  });

  it("city matching is case- and whitespace-insensitive", () => {
    const d = evaluateLender(byId("metro-bank"), profile({ city: "  BENGALURU " }));
    expect(d.eligible).toBe(true);
  });
});

describe("route", () => {
  it("ranks eligible lenders cheapest first", () => {
    const r = route(SEED_RULESETS, profile());
    const rates = r.eligible.map((d) => d.interestRateMin);
    expect(rates).toEqual([...rates].sort((a, b) => a - b));
    expect(r.eligible[0].lenderId).toBe("metro-bank");
  });

  it("shop owner routes only to business lenders", () => {
    const r = route(
      SEED_RULESETS,
      profile({ employment_type: "business_owner", business_vintage_months: 30, monthly_income: 25000, cibil_score: null, city: "Ashta", loan_amount: 100000 }),
    );
    expect(r.eligible.map((d) => d.lenderId)).toEqual(["kirana-credit", "pragati"]);
  });

  it("returns no eligible lenders when nobody fits, with reasons for all", () => {
    const r = route(SEED_RULESETS, profile({ monthly_income: 5000, loan_amount: 5000000 }));
    expect(r.eligible).toHaveLength(0);
    expect(r.ineligible).toHaveLength(SEED_RULESETS.length);
    r.ineligible.forEach((d) => expect(d.reasons.length).toBeGreaterThan(0));
  });

  it("is deterministic", () => {
    const a = route(SEED_RULESETS, profile());
    const b = route([...SEED_RULESETS].reverse(), profile());
    expect(a.eligible.map((d) => d.lenderId)).toEqual(b.eligible.map((d) => d.lenderId));
  });
});