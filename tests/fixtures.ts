import Fastify from "fastify";
import type { Model } from "../src/agent/model.js";

const cite = (page: number, quote: string) => ({ page, quote });

/** A correct agent answer for policies/metro-bank-v2.txt (quotes copied exactly). */
export const metroV2Extraction = () => ({
  lenderName: "Metro Small Finance Bank",
  interestRateMin: 10.75,
  interestRateMax: 16.5,
  rateCitation: cite(2, "Interest rates range from 10.75% to 16.50% per annum"),
  rules: [
    {
      id: "city-list", field: "city", op: "in",
      value: ["mumbai", "delhi", "bengaluru", "hyderabad", "pune", "chennai", "indore", "ahmedabad", "jaipur"],
      message: "Available in 9 cities including Indore, Ahmedabad and Jaipur",
      citation: cite(1, "the PPL programme is now offered in the following cities: Mumbai, Delhi, Bengaluru, Hyderabad, Pune, Chennai, Indore, Ahmedabad and Jaipur"),
    },
    { id: "cibil-min", field: "cibil_score", op: "gte", value: 750, message: "Requires a CIBIL score of 750 or above", citation: cite(1, "A minimum CIBIL score of 750 is required") },
    { id: "income-min", field: "monthly_income", op: "gte", value: 40000, message: "Requires monthly income of at least Rs. 40,000", citation: cite(1, "Minimum net monthly income: Rs. 40,000") },
    { id: "foir-max", field: "foir", op: "lte", value: 0.45, message: "Existing EMIs must be at most 45% of income", citation: cite(2, "shall not exceed 45%") },
    { id: "amount-range", field: "loan_amount", op: "between", value: [100000, 2500000], message: "Loan amount must be Rs. 1 lakh to Rs. 25 lakh", citation: cite(2, "Minimum loan amount Rs. 1,00,000; maximum loan amount Rs. 25,00,000") },
  ],
  unsupported_clauses: [
    { page: 2, quote: "sourcing is permitted only through bank branches and empanelled DSAs", why: "sourcing channel is not an applicant field" },
  ],
  ambiguities: [],
});

/** A model that always submits the same answer. */
export function fixedModel(answer: unknown): Model {
  let n = 0;
  return {
    name: "fixed-fake",
    call: async () => ({
      message: { role: "assistant", content: null, tool_calls: [{ id: `call_${++n}`, type: "function", function: { name: "submit_ruleset", arguments: JSON.stringify(answer) } }] },
      usage: { promptTokens: 2000, completionTokens: 600, cost: 0.012 },
    }),
  };
}

/**
 * A stand-in for OpenRouter's /chat/completions, so the real HTTP client can be
 * tested without a key. `respond` decides what each request gets back.
 */
export async function startMockOpenRouter(respond: (body: any, n: number) => { status?: number; json: unknown }) {
  const app = Fastify();
  const requests: { headers: Record<string, unknown>; body: any }[] = [];
  app.post("/api/v1/chat/completions", async (req, reply) => {
    requests.push({ headers: req.headers, body: req.body });
    const r = respond(req.body, requests.length);
    return reply.code(r.status ?? 200).send(r.json);
  });
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  return { baseUrl: `${address}/api/v1`, requests, close: () => app.close() };
}

/** An OpenAI-format completion that calls submit_ruleset with `args`. */
export const toolCallCompletion = (args: unknown, cost = 0.01) => ({
  id: "gen-1",
  choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "call_x", type: "function", function: { name: "submit_ruleset", arguments: JSON.stringify(args) } }] } }],
  usage: { prompt_tokens: 3000, completion_tokens: 700, cost },
});