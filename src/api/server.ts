import "dotenv/config";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import Fastify, { type FastifyReply } from "fastify";
import { ZodError } from "zod";
import { pool, withTx } from "../db/client.js";
import { applyOutcome } from "../db/decisions.js";
import { ADAPTERS } from "../lenders/adapters.js";
import { ApplicantProfileSchema, LenderRulesetSchema, type ApplicantProfile, type LenderRuleset } from "../rules/schema.js";
import { route, type RoutingResult } from "../rules/engine.js";
import { canonicalJson, maskPan, sha256 } from "../lib/hash.js";

const SUBMIT_TOP_N = Number(process.env.SUBMIT_TOP_N ?? 3);
const WEBHOOK_SECRET = process.env.LENDER_WEBHOOK_SECRET ?? "dev-webhook-secret";

export type ServerDeps = {
  enqueue: (submissionIds: string[]) => Promise<void>;
  circuitStates?: () => Promise<Record<string, string>>;
};

async function defaultDeps(): Promise<ServerDeps> {
  const { enqueueSubmissions } = await import("../queue/queue.js");
  const { CircuitBreaker } = await import("../lib/circuit-breaker.js");
  const { createRedis } = await import("../lib/redis.js");
  const breaker = new CircuitBreaker(createRedis());
  return {
    enqueue: enqueueSubmissions,
    circuitStates: async () => Object.fromEntries(await Promise.all(Object.keys(ADAPTERS).map(async (id) => [id, await breaker.state(id)]))),
  };
}

