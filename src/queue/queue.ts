import { Queue } from "bullmq";
import { createRedis } from "../lib/redis.js";

export const QUEUE_NAME = "lender-submissions";
export const MAX_ATTEMPTS = Number(process.env.SUBMISSION_MAX_ATTEMPTS ?? 6);

export type SubmissionJob = { submissionId: string };

let queue: Queue<SubmissionJob> | null = null;
export function getQueue() {
  queue ??= new Queue<SubmissionJob>(QUEUE_NAME, { connection: createRedis() });
  return queue;
}

/**
 * Enqueue is idempotent: jobId = submissionId, and BullMQ ignores a second
 * add with the same jobId. So calling this again after a crash or a client
 * retry can never cause a double submission.
 */
export async function enqueueSubmissions(submissionIds: string[]) {
  if (submissionIds.length === 0) return;
  await getQueue().addBulk(
    submissionIds.map((submissionId) => ({
      name: "submit",
      data: { submissionId },
      opts: {
        jobId: submissionId,
        attempts: MAX_ATTEMPTS,
        backoff: { type: "custom" },
        removeOnComplete: { age: 24 * 3600 },
        removeOnFail: { age: 7 * 24 * 3600 },
      },
    })),
  );
}

/**
 * Exponential backoff with full jitter: 1s, 2s, 4s, 8s... capped at 30s,
 * each randomised so 1,000 failed jobs don't all retry in the same instant.
 * If the lender told us when to come back (Retry-After), we listen.
 */
export function backoffMs(attemptsMade: number, retryAfterMs?: number) {
  if (retryAfterMs && retryAfterMs > 0) return retryAfterMs;
  const ceiling = Math.min(1000 * 2 ** Math.max(attemptsMade - 1, 0), 30_000);
  return Math.round(ceiling / 2 + Math.random() * (ceiling / 2));
}