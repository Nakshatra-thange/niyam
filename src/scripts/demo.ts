import "dotenv/config";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";

/**
 * The whole story, end to end, against the running servers:
 *   a lender changes its policy -> agent reads the PDF -> human approves ->
 *   an applicant who was rejected an hour ago now gets routed and submitted.
 *
 *   npm run demo            # pauses so you can approve in the review UI (best for the video)
 *   npm run demo -- --yes   # approves automatically
 *   npm run demo -- --reset # puts Metro back on its original rules so you can run it again
 */
const API = process.env.API_URL ?? "http://localhost:3000";
const { values } = parseArgs({ options: { yes: { type: "boolean", default: false }, reset: { type: "boolean", default: false } } });
const headers = { "x-admin-token": process.env.ADMIN_TOKEN ?? "", "x-reviewer": "demo" };

const c = { dim: (s: string) => `\x1b[2m${s}\x1b[0m`, bold: (s: string) => `\x1b[1m${s}\x1b[0m`, green: (s: string) => `\x1b[32m${s}\x1b[0m`, red: (s: string) => `\x1b[31m${s}\x1b[0m`, yellow: (s: string) => `\x1b[33m${s}\x1b[0m` };
const step = (n: number, s: string) => console.log(`\n${c.bold(`${n}. ${s}`)}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(`${API}${path}`, { ...init, headers: { ...headers, ...(init.headers as Record<string, string>) } });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) {
    console.error(c.red("401 from the API: set ADMIN_TOKEN in .env to the same value the API server uses."));
    process.exit(1);
  }
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} → ${res.status}: ${JSON.stringify(body).slice(0, 400)}`);
  return body;
}
const post = (path: string, body: unknown, extra: Record<string, string> = {}) =>
  api(path, { method: "POST", headers: { "content-type": "application/json", ...extra }, body: JSON.stringify(body) });

const metroVersions = async () => (await api("/admin/rulesets")).filter((r: any) => r.lender_id === "metro-bank");

if (values.reset) {
  const versions = await metroVersions();
  const original = versions.find((v: any) => v.source === "manual");
  if (original && original.status !== "active") {
    await post(`/admin/rulesets/${original.id}/rollback`, { note: "demo reset" });
    console.log(`Metro is back on v${original.version} (original rules).`);
  } else console.log("Metro is already on its original rules.");
  process.exit(0);
}

const priya = {
  name: "Priya Sharma", phone: "9988776655", pan: "AAAPL1234C", age: 29, city: "Indore", employment_type: "salaried",
  monthly_income: 45000, existing_emi: 9000, cibil_score: 760, loan_amount: 300000,
};
const t0 = Date.now();

await api("/health").catch(() => {
  console.error(c.red(`API not reachable at ${API}. Start: npm run dev:lenders, npm run dev:api, npm run dev:worker`));
  process.exit(1);
});

step(1, "Priya applies from Indore (CIBIL 760, ₹45k/month)");
const before = await post("/eligibility", priya);
const metroBefore = before.ineligible.find((d: any) => d.lenderId === "metro-bank");
console.log(`   Eligible: ${before.eligible.map((d: any) => `${d.lenderName} (${d.interestRate})`).join(", ") || "none"}`);
if (metroBefore) console.log(`   ${c.red("✗ Metro Small Finance Bank")} — ${metroBefore.reasons.join("; ")}`);

step(2, "Metro SFB sends a revised credit policy (PDF). The agent reads it.");
const pdf = readFileSync("policies/metro-bank-v2.pdf");
const tUpload = Date.now();
const draft = await api(`/admin/policies?lender=metro-bank&filename=metro-bank-v2.pdf`, { method: "POST", headers: { "content-type": "application/pdf" }, body: pdf });
console.log(`   Draft v${draft.version} in ${((Date.now() - tUpload) / 1000).toFixed(1)}s, ${draft.attempts} attempt(s), $${Number(draft.usage.cost).toFixed(4)}`);
draft.warnings.forEach((w: string) => console.log(c.yellow(`   ⚠ ${w}`)));

step(3, "What would change?");
const detail = await api(`/admin/rulesets/${draft.id}`);
const d = detail.diffVsActive;
d?.changed.forEach((x: any) => console.log(`   ~ ${x.after.field}: ${JSON.stringify(x.before.value)} → ${JSON.stringify(x.after.value)}`));
d?.added.forEach((x: any) => console.log(c.green(`   + ${x.field} ${x.op} ${JSON.stringify(x.value)}`)));
d?.removed.forEach((x: any) => console.log(c.red(`   − ${x.field} ${x.op} ${JSON.stringify(x.value)}`)));
if (d?.reworded.length) console.log(c.dim(`   · ${d.reworded.length} rule message(s) reworded, values unchanged`));
if (d?.rate) console.log(`   ~ rate: ${d.rate.before.join("–")}% → ${d.rate.after.join("–")}%`);
const impact = await api(`/admin/rulesets/${draft.id}/impact`);
console.log(`   Impact on last ${impact.sampled} applicants: ${c.green(`+${impact.gained} gain access`)}, ${c.red(`−${impact.lost} lose it`)}`);

step(4, "A human reviews and approves");
if (values.yes) {
  const ok = await post(`/admin/rulesets/${draft.id}/approve`, {});
  console.log(`   Approved via API: v${ok.version} live, replacing v${ok.replaced?.version}`);
} else {
  console.log(`   Open ${c.bold(`${API}/review`)}, check the highlighted citations, and approve v${draft.version}.`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  for (;;) {
    await rl.question("   Press Enter once approved… ");
    const v = (await metroVersions()).find((r: any) => r.id === draft.id);
    if (v?.status === "active") break;
    console.log(c.yellow(`   v${draft.version} is still ${v?.status}.`));
  }
  rl.close();
}

step(5, "Priya applies again");
const app = await post("/applications", priya, { "idempotency-key": randomUUID() });
const top = app.routing.eligible[0];
console.log(`   Ranked: ${app.routing.eligible.map((d: any, i: number) => `${i + 1}. ${d.lenderName} (${d.interestRate})`).join("  ")}`);
if (top?.lenderId === "metro-bank") console.log(c.green(`   ✓ Metro SFB is now her cheapest option`));

process.stdout.write("   Waiting for lenders");
let final: any;
for (let i = 0; i < 30; i++) {
  await sleep(1000);
  process.stdout.write(".");
  final = await api(`/applications/${app.id}`);
  if (!final.submissions.some((s: any) => ["queued", "sending", "pending_decision"].includes(s.status))) break;
}
console.log("");
for (const s of final.submissions) {
  const mark = s.status === "approved" ? c.green("✓") : s.status === "rejected" ? c.red("✗") : c.yellow("…");
  console.log(`   ${mark} ${s.lender_id.padEnd(14)} ${s.status}${s.offered_rate ? ` at ${s.offered_rate}%` : ""}${s.reason ? c.dim(` (${s.reason})`) : ""}${s.attempts > 1 ? c.dim(` after ${s.attempts} attempts`) : ""}`);
}

console.log(`\n${c.bold(`Policy PDF → live routing → lender decision in ${((Date.now() - t0) / 1000).toFixed(0)}s.`)} ${c.dim("Reset with: npm run demo -- --reset")}`);