export function buildServer(deps: ServerDeps) {
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

  app.get("/admin/circuits", async () => (deps.circuitStates ? deps.circuitStates() : {}));

  // Dry run: which lenders would this person qualify for? Writes nothing.
  app.post("/eligibility", async (req) => {
    const profile = ApplicantProfileSchema.parse(req.body);
    const rulesets = await loadActiveRulesets();
    return summarize(route(rulesets.map((r) => r.ruleset), profile));
  });

  // Create an application and queue it to the top N lenders.
  app.post("/applications", async (req, reply: FastifyReply) => {
    const key = req.headers["idempotency-key"];
    if (typeof key !== "string" || key.length < 8 || key.length > 128) {
      return reply.code(400).send({ error: "idempotency_key_required", message: "Send an Idempotency-Key header (8–128 chars), e.g. a UUID" });
    }

    const profile = ApplicantProfileSchema.parse(req.body);
    const requestHash = sha256(canonicalJson(profile));

    const rulesets = await loadActiveRulesets();
    const routing = route(rulesets.map((r) => r.ruleset), profile);
    const targets = routing.eligible.slice(0, SUBMIT_TOP_N);
    const status = targets.length > 0 ? "submitting" : "no_match";

    const result = await withTx(async (c) => {
      const inserted = await c.query(
        `INSERT INTO applications (idempotency_key, request_hash, profile, routing, ruleset_ids, status)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING id, status, created_at`,
        [key, requestHash, profile, routing, rulesets.map((r) => r.id), status],
      );

      if (inserted.rowCount === 1) {
        const row = inserted.rows[0];
        // Submission rows are written in the SAME transaction as the application,
        // so they either both exist or neither does.
        for (const [i, d] of targets.entries()) {
          await c.query(`INSERT INTO submissions (application_id, lender_id, rank) VALUES ($1, $2, $3)`, [row.id, d.lenderId, i + 1]);
        }
        await c.query(`INSERT INTO audit_log (application_id, event, data) VALUES ($1, 'application.created', $2)`, [
          row.id, { status, eligibleLenders: routing.eligible.map((d) => d.lenderId), submittingTo: targets.map((d) => d.lenderId), rulesetIds: rulesets.map((r) => r.id) },
        ]);
        return { replay: false as const, row: { ...row, routing } };
      }

      const existing = await c.query(`SELECT id, status, created_at, routing, request_hash FROM applications WHERE idempotency_key = $1`, [key]);
      return { replay: true as const, row: existing.rows[0] };
    });

    if (result.replay && result.row.request_hash !== requestHash) {
      return reply.code(422).send({ error: "idempotency_key_reused", message: "This Idempotency-Key was already used with a different request body" });
    }

    // Enqueue AFTER commit (a worker must never see a job for a row that doesn't
    // exist yet). If we crash right here, the client's retry re-enqueues, and the
    // worker's sweeper catches the rest. Enqueue is idempotent, so both are safe.
    const queued = await pool.query(`SELECT id FROM submissions WHERE application_id = $1 AND status = 'queued'`, [result.row.id]);
    await deps.enqueue(queued.rows.map((r) => r.id));

    return reply
      .code(result.replay ? 200 : 201)
      .header("idempotent-replayed", String(result.replay))
      .send({ id: result.row.id, status: result.row.status, createdAt: result.row.created_at, routing: summarize(result.row.routing) });
  });

  app.get<{ Params: { id: string } }>("/applications/:id", async (req, reply) => {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return reply.code(400).send({ error: "invalid_id" });
    const { rows } = await pool.query(`SELECT * FROM applications WHERE id = $1`, [req.params.id]);
    if (!rows[0]) return reply.code(404).send({ error: "not_found" });
    const [subs, audit] = await Promise.all([
      pool.query(`SELECT lender_id, rank, status, attempts, lender_ref, offered_rate, reason, last_error, updated_at FROM submissions WHERE application_id = $1 ORDER BY rank`, [req.params.id]),
      pool.query(`SELECT event, data, created_at FROM audit_log WHERE application_id = $1 ORDER BY id`, [req.params.id]),
    ]);
    const a = rows[0];
    return {
      id: a.id, status: a.status, createdAt: a.created_at, profile: publicProfile(a.profile),
      routing: summarize(a.routing), submissions: subs.rows, rulesetIds: a.ruleset_ids.map(Number), audit: audit.rows,
    };
  });

  // Webhooks need the raw body to verify the signature, so they get their own
  // JSON parser in an isolated scope.
  app.register(async (scope) => {
    scope.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
      (req as any).rawBody = body;
      try {
        done(null, JSON.parse(body as string));
      } catch (err) {
        done(err as Error, undefined);
      }
    });

    scope.post<{ Params: { lenderId: string } }>("/webhooks/lenders/:lenderId", async (req, reply) => {
      const adapter = ADAPTERS[req.params.lenderId];
      if (!adapter?.parseWebhook) return reply.code(404).send({ error: "unknown_lender" });

      // 1. Verify it really came from the lender (HMAC over the exact bytes).
      const raw: string = (req as any).rawBody ?? "";
      const given = String(req.headers["x-signature"] ?? "");
      const expected = crypto.createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex");
      const valid = given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
      if (!valid) return reply.code(401).send({ error: "invalid_signature" });

      let parsed;
      try {
        parsed = adapter.parseWebhook(req.body);
      } catch {
        return reply.code(400).send({ error: "unrecognised_payload" });
      }

      return withTx(async (c) => {
        // 2. Deduplicate: same payload twice = processed once.
        const ev = await c.query(
          `INSERT INTO webhook_events (lender_id, payload_hash, lender_ref, payload) VALUES ($1, $2, $3, $4)
           ON CONFLICT (lender_id, payload_hash) DO NOTHING RETURNING id`,
          [adapter.id, sha256(raw), parsed.ref, req.body],
        );
        if (ev.rowCount === 0) return reply.code(200).send({ ok: true, duplicate: true });

        // 3. Match to our submission. If the webhook beat the worker here, keep
        //    it; the worker applies it as soon as it records the lender's ref.
        const sub = await c.query(`SELECT id FROM submissions WHERE lender_id = $1 AND lender_ref = $2`, [adapter.id, parsed.ref]);
        if (!sub.rows[0]) return reply.code(202).send({ ok: true, matched: false });

        await applyOutcome(c, sub.rows[0].id, parsed.outcome, "webhook");
        await c.query(`UPDATE webhook_events SET matched_submission = $1 WHERE id = $2`, [sub.rows[0].id, ev.rows[0].id]);
        return reply.code(200).send({ ok: true, matched: true });
      });
    });
  });

  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.API_PORT ?? 3000);
  defaultDeps().then((deps) => buildServer(deps).listen({ port, host: "0.0.0.0" }));
}