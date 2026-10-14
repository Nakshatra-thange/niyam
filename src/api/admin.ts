import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { extractPagesFromBytes } from "../agent/pdf.js";
import { extractRuleset } from "../agent/extract.js";
import type { Model } from "../agent/model.js";
import { ADAPTERS } from "../lenders/adapters.js";
import { approve, diffRulesets, getActive, getEvents, getRuleset, impactOf, listRulesets, reject, ReviewError, rollback, saveDraft } from "../rulesets/repo.js";

const here = dirname(fileURLToPath(import.meta.url));
const REVIEW_HTML = readFileSync(join(here, "../review/index.html"), "utf8");

export type AdminOptions = { model?: () => Model; adminToken?: string };

const safeEqual = (a: string, b: string) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const reviewer = (req: FastifyRequest) => String(req.headers["x-reviewer"] ?? "").trim() || undefined;
const idParam = (req: FastifyRequest) => {
  const id = Number((req.params as { id: string }).id);
  if (!Number.isInteger(id) || id < 1) throw new ReviewError(400, "invalid ruleset id");
  return id;
};

/**
 * Review UI + admin API. Everything under /admin requires the ADMIN_TOKEN
 * (if set) in an x-admin-token header. The /review page itself is static HTML;
 * it asks for the token and sends it with every call.
 */
export async function adminRoutes(app: FastifyInstance, opts: AdminOptions) {
  app.get("/review", async (_req, reply) => reply.type("text/html").send(REVIEW_HTML));

  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/admin/") || !opts.adminToken) return;
    const given = String(req.headers["x-admin-token"] ?? "");
    if (!safeEqual(given, opts.adminToken)) return reply.code(401).send({ error: "unauthorized" });
  });

  app.setErrorHandler((err, _req, reply: FastifyReply) => {
    if (err instanceof ReviewError) return reply.code(err.status).send({ error: err.message, details: err.details });
    app.log.error(err);
    return reply.code(500).send({ error: "internal_error", message: (err as any)?.message ?? "Internal error" });
  });

  // Policy documents arrive as raw bytes: application/pdf, or text/plain for .txt.
  app.addContentTypeParser(["application/pdf", "application/octet-stream"], { parseAs: "buffer", bodyLimit: 10 * 1024 * 1024 }, (_req, body, done) => done(null, body));

  app.get("/admin/rulesets", async () => listRulesets());

  app.get("/admin/rulesets/:id", async (req) => {
    const row = await getRuleset(idParam(req));
    if (!row) throw new ReviewError(404, "not found");
    const active = await getActive(row.lender_id);
    return {
      ...row,
      hasAdapter: !!ADAPTERS[row.lender_id],
      active: active && active.id !== row.id ? { id: active.id, version: active.version } : null,
      diffVsActive: active && active.id !== row.id ? diffRulesets(active.ruleset, row.ruleset) : null,
      humanEdits: row.agent_ruleset ? diffRulesets(row.agent_ruleset, row.ruleset) : null,
      events: await getEvents(row.lender_id),
    };
  });

  app.get("/admin/rulesets/:id/impact", async (req) => impactOf(idParam(req)));

  app.post("/admin/rulesets/:id/approve", async (req) => {
    const body = (req.body ?? {}) as { ruleset?: unknown; note?: string };
    return approve({ id: idParam(req), actor: reviewer(req), edited: body.ruleset, note: body.note });
  });

  app.post("/admin/rulesets/:id/reject", async (req) => {
    const body = (req.body ?? {}) as { reason?: string };
    return reject({ id: idParam(req), actor: reviewer(req), reason: body.reason });
  });

  app.post("/admin/rulesets/:id/rollback", async (req) => {
    const body = (req.body ?? {}) as { note?: string };
    return rollback({ id: idParam(req), actor: reviewer(req), note: body.note });
  });

  // Upload a policy -> agent extracts -> saved as a DRAFT for review.
  // ?lender=metro-bank&filename=metro-v2.pdf   body: the file bytes
  app.post("/admin/policies", async (req, reply) => {
    if (!opts.model) throw new ReviewError(503, "no model configured (set OPENROUTER_API_KEY)");
    const q = req.query as { lender?: string; filename?: string };
    const lenderId = String(q.lender ?? "");
    if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(lenderId)) throw new ReviewError(400, "lender must be a slug like 'metro-bank'");
    const actor = reviewer(req) ?? "unknown";

    const isPdf = String(req.headers["content-type"]).includes("pdf") || String(req.headers["content-type"]).includes("octet-stream");
    const bytes = Buffer.isBuffer(req.body) ? new Uint8Array(req.body) : new TextEncoder().encode(String(req.body ?? ""));
    if (bytes.length === 0) throw new ReviewError(400, "empty file");

    let pages: string[];
    try {
      pages = await extractPagesFromBytes(bytes, isPdf ? "pdf" : "txt");
    } catch (err) {
      throw new ReviewError(422, `could not read document: ${(err as Error).message}`);
    }

    const report = await extractRuleset({ pages, lenderId, model: opts.model() });
    if (!report.ok || !report.result.ruleset) {
      return reply.code(422).send({ error: "agent output failed validation after all retries", errors: report.result.errors, history: report.history, usage: report.usage });
    }

    const saved = await saveDraft({
      lenderId, ruleset: report.result.ruleset, report, sourceDocument: String(q.filename ?? `${lenderId}.${isPdf ? "pdf" : "txt"}`).slice(0, 120), sourcePages: pages, actor,
    });
    return reply.code(201).send({
      ...saved,
      lenderId,
      attempts: report.attempts,
      warnings: report.result.warnings,
      usage: report.usage,
      note: ADAPTERS[lenderId] ? undefined : "No integration exists for this lender yet: once approved it will show as eligible, but applications won't be submitted to it.",
    });
  });
}