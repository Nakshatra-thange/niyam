import type pg from "pg";
import type { Outcome } from "../lenders/adapters.js";

const TERMINAL = ["approved", "rejected", "failed"];

/**
 * Records a lender's decision on a submission. Safe to call twice with the
 * same decision (a retried job, a duplicate webhook): once a submission is
 * terminal, later updates are ignored.
 */
export async function applyOutcome(c: pg.PoolClient, submissionId: string, outcome: Outcome, source: "sync" | "webhook") {
  const status = outcome.kind === "pending" ? "pending_decision" : outcome.kind;
  const { rows } = await c.query(
    `UPDATE submissions
        SET status = $2, lender_ref = COALESCE($3, lender_ref), offered_rate = $4, reason = $5, last_error = NULL, updated_at = now()
      WHERE id = $1 AND status <> ALL($6)
      RETURNING application_id, lender_id`,
    [submissionId, status, "ref" in outcome ? outcome.ref ?? null : null, outcome.kind === "approved" ? outcome.rate ?? null : null,
     outcome.kind === "rejected" ? outcome.reason : null, TERMINAL],
  );
  if (!rows[0]) return false; // already terminal: nothing to do

  await c.query(`INSERT INTO audit_log (application_id, event, data) VALUES ($1, $2, $3)`, [
    rows[0].application_id, `lender.${status}`, { lenderId: rows[0].lender_id, source, outcome },
  ]);
  await recomputeApplicationStatus(c, rows[0].application_id);
  return true;
}

export async function markSubmissionFailed(c: pg.PoolClient, submissionId: string, error: string) {
  const { rows } = await c.query(
    `UPDATE submissions SET status = 'failed', last_error = $2, updated_at = now()
      WHERE id = $1 AND status <> ALL($3) RETURNING application_id, lender_id`,
    [submissionId, error, TERMINAL],
  );
  if (!rows[0]) return;
  await c.query(`INSERT INTO audit_log (application_id, event, data) VALUES ($1, 'lender.failed', $2)`, [
    rows[0].application_id, { lenderId: rows[0].lender_id, error },
  ]);
  await recomputeApplicationStatus(c, rows[0].application_id);
}

/**
 * Application status follows its submissions:
 *   any approved            -> approved  (user has at least one offer)
 *   any still in flight     -> submitting
 *   all done, some rejected -> rejected
 *   all failed              -> failed    (lenders unreachable; worth a retry later)
 */
export async function recomputeApplicationStatus(c: pg.PoolClient, applicationId: string) {
  await c.query(
    `UPDATE applications a SET status = s.next, updated_at = now()
       FROM (
         SELECT CASE
           WHEN bool_or(status = 'approved') THEN 'approved'
           WHEN bool_or(status IN ('queued', 'sending', 'pending_decision')) THEN 'submitting'
           WHEN bool_or(status = 'rejected') THEN 'rejected'
           ELSE 'failed' END AS next
         FROM submissions WHERE application_id = $1
       ) s
      WHERE a.id = $1 AND a.status <> s.next`,
    [applicationId],
  );
}