import "dotenv/config";
import crypto from "node:crypto";
import Fastify from "fastify";
import { MOCK_LENDERS, newRef, type MockLender } from "./lenders.js";

/**
 * One server, five fake lenders: POST /lenders/:id/applications
 * Set CHAOS=off in .env to disable latency, errors and rate limits.
 */

const app = Fastify({ logger: { level: "info" } });
const chaosOn = process.env.CHAOS !== "off";
export const WEBHOOK_SECRET = process.env.LENDER_WEBHOOK_SECRET ?? "dev-webhook-secret";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rand = (min: number, max: number) => min + Math.random() * (max - min);

// Sliding-window rate limit per lender (last 60s of request timestamps).
const hits = new Map<string, number[]>();
function rateLimited(lender: MockLender): boolean {
  const now = Date.now();
  const recent = (hits.get(lender.id) ?? []).filter((t) => now - t < 60_000);
  recent.push(now);
  hits.set(lender.id, recent);
  return recent.length > lender.chaos.rateLimitPerMinute;
}
const DECLINE_RATE = Number(process.env.MOCK_DECLINE_RATE ?? 0.15);
// The lender's own hidden decision. Even if Niyam's rules say "eligible",
// a real lender sometimes says no — so do we (~15% of the time).
function decide(input: { cibil: number | null; income: number; amount: number }) {
  if (!input.income || input.income < 10000) return { approved: false, reason: "Income below internal threshold" };
  if (input.cibil !== null && input.cibil < 650) return { approved: false, reason: "Bureau score too low" };
  if (Math.random() < DECLINE_RATE) return { approved: false, reason: "Declined as per internal credit policy" };
  return { approved: true, rate: Math.round(rand(11, 28) * 10) / 10 };
}

function sign(body: string) {
  return crypto.createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
}

app.get("/health", async () => ({ ok: true, chaos: chaosOn, lenders: MOCK_LENDERS.map((l) => l.id) }));

app.post<{ Params: { id: string } }>("/lenders/:id/applications", async (req, reply) => {
  const lender = MOCK_LENDERS.find((l) => l.id === req.params.id);
  if (!lender) return reply.code(404).send({ error: "unknown lender" });

  if (chaosOn) {
    if (rateLimited(lender)) return reply.code(429).header("retry-after", "10").send({ error: "rate limited" });
    await sleep(rand(lender.chaos.minLatencyMs, lender.chaos.maxLatencyMs));
    if (Math.random() < lender.chaos.errorRate) return reply.code(500).send({ error: "internal server error" });
  }

  const input = lender.readRequest(req.body);
  if (!input || Number.isNaN(input.income) || Number.isNaN(input.amount))
    return reply.code(400).send({ error: `bad request shape for ${lender.id}` });

  const ref = newRef(lender.id.slice(0, 3).toUpperCase());
  const decision = decide(input);

  if (lender.chaos.mode === "async") {
    const callbackUrl = req.headers["x-callback-url"];
    if (typeof callbackUrl !== "string") return reply.code(400).send({ error: "X-Callback-Url header required" });

    // Fire the webhook a few seconds later, like a real underwriting queue.
    setTimeout(async () => {
      const payload = JSON.stringify(lender.formatDecision({ ...decision, ref }));
      try {
        await fetch(callbackUrl, {
          method: "POST",
          headers: { "content-type": "application/json", "x-lender-id": lender.id, "x-signature": sign(payload) },
          body: payload,
        });
        app.log.info({ lender: lender.id, ref }, "webhook sent");
      } catch (err) {
        app.log.warn({ lender: lender.id, ref, err: String(err) }, "webhook delivery failed");
      }
    }, chaosOn ? rand(2000, 5000) : 200);

    return reply.code(202).send({ accepted: true, application_id: ref });
  }

  return reply.code(200).send(lender.formatDecision({ ...decision, ref }));
});

const port = Number(process.env.LENDERS_PORT ?? 4000);
app.listen({ port, host: "0.0.0.0" }).then(() => app.log.info(`mock lenders on :${port} (chaos ${chaosOn ? "on" : "off"})`));