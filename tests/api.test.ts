import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Needs a real database (run db:migrate and db:seed first). Skipped otherwise.
const hasDb = !!process.env.DATABASE_URL;

describe.skipIf(!hasDb)("API", async () => {
  const { buildServer } = await import("../src/api/server.js");
  const { pool } = await import("../src/db/client.js");
  const enqueued: string[] = [];
  const app = buildServer({ enqueue: async (ids) => void enqueued.push(...ids) });

  const body = {
    name: "Ravi Kumar",
    phone: "9123456780",
    pan: "PQRST6789K",
    age: 34,
    city: "Indore",
    employment_type: "business_owner",
    business_vintage_months: 40,
    monthly_income: 45000,
    existing_emi: 5000,
    cibil_score: 710,
    loan_amount: 200000,
  };

  beforeAll(async () => app.ready());
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it("rejects a request without an Idempotency-Key", async () => {
    const res = await app.inject({ method: "POST", url: "/applications", payload: body });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("idempotency_key_required");
  });

  it("returns field-level validation errors", async () => {
    const res = await app.inject({ method: "POST", url: "/applications", headers: { "idempotency-key": randomUUID() }, payload: { ...body, pan: "bad" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().issues[0].path).toBe("pan");
  });

  it("creates once, replays on retry, never duplicates", async () => {
    const key = randomUUID();
    const first = await app.inject({ method: "POST", url: "/applications", headers: { "idempotency-key": key }, payload: body });
    expect(first.statusCode).toBe(201);
    expect(first.headers["idempotent-replayed"]).toBe("false");

    const retry = await app.inject({ method: "POST", url: "/applications", headers: { "idempotency-key": key }, payload: body });
    expect(retry.statusCode).toBe(200);
    expect(retry.headers["idempotent-replayed"]).toBe("true");
    expect(retry.json().id).toBe(first.json().id);

    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM applications WHERE idempotency_key = $1`, [key]);
    expect(rows[0].n).toBe(1);
  });

  it("handles 10 concurrent identical requests: one row, one id", async () => {
    const key = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => app.inject({ method: "POST", url: "/applications", headers: { "idempotency-key": key }, payload: body })),
    );
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(new Set(results.map((r) => r.json().id)).size).toBe(1);
  });

  it("refuses the same key with a different body", async () => {
    const key = randomUUID();
    await app.inject({ method: "POST", url: "/applications", headers: { "idempotency-key": key }, payload: body });
    const res = await app.inject({ method: "POST", url: "/applications", headers: { "idempotency-key": key }, payload: { ...body, loan_amount: 999999 } });
    expect(res.statusCode).toBe(422);
  });

  it("GET masks the PAN and includes the audit trail", async () => {
    const created = await app.inject({ method: "POST", url: "/applications", headers: { "idempotency-key": randomUUID() }, payload: body });
    const res = await app.inject({ method: "GET", url: `/applications/${created.json().id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().profile.pan).toBe("******789K");
    expect(res.json().audit[0].event).toBe("application.created");
  });
  it("creates ranked submissions for the top lenders and enqueues them", async () => {
    const created = await app.inject({ method: "POST", url: "/applications", headers: { "idempotency-key": randomUUID() }, payload: body });
    expect(created.json().status).toBe("submitting");
    const res = await app.inject({ method: "GET", url: `/applications/${created.json().id}` });
    const subs = res.json().submissions;
    expect(subs.length).toBeGreaterThan(0);
    expect(subs.map((s: any) => s.rank)).toEqual(subs.map((_: any, i: number) => i + 1));
    expect(subs.every((s: any) => s.status === "queued")).toBe(true);
  });

  it("eligibility is a dry run", async () => {
    const res = await app.inject({ method: "POST", url: "/eligibility", payload: body });
    expect(res.statusCode).toBe(200);
    expect(res.json().eligible.map((d: any) => d.lenderId)).toContain("kirana-credit");
  });
});