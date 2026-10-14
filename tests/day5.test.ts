import "dotenv/config";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixedModel, metroV2Extraction } from "./fixtures.js";

// Needs a real database (db:migrate + db:seed). Uses its own throwaway lender id
// and deletes everything it created afterwards.
const hasDb = !!process.env.DATABASE_URL;

describe.skipIf(!hasDb)("Day 5: review workflow", async () => {
  const { buildServer } = await import("../src/api/server.js");
  const { pool } = await import("../src/db/client.js");
  const { diffRulesets } = await import("../src/rulesets/repo.js");

  const LENDER = `test-metro-${Date.now().toString(36)}`;
  const policy = readFileSync("policies/metro-bank-v2.txt", "utf8");
  const app = buildServer({ enqueue: async () => {}, model: () => fixedModel(metroV2Extraction()), adminToken: "" });
  const as = { "x-reviewer": "Test Reviewer" };

  // Indore, CIBIL 760: not eligible for any Metro product until v2 goes live.
  const applicant = {
    name: "Priya Sharma", phone: "9988776655", pan: "AAAPL1234C", age: 29, city: "Indore", employment_type: "salaried",
    monthly_income: 45000, existing_emi: 10000, cibil_score: 760, loan_amount: 300000,
  };

  const upload = () =>
    app.inject({ method: "POST", url: `/admin/policies?lender=${LENDER}&filename=metro-v2.txt`, headers: { ...as, "content-type": "text/plain" }, payload: policy });
  const eligibleIds = async () => (await app.inject({ method: "POST", url: "/eligibility", payload: applicant })).json().eligible.map((d: any) => d.lenderId);
  const activeIds = async () => (await pool.query(`SELECT id FROM rulesets WHERE lender_id = $1 AND status = 'active'`, [LENDER])).rows.map((r) => Number(r.id));

  beforeAll(async () => app.ready());
  afterAll(async () => {
    await pool.query(`DELETE FROM ruleset_events WHERE lender_id = $1`, [LENDER]);
    await pool.query(`DELETE FROM rulesets WHERE lender_id = $1`, [LENDER]);
    await pool.query(`DELETE FROM lenders WHERE id = $1`, [LENDER]);
    await app.close();
    await pool.end();
  });

  let v1: number;

  it("upload -> agent -> DRAFT, which does not route anything yet", async () => {
    const res = await upload();
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.version).toBe(1);
    expect(body.warnings.join()).toContain("needs human");
    expect(body.note).toContain("No integration"); // test lender has no API adapter
    v1 = body.id;
    expect(await eligibleIds()).not.toContain(LENDER);
  });

  it("detail includes the source pages for citation highlighting, and an impact preview", async () => {
    const detail = (await app.inject({ method: "GET", url: `/admin/rulesets/${v1}` })).json();
    expect(detail.status).toBe("draft");
    expect(detail.source_pages).toHaveLength(2);
    expect(detail.active).toBeNull();
    const impact = (await app.inject({ method: "GET", url: `/admin/rulesets/${v1}/impact` })).json();
    expect(impact.eligibleBefore).toBe(0); // new lender: nobody eligible today
    expect(impact.gained).toBe(impact.eligibleAfter);
  });

  it("approval requires a named reviewer", async () => {
    const res = await app.inject({ method: "POST", url: `/admin/rulesets/${v1}/approve`, payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("reviewer");
  });

  it("a human edit that points at text not in the document is refused", async () => {
    const edited = (await app.inject({ method: "GET", url: `/admin/rulesets/${v1}` })).json().ruleset;
    edited.rules[1].citation.quote = "CIBIL of 700 is fine";
    const res = await app.inject({ method: "POST", url: `/admin/rulesets/${v1}/approve`, headers: as, payload: { ruleset: edited } });
    expect(res.statusCode).toBe(400);
    expect(res.json().details.join()).toContain("not in the source document");
  });

  it("approve with a human edit: goes live instantly and records exactly what the human changed", async () => {
    const edited = (await app.inject({ method: "GET", url: `/admin/rulesets/${v1}` })).json().ruleset;
    edited.rules.find((r: any) => r.field === "cibil_score").value = 755; // reviewer tightens one rule
    const res = await app.inject({ method: "POST", url: `/admin/rulesets/${v1}/approve`, headers: as, payload: { ruleset: edited, note: "tightened CIBIL" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().humanEdited).toBe(true);
    expect(res.json().edits.changed).toEqual([expect.objectContaining({ before: expect.objectContaining({ value: 750 }), after: expect.objectContaining({ value: 755 }) })]);

    expect(await eligibleIds()).toContain(LENDER); // live the moment it's approved

    // No adapter -> shown as eligible, but no submission is created for it.
    const created = await app.inject({ method: "POST", url: "/applications", headers: { "idempotency-key": randomUUID() }, payload: applicant });
    const subs = (await app.inject({ method: "GET", url: `/applications/${created.json().id}` })).json().submissions;
    expect(subs.map((s: any) => s.lender_id)).not.toContain(LENDER);

    const detail = (await app.inject({ method: "GET", url: `/admin/rulesets/${v1}` })).json();
    expect(detail.humanEdits.changed).toHaveLength(1); // agent output vs what went live
    expect(detail.events[0]).toMatchObject({ event: "approved", actor: "Test Reviewer" });
  });

  it("an approved version can't be approved again", async () => {
    const res = await app.inject({ method: "POST", url: `/admin/rulesets/${v1}/approve`, headers: as, payload: {} });
    expect(res.statusCode).toBe(409);
  });

  it("new version replaces the old one; rollback restores it", async () => {
    const v2 = (await upload()).json().id;
    const approved = (await app.inject({ method: "POST", url: `/admin/rulesets/${v2}/approve`, headers: as, payload: {} })).json();
    expect(approved.replaced.id).toBe(v1);
    expect(await activeIds()).toEqual([v2]);

    const rb = await app.inject({ method: "POST", url: `/admin/rulesets/${v1}/rollback`, headers: as, payload: { note: "v2 misbehaving" } });
    expect(rb.statusCode).toBe(200);
    expect(await activeIds()).toEqual([v1]);
    const { rows } = await pool.query(`SELECT status FROM rulesets WHERE id = $1`, [v2]);
    expect(rows[0].status).toBe("retired");
  });

  it("reject needs a reason; rejected drafts can't be approved", async () => {
    const id = (await upload()).json().id;
    expect((await app.inject({ method: "POST", url: `/admin/rulesets/${id}/reject`, headers: as, payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `/admin/rulesets/${id}/reject`, headers: as, payload: { reason: "wrong document" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/admin/rulesets/${id}/approve`, headers: as, payload: {} })).statusCode).toBe(409);
  });

  it("two reviewers approving two drafts at once leave exactly one active version", async () => {
    const a = (await upload()).json().id;
    const b = (await upload()).json().id;
    const results = await Promise.all([a, b].map((id) => app.inject({ method: "POST", url: `/admin/rulesets/${id}/approve`, headers: as, payload: {} })));
    expect(results.map((r) => r.statusCode)).toEqual([200, 200]);
    expect(await activeIds()).toHaveLength(1);
  });

  it("ADMIN_TOKEN protects /admin but not the page itself", async () => {
    process.env.ADMIN_TOKEN = "s3cret-token";
    const locked = buildServer({ enqueue: async () => {} });
    delete process.env.ADMIN_TOKEN;
    expect((await locked.inject({ method: "GET", url: "/admin/rulesets" })).statusCode).toBe(401);
    expect((await locked.inject({ method: "GET", url: "/admin/rulesets", headers: { "x-admin-token": "wrong-token!" } })).statusCode).toBe(401);
    expect((await locked.inject({ method: "GET", url: "/admin/rulesets", headers: { "x-admin-token": "s3cret-token" } })).statusCode).toBe(200);
    const page = await locked.inject({ method: "GET", url: "/review" });
    expect(page.statusCode).toBe(200);
    expect(page.headers["content-type"]).toContain("text/html");
    await locked.close();
  });

  it("diff matches rules by field + operator", () => {
    const base = { lenderId: "x", lenderName: "X", interestRateMin: 10, interestRateMax: 12, rules: [
      { id: "a", field: "cibil_score" as const, op: "gte" as const, value: 700, message: "CIBIL 700+" },
      { id: "b", field: "age" as const, op: "between" as const, value: [21, 60] as [number, number], message: "age" },
    ] };
    const next = { ...base, interestRateMax: 13, rules: [
      { id: "a", field: "cibil_score" as const, op: "gte" as const, value: 720, message: "CIBIL 720+" },
      { id: "c", field: "city" as const, op: "in" as const, value: ["pune"], message: "Pune only" },
    ] };
    const d = diffRulesets(base, next);
    expect(d.changed.map((c) => c.after.value)).toEqual([720]);
    expect(d.added.map((r) => r.field)).toEqual(["city"]);
    expect(d.removed.map((r) => r.field)).toEqual(["age"]);
    expect(d.rate).toEqual({ before: [10, 12], after: [10, 13] });
  });
});