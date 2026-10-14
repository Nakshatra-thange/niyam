import "dotenv/config";
import { pathToFileURL } from "node:url";
import { DelayedError, UnrecoverableError, Worker, type Job } from "bullmq";
import { pool, withTx } from "../db/client.js";
import { applyOutcome, markSubmissionFailed } from "../db/decisions.js";
import { ADAPTERS, FatalError, RetryableError } from "../lenders/adapters.js";
import { submitToLender } from "../lenders/submit.js";
import { CircuitBreaker } from "../lib/circuit-breaker.js";
import { createRedis } from "../lib/redis.js";
import { ApplicantProfileSchema } from "../rules/schema.js";
import { backoffMs, enqueueSubmissions, QUEUE_NAME, type SubmissionJob } from "./queue.js";

const log = (msg: string, data: Record<string, unknown> = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...data }));

export function createProcessor(breaker: CircuitBreaker) {
  return async function process(job: Job<SubmissionJob>, token?: string) {
    const { submissionId } = job.data;

    const { rows } = await pool.query(
      `SELECT s.id, s.lender_id, s.status, a.profile
         FROM submissions s JOIN applications a ON a.id = s.application_id
        WHERE s.id = $1`,
      [submissionId],
    );
    const sub = rows[0];
    if (!sub) throw new UnrecoverableError(`submission ${submissionId} not found`);

    // Idempotency: a job that runs twice must not submit twice.
    if (["approved", "rejected", "failed", "pending_decision"].includes(sub.status)) {
      log("skip: already processed", { submissionId, status: sub.status });
      return { skipped: true };
    }

    const adapter = ADAPTERS[sub.lender_id];
    if (!adapter) throw new UnrecoverableError(`no adapter for lender ${sub.lender_id}`);

    // Circuit open? Park the job until the cooldown ends. moveToDelayed does
    // NOT use up a retry attempt, so an outage can't exhaust our retries.
    const gate = await breaker.check(sub.lender_id);
    if (!gate.allowed) {
      log("circuit open, delaying", { submissionId, lender: sub.lender_id, retryInMs: gate.retryInMs });
      await job.moveToDelayed(Date.now() + gate.retryInMs, token);
      throw new DelayedError();
    }

    await pool.query(`UPDATE submissions SET status = 'sending', attempts = attempts + 1, updated_at = now() WHERE id = $1`, [submissionId]);
    const profile = ApplicantProfileSchema.parse(sub.profile);
    const isLastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);

    try {
      const outcome = await submitToLender(adapter, profile, submissionId);
      await breaker.recordSuccess(sub.lender_id);

      await withTx(async (c) => {
        await applyOutcome(c, submissionId, outcome, "sync");
        // Async lender whose webhook beat us here? Apply it now.
        if (outcome.kind === "pending") await reconcileEarlyWebhook(c, sub.lender_id, outcome.ref, submissionId);
      });
      log("lender responded", { submissionId, lender: sub.lender_id, outcome: outcome.kind, attempt: job.attemptsMade + 1 });
      return { outcome: outcome.kind };
    } catch (err) {
      if (err instanceof RetryableError) {
        if (err.countsAsFailure) await breaker.recordFailure(sub.lender_id, gate.isProbe);
        await pool.query(`UPDATE submissions SET status = 'queued', last_error = $2, updated_at = now() WHERE id = $1`, [submissionId, err.message]);
        log("retryable failure", { submissionId, lender: sub.lender_id, error: err.message, attempt: job.attemptsMade + 1, isLastAttempt });

        if (isLastAttempt) {
          await withTx((c) => markSubmissionFailed(c, submissionId, `gave up after ${job.attemptsMade + 1} attempts: ${err.message}`));
        }
        throw err; // BullMQ schedules the retry using our backoff strategy
      }

      // Fatal: the lender answered, so it's up; retrying won't change the answer.
      if (gate.isProbe) await breaker.recordSuccess(sub.lender_id);
      const message = err instanceof FatalError ? err.message : `unexpected: ${String(err)}`;
      await withTx((c) => markSubmissionFailed(c, submissionId, message));
      log("fatal failure", { submissionId, lender: sub.lender_id, error: message });
      throw new UnrecoverableError(message);
    }
  };
}

async function reconcileEarlyWebhook(c: import("pg").PoolClient, lenderId: string, ref: string, submissionId: string) {
  const { rows } = await c.query(
    `SELECT id, payload FROM webhook_events WHERE lender_id = $1 AND lender_ref = $2 AND matched_submission IS NULL ORDER BY id LIMIT 1`,
    [lenderId, ref],
  );
  if (!rows[0]) return;
  const parsed = ADAPTERS[lenderId].parseWebhook?.(rows[0].payload);
  if (!parsed) return;
  await applyOutcome(c, submissionId, parsed.outcome, "webhook");
  await c.query(`UPDATE webhook_events SET matched_submission = $1 WHERE id = $2`, [submissionId, rows[0].id]);
}

/**
 * Safety net for the gap between "DB committed" and "job enqueued": if the API
 * crashed in between, the submission row exists but no job does. Every minute,
 * re-enqueue anything stuck. Safe because enqueue is idempotent by jobId.
 */
export async function sweepStuckSubmissions() {
  const { rows } = await pool.query(
    `SELECT id FROM submissions WHERE status IN ('queued', 'sending') AND updated_at < now() - interval '60 seconds' LIMIT 500`,
  );
  if (rows.length) {
    await enqueueSubmissions(rows.map((r) => r.id));
    log("sweeper re-enqueued stuck submissions", { count: rows.length });
  }
}

export function startWorker() {
  const breaker = new CircuitBreaker(createRedis());
  const worker = new Worker<SubmissionJob>(QUEUE_NAME, createProcessor(breaker), {
    connection: createRedis(),
    concurrency: Number(process.env.WORKER_CONCURRENCY ?? 10),
    settings: {
      backoffStrategy: (attemptsMade: number, _type?: string, err?: Error) =>
        backoffMs(attemptsMade, err instanceof RetryableError ? err.retryAfterMs : undefined),
    },
  });
  worker.on("error", (err) => log("worker error", { error: String(err) }));

  const sweeper = setInterval(() => sweepStuckSubmissions().catch((e) => log("sweeper error", { error: String(e) })), 60_000);

  const shutdown = async () => {
    log("shutting down: finishing in-flight jobs");
    clearInterval(sweeper);
    await worker.close(); // waits for running jobs instead of killing them mid-request
    await pool.end();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  log("worker started", { queue: QUEUE_NAME });
  return worker;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startWorker();
  sweepStuckSubmissions().catch(() => {});
}