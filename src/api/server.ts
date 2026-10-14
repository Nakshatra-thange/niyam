import "dotenv/config";
import { pathToFileURL } from "node:url";
import Fastify, { type FastifyReply } from "fastify";
import { ZodError } from "zod";
import { pool, withTx } from "../db/client.js";
import { ApplicantProfileSchema, LenderRulesetSchema, type ApplicantProfile, type LenderRuleset } from "../rules/schema.js";
import { route, type RoutingResult } from "../rules/engine.js";
import { canonicalJson, maskPan, sha256 } from "../lib/hash.js";

export function buildServer() {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: "validation_failed", issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
    }
    app.log.error(err);
    return reply.code(500).send({ error: "internal_error" });
  });

  async function loadActiveRulesets(): Promise<{ id: number; ruleset: LenderRuleset }[]> {
    const { rows } = await pool.query(`SELECT id, ruleset FROM rulesets WHERE status = 'active' ORDER BY lender_id`);
    // Re-validate on read: a bad row in the DB should never silently route a loan.
    return rows.map((r) => ({ id: Number(r.id), ruleset: LenderRulesetSchema.parse(r.ruleset) }));
  }

  // Keep responses lean: drop per-rule internals, keep reasons.
  const summarize = (routing: RoutingResult) => ({
    eligible: routing.eligible.map((d) => ({
      lenderId: d.lenderId, lenderName: d.lenderName, interestRate: `${d.interestRateMin}–${d.interestRateMax}%`, headroom: d.headroom, reasons: d.reasons,
    })),
    ineligible: routing.ineligible.map((d) => ({ lenderId: d.lenderId, lenderName: d.lenderName, reasons: d.reasons })),
  });

  const publicProfile = (p: ApplicantProfile) => ({ ...p, pan: maskPan(p.pan) });

  app.get("/health", async () => {
    await pool.query("SELECT 1");
    return { ok: true };
  });

  // Dry run: which lenders would this person qualify for? Writes nothing.
  app.post("/eligibility", async (req) => {
    const profile = ApplicantProfileSchema.parse(req.body);
    const rulesets = await loadActiveRulesets();
    return summarize(route(rulesets.map((r) => r.ruleset), profile));
  });

  // Create an application. Requires an Idempotency-Key header so a retried
  // request (flaky mobile network, double tap) never creates two applications.
  app.post("/applications", async (req, reply: FastifyReply) => {
    const key = req.headers["idempotency-key"];
    if (typeof key !== "string" || key.length < 8 || key.length > 128) {
      return reply.code(400).send({ error: "idempotency_key_required", message: "Send an Idempotency-Key header (8–128 chars), e.g. a UUID" });
    }

    const profile = ApplicantProfileSchema.parse(req.body);
    const requestHash = sha256(canonicalJson(profile));

    const rulesets = await loadActiveRulesets();
    const routing = route(rulesets.map((r) => r.ruleset), profile);
    const status = routing.eligible.length > 0 ? "routed" : "no_match";

    const result = await withTx(async (c) => {
      // The UNIQUE constraint on idempotency_key does the real work here: if two
      // identical requests race, exactly one INSERT wins and the other gets no row.
      const inserted = await c.query(
        `INSERT INTO applications (idempotency_key, request_hash, profile, routing, ruleset_ids, status)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING id, status, created_at`,
        [key, requestHash, profile, routing, rulesets.map((r) => r.id), status],
      );

      if (inserted.rowCount === 1) {
        const app_ = inserted.rows[0];
        await c.query(`INSERT INTO audit_log (application_id, event, data) VALUES ($1, 'application.created', $2)`, [
          app_.id,
          { status, eligibleLenders: routing.eligible.map((d) => d.lenderId), rulesetIds: rulesets.map((r) => r.id) },
        ]);
        return { replay: false as const, row: { ...app_, routing } };
      }

      const existing = await c.query(`SELECT id, status, created_at, routing, request_hash FROM applications WHERE idempotency_key = $1`, [key]);
      return { replay: true as const, row: existing.rows[0] };
    });

    if (result.replay && result.row.request_hash !== requestHash) {
      // Same key, different body: almost always a client bug. Refuse loudly.
      return reply.code(422).send({ error: "idempotency_key_reused", message: "This Idempotency-Key was already used with a different request body" });
    }

    return reply
      .code(result.replay ? 200 : 201)
      .header("idempotent-replayed", String(result.replay))
      .send({ id: result.row.id, status: result.row.status, createdAt: result.row.created_at, routing: summarize(result.row.routing) });
  });

  app.get<{ Params: { id: string } }>("/applications/:id", async (req, reply) => {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return reply.code(400).send({ error: "invalid_id" });
    const { rows } = await pool.query(`SELECT * FROM applications WHERE id = $1`, [req.params.id]);
    if (!rows[0]) return reply.code(404).send({ error: "not_found" });
    const audit = await pool.query(`SELECT event, data, created_at FROM audit_log WHERE application_id = $1 ORDER BY id`, [req.params.id]);
    const a = rows[0];
    return {
      id: a.id, status: a.status, createdAt: a.created_at, profile: publicProfile(a.profile),
      routing: summarize(a.routing), rulesetIds: a.ruleset_ids.map(Number), audit: audit.rows,
    };
  });

  return app;
}

// Start the server only when run directly (not when imported by tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.API_PORT ?? 3000);
  buildServer().listen({ port, host: "0.0.0.0" });
}