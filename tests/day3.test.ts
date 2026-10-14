import "dotenv/config";
import { afterAll, describe, expect, it } from "vitest";
import { ADAPTERS, FatalError } from "../src/lenders/adapters.js";
import { backoffMs } from "../src/queue/queue.js";
import { ApplicantProfileSchema } from "../src/rules/schema.js";

const profile = ApplicantProfileSchema.parse({
  name: "Ravi", phone: "9123456780", pan: "PQRST6789K", age: 34, city: "Indore", employment_type: "business_owner",
  business_vintage_months: 40, monthly_income: 45000, existing_emi: 5000, cibil_score: 710, loan_amount: 200000,
});

describe("adapters", () => {
  it("dhanrekha sends money in paise", () => {
    const req: any = ADAPTERS.dhanrekha.buildRequest(profile);
    expect(req.req_amt_paise).toBe(20_000_000);
    expect(req.cust_details.income_paise).toBe(4_500_000);
  });

  it("metro-bank: HTTP 200 can still be a rejection", () => {
    const out = ADAPTERS["metro-bank"].parseResponse(200, { Success: true, Data: { Approved: false, CaseNo: "MET-1", Remarks: "Policy" } });
    expect(out).toEqual({ kind: "rejected", ref: "MET-1", reason: "Policy" });
  });

  it("kirana-credit: 202 means pending, decision arrives by webhook", () => {
    expect(ADAPTERS["kirana-credit"].parseResponse(202, { accepted: true, application_id: "KIR-9" })).toEqual({ kind: "pending", ref: "KIR-9" });
    const wh = ADAPTERS["kirana-credit"].parseWebhook!({ event: "loan.decision", application_id: "KIR-9", decision: "approve" });
    expect(wh.outcome.kind).toBe("approved");
  });

  it("garbage responses are fatal, not silently treated as approval", () => {
    expect(() => ADAPTERS.suvidha.parseResponse(200, { weird: true })).toThrow(FatalError);
  });
});

describe("backoff", () => {
  it("grows exponentially, is jittered, and caps at 30s", () => {
    for (let i = 0; i < 50; i++) {
      const b1 = backoffMs(1), b3 = backoffMs(3), b20 = backoffMs(20);
      expect(b1).toBeGreaterThanOrEqual(500); expect(b1).toBeLessThanOrEqual(1000);
      expect(b3).toBeGreaterThanOrEqual(2000); expect(b3).toBeLessThanOrEqual(4000);
      expect(b20).toBeLessThanOrEqual(30_000);
    }
  });
  it("respects Retry-After", () => expect(backoffMs(1, 10_000)).toBe(10_000));
});

const hasRedis = !!process.env.REDIS_URL;
describe.skipIf(!hasRedis)("circuit breaker", async () => {
  const { CircuitBreaker } = await import("../src/lib/circuit-breaker.js");
  const { createRedis } = await import("../src/lib/redis.js");
  const redis = createRedis();
  const lender = `test-${Date.now()}`;
  const cb = new CircuitBreaker(redis, { failureThreshold: 3, windowMs: 5000, cooldownMs: 300, probeTimeoutMs: 1000 });
  afterAll(() => redis.quit());

  it("closed -> open after threshold failures", async () => {
    expect(await cb.state(lender)).toBe("closed");
    for (let i = 0; i < 3; i++) await cb.recordFailure(lender, false);
    expect(await cb.state(lender)).toBe("open");
    const check = await cb.check(lender);
    expect(check.allowed).toBe(false);
  });

  it("after cooldown, exactly one probe is allowed (half-open)", async () => {
    await new Promise((r) => setTimeout(r, 350));
    const [a, b] = await Promise.all([cb.check(lender), cb.check(lender)]);
    const probes = [a, b].filter((c) => c.allowed && c.isProbe);
    expect(probes).toHaveLength(1);
  });

  it("failed probe re-opens; successful probe closes", async () => {
    await cb.recordFailure(lender, true);
    expect(await cb.state(lender)).toBe("open");
    await new Promise((r) => setTimeout(r, 350));
    const probe = await cb.check(lender);
    expect(probe.allowed && probe.isProbe).toBe(true);
    await cb.recordSuccess(lender);
    expect(await cb.state(lender)).toBe("closed");
  });
});