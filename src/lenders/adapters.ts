import type { ApplicantProfile } from "../rules/schema.js";

/**
 * One adapter per lender. Each turns our unified profile into that lender's
 * request format, and turns its response (or webhook) back into one Outcome.
 * Everything lender-specific lives here and nowhere else.
 */

export type Outcome =
  | { kind: "approved"; ref: string; rate?: number }
  | { kind: "rejected"; ref?: string; reason: string }
  | { kind: "pending"; ref: string }; // async lender: decision comes by webhook

/** Worth trying again later: timeouts, 5xx, 429, network errors. */
export class RetryableError extends Error {
  constructor(message: string, public retryAfterMs?: number, public countsAsFailure = true) {
    super(message);
  }
}
/** Retrying won't help: 4xx, a response we can't understand. */
export class FatalError extends Error {}

export type LenderAdapter = {
  id: string;
  buildRequest: (p: ApplicantProfile) => unknown;
  parseResponse: (status: number, body: any) => Outcome;
  parseWebhook?: (body: any) => { ref: string; outcome: Outcome };
};

const unexpected = (lender: string, body: unknown) =>
  new FatalError(`${lender}: unexpected response ${JSON.stringify(body).slice(0, 200)}`);

export const ADAPTERS: Record<string, LenderAdapter> = {
  suvidha: {
    id: "suvidha",
    buildRequest: (p) => ({
      applicant: { name: p.name, mobile: p.phone, pan: p.pan, creditScore: p.cibil_score, monthlyIncome: p.monthly_income, age: p.age, city: p.city, employmentType: p.employment_type },
      loan: { amount: p.loan_amount, tenureMonths: 36 },
    }),
    parseResponse: (_s, b) => {
      if (b?.status === "APPROVED") return { kind: "approved", ref: b.referenceId, rate: b.offeredRate };
      if (b?.status === "REJECTED") return { kind: "rejected", ref: b.referenceId, reason: b.reason ?? "Rejected" };
      throw unexpected("suvidha", b);
    },
  },

  dhanrekha: {
    id: "dhanrekha",
    // This lender wants money in paise and snake_case everything.
    buildRequest: (p) => ({
      cust_details: { full_name: p.name, mob_no: p.phone, pan_no: p.pan, bureau_score: p.cibil_score, income_paise: Math.round(p.monthly_income * 100) },
      req_amt_paise: Math.round(p.loan_amount * 100),
    }),
    parseResponse: (_s, b) => {
      if (b?.resp_code === "00") return { kind: "approved", ref: b.app_ref };
      if (b?.resp_code === "05") return { kind: "rejected", ref: b.app_ref, reason: b.decline_reason ?? b.resp_msg };
      throw unexpected("dhanrekha", b);
    },
  },

  "kirana-credit": {
    id: "kirana-credit",
    buildRequest: (p) => ({
      borrower: { name: p.name, phone: p.phone, score: p.cibil_score, income: p.monthly_income, vintage_months: p.business_vintage_months ?? 0 },
      ask: p.loan_amount,
    }),
    parseResponse: (status, b) => {
      if (status === 202 && b?.application_id) return { kind: "pending", ref: b.application_id };
      throw unexpected("kirana-credit", b);
    },
    parseWebhook: (b) => {
      if (b?.event !== "loan.decision" || !b.application_id) throw unexpected("kirana-credit webhook", b);
      const ref = b.application_id;
      return { ref, outcome: b.decision === "approve" ? { kind: "approved", ref } : { kind: "rejected", ref, reason: b.note ?? "Declined" } };
    },
  },

  "metro-bank": {
    id: "metro-bank",
    // Always answers HTTP 200; the real result is buried in Data.Approved.
    buildRequest: (p) => ({
      Applicant: { Name: p.name, Mobile: p.phone, PAN: p.pan, CIBIL: p.cibil_score, Income: p.monthly_income, City: p.city },
      LoanAmount: p.loan_amount,
    }),
    parseResponse: (_s, b) => {
      if (b?.Success !== true || typeof b?.Data?.Approved !== "boolean") throw unexpected("metro-bank", b);
      return b.Data.Approved ? { kind: "approved", ref: b.Data.CaseNo } : { kind: "rejected", ref: b.Data.CaseNo, reason: b.Data.Remarks };
    },
  },

  pragati: {
    id: "pragati",
    buildRequest: (p) => ({ mobile: p.phone, name: p.name, income: p.monthly_income, cibil: p.cibil_score, amount: p.loan_amount, city: p.city }),
    parseResponse: (_s, b) => {
      if (typeof b?.ok !== "boolean" || !b.id) throw unexpected("pragati", b);
      return b.ok ? { kind: "approved", ref: b.id } : { kind: "rejected", ref: b.id, reason: b.msg };
    },
  },
};