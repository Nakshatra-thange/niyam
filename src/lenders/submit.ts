import { FatalError, RetryableError, type LenderAdapter, type Outcome } from "./adapters.js";
import type { ApplicantProfile } from "../rules/schema.js";

const LENDERS_BASE_URL = process.env.LENDERS_BASE_URL ?? "http://localhost:4000";
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL ?? "http://localhost:3000";
const TIMEOUT_MS = Number(process.env.LENDER_TIMEOUT_MS ?? 5000);

/**
 * Sends one application to one lender and classifies what happened.
 * The HTTP rules are the same for every lender; only parsing differs.
 */
export async function submitToLender(adapter: LenderAdapter, profile: ApplicantProfile, submissionId: string): Promise<Outcome> {
  let res: Response;
  try {
    res = await fetch(`${LENDERS_BASE_URL}/lenders/${adapter.id}/applications`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": submissionId, // a well-behaved lender dedupes our retries with this
        "x-callback-url": `${PUBLIC_BASE_URL}/webhooks/lenders/${adapter.id}`,
      },
      body: JSON.stringify(adapter.buildRequest(profile)),
      signal: AbortSignal.timeout(TIMEOUT_MS), // never wait forever on a hanging lender
    });
  } catch (err: any) {
    const reason = err?.name === "TimeoutError" ? `timeout after ${TIMEOUT_MS}ms` : `network error: ${err?.message}`;
    throw new RetryableError(reason);
  }

  if (res.status === 429) {
    const retryAfterSec = Number(res.headers.get("retry-after"));
    // Rate limiting is the lender asking us to slow down, not a sign it's broken,
    // so it doesn't count toward tripping the circuit breaker.
    throw new RetryableError("rate limited (429)", Number.isFinite(retryAfterSec) ? retryAfterSec * 1000 : undefined, false);
  }
  if (res.status >= 500) throw new RetryableError(`lender error ${res.status}`);

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new RetryableError(`unreadable response body (status ${res.status})`);
  }
  if (res.status >= 400) throw new FatalError(`lender rejected request ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);

  return adapter.parseResponse(res.status, body);
}