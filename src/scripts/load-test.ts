import { randomUUID } from "node:crypto";

/**
 * Fires N applications at the API, waits, then reports what happened.
 * With chaos on, you'll see retries, rate limits and circuit breakers at work.
 *   npx tsx scripts/load-test.ts 40
 */
const API = process.env.API_URL ?? "http://localhost:3000";
const N = Number(process.argv[2] ?? 30);

const cities = ["pune", "mumbai", "indore", "ashta", "bengaluru", "bhopal"];
const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];
const pan = () => "ABCDE" + String(1000 + Math.floor(Math.random() * 8999)) + "F";

function randomProfile() {
  const business = Math.random() < 0.4;
  return {
    name: "Load Test", phone: "9" + String(Math.floor(1e8 + Math.random() * 9e8)), pan: pan(),
    age: 22 + Math.floor(Math.random() * 35), city: pick(cities),
    employment_type: business ? "business_owner" : "salaried",
    business_vintage_months: business ? 6 + Math.floor(Math.random() * 60) : undefined,
    monthly_income: 15000 + Math.floor(Math.random() * 90000),
    existing_emi: Math.floor(Math.random() * 15000),
    cibil_score: Math.random() < 0.15 ? null : 650 + Math.floor(Math.random() * 200),
    loan_amount: business ? 50000 + Math.floor(Math.random() * 200000) : 100000 + Math.floor(Math.random() * 900000),
  };
}

const ids: string[] = [];
await Promise.all(
  Array.from({ length: N }, async () => {
    const res = await fetch(`${API}/applications`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": randomUUID() },
      body: JSON.stringify(randomProfile()),
    });
    if (res.ok) ids.push((await res.json()).id);
  }),
);
console.log(`created ${ids.length} applications, waiting 45s for lenders...`);
await new Promise((r) => setTimeout(r, 45_000));

const appStatus: Record<string, number> = {};
const subStatus: Record<string, number> = {};
let retried = 0;
for (const id of ids) {
  const a = await (await fetch(`${API}/applications/${id}`)).json();
  appStatus[a.status] = (appStatus[a.status] ?? 0) + 1;
  for (const s of a.submissions) {
    subStatus[s.status] = (subStatus[s.status] ?? 0) + 1;
    if (s.attempts > 1) retried++;
  }
}
console.log("applications:", appStatus);
console.log("submissions: ", subStatus);
console.log("submissions that needed retries:", retried);
console.log("circuits:    ", await (await fetch(`${API}/admin/circuits`)).json());