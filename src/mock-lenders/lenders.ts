/**
 * Five fake lenders. Each one deliberately has a different API shape and
 * different bad behaviour, because that's what real lender integrations
 * look like. Adapters (Day 3) will hide these differences.
 */

export type Chaos = {
    minLatencyMs: number;
    maxLatencyMs: number;
    errorRate: number; // 0..1 chance of a 500
    rateLimitPerMinute: number; // beyond this, 429
    mode: "sync" | "async"; // async = 202 now, decision via webhook later
  };
  
  export type MockLender = {
    id: string;
    chaos: Chaos;
    // Translates this lender's request body into a common shape for its
    // internal decision. Every lender names fields differently.
    readRequest: (body: any) => { cibil: number | null; income: number; amount: number } | null;
    // Formats a decision in this lender's own response style.
    formatDecision: (d: { approved: boolean; ref: string; reason?: string; rate?: number }) => unknown;
  };
  
  const ref = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
  export const newRef = ref;
  
  export const MOCK_LENDERS: MockLender[] = [
    {
      // Clean, well-behaved JSON API. The "good" lender.
      id: "suvidha",
      chaos: { minLatencyMs: 100, maxLatencyMs: 400, errorRate: 0.02, rateLimitPerMinute: 60, mode: "sync" },
      readRequest: (b) =>
        b?.applicant ? { cibil: b.applicant.creditScore ?? null, income: b.applicant.monthlyIncome, amount: b.loan?.amount } : null,
      formatDecision: (d) => ({ status: d.approved ? "APPROVED" : "REJECTED", referenceId: d.ref, offeredRate: d.rate, reason: d.reason }),
    },
    {
      // snake_case, amounts in paise, flaky.
      id: "dhanrekha",
      chaos: { minLatencyMs: 300, maxLatencyMs: 1500, errorRate: 0.15, rateLimitPerMinute: 30, mode: "sync" },
      readRequest: (b) =>
        b?.cust_details ? { cibil: b.cust_details.bureau_score ?? null, income: b.cust_details.income_paise / 100, amount: b.req_amt_paise / 100 } : null,
      formatDecision: (d) => ({ resp_code: d.approved ? "00" : "05", resp_msg: d.approved ? "SANCTIONED" : "DECLINED", app_ref: d.ref, decline_reason: d.reason ?? null }),
    },
    {
      // Async: accepts with 202, sends the decision to a webhook later.
      id: "kirana-credit",
      chaos: { minLatencyMs: 200, maxLatencyMs: 600, errorRate: 0.05, rateLimitPerMinute: 20, mode: "async" },
      readRequest: (b) => (b?.borrower ? { cibil: b.borrower.score ?? null, income: b.borrower.income, amount: b.ask } : null),
      formatDecision: (d) => ({ event: "loan.decision", application_id: d.ref, decision: d.approved ? "approve" : "decline", note: d.reason }),
    },
    {
      // Strict rate limit, slow, always returns HTTP 200 even on rejection.
      id: "metro-bank",
      chaos: { minLatencyMs: 800, maxLatencyMs: 2500, errorRate: 0.05, rateLimitPerMinute: 5, mode: "sync" },
      readRequest: (b) => (b?.Applicant ? { cibil: b.Applicant.CIBIL ?? null, income: b.Applicant.Income, amount: b.LoanAmount } : null),
      formatDecision: (d) => ({ Success: true, Data: { Approved: d.approved, CaseNo: d.ref, Remarks: d.reason ?? "OK" } }),
    },
    {
      // Very flaky and occasionally hangs for ~8s (tests your timeouts).
      id: "pragati",
      chaos: { minLatencyMs: 200, maxLatencyMs: 8000, errorRate: 0.25, rateLimitPerMinute: 40, mode: "sync" },
      readRequest: (b) => (b?.mobile && b?.income ? { cibil: b.cibil ?? null, income: b.income, amount: b.amount } : null),
      formatDecision: (d) => ({ ok: d.approved, id: d.ref, msg: d.reason ?? "approved" }),
    },
  ];