import type { ExtractionReport } from "../src/agent/extract.js";
import { canonical, type EvalCase } from "./cases.js";

export type CaseScore = {
  case: string; // file name
  lenderId: string;
  model: string;
  ok: boolean; // passed validation (within 3 attempts)
  firstTry: boolean;
  attempts: number;
  durationMs: number;
  cost: number;
  tokens: number;
  expected: number;
  matched: number;
  precision: number; // of the rules it produced, how many were right
  recall: number; // of the rules it should have produced, how many it did
  rateCorrect: boolean;
  traps: { name: string; passed: boolean }[];
  missing: string[];
  wrong: string[];
  extra: string[];
  error?: string;
};

const r2 = (n: number) => Math.round(n * 100) / 100;

export function scoreCase(c: EvalCase, report: ExtractionReport | null, error?: string): CaseScore {
  const base = {
    case: c.file.split("/").pop()!, lenderId: c.lenderId, model: report?.model ?? "?",
    attempts: report?.attempts ?? 0, durationMs: report?.durationMs ?? 0, cost: report?.usage.cost ?? 0,
    tokens: (report?.usage.promptTokens ?? 0) + (report?.usage.completionTokens ?? 0), expected: c.expected.rules.length,
  };
  const rs = report?.result.ruleset;
  if (!report || !report.ok || !rs) {
    return {
      ...base, ok: false, firstTry: false, matched: 0, precision: 0, recall: 0, rateCorrect: false,
      traps: c.traps.map((t) => ({ name: t.name, passed: false })), missing: c.expected.rules.map((r) => canonical(r)), wrong: [], extra: [],
      error: error ?? report?.result.errors.slice(0, 3).join(" | ") ?? "unknown",
    };
  }

  const got = new Map(rs.rules.map((r) => [canonical(r), r]));
  const expectedKeys = c.expected.rules.map((r) => canonical(r));
  const matched = expectedKeys.filter((k) => got.has(k));
  const missing = expectedKeys.filter((k) => !got.has(k));

  // A "wrong" rule = right field, wrong value. Distinguish it from a missing one.
  const wrong: string[] = [];
  for (const k of missing) {
    const field = k.split("|")[0];
    const sameField = rs.rules.find((r) => r.field === field && !expectedKeys.includes(canonical(r)));
    if (sameField) wrong.push(`${k}  ≠  ${canonical(sameField)}`);
  }
  const extras = [...got.keys()].filter((k) => !expectedKeys.includes(k));
  const counted = extras.filter((k) => !c.tolerateExtraOn?.includes(k.split("|")[0] as any));
  const produced = matched.length + counted.length;

  return {
    ...base,
    ok: true,
    firstTry: report.attempts === 1,
    matched: matched.length,
    precision: r2(produced ? matched.length / produced : 0),
    recall: r2(matched.length / expectedKeys.length),
    rateCorrect: Math.abs(rs.interestRateMin - c.expected.interestRateMin) < 0.01 && Math.abs(rs.interestRateMax - c.expected.interestRateMax) < 0.01,
    traps: c.traps.map((t) => ({ name: t.name, passed: t.check(rs) })),
    missing: missing.filter((k) => !wrong.some((w) => w.startsWith(k))),
    wrong,
    extra: extras,
  };
}

export type ModelSummary = {
  model: string;
  cases: number;
  passedValidation: number;
  firstTryRate: number;
  recall: number;
  precision: number;
  exactRulesets: number; // every rule + rate exactly right
  trapsPassed: number;
  trapsTotal: number;
  avgSeconds: number;
  totalCost: number;
};

export function summarize(model: string, scores: CaseScore[]): ModelSummary {
  const n = scores.length || 1;
  const avg = (f: (s: CaseScore) => number) => r2(scores.reduce((a, s) => a + f(s), 0) / n);
  return {
    model,
    cases: scores.length,
    passedValidation: scores.filter((s) => s.ok).length,
    firstTryRate: avg((s) => (s.firstTry ? 1 : 0)),
    recall: avg((s) => s.recall),
    precision: avg((s) => s.precision),
    exactRulesets: scores.filter((s) => s.ok && s.recall === 1 && s.precision === 1 && s.rateCorrect).length,
    trapsPassed: scores.reduce((a, s) => a + s.traps.filter((t) => t.passed).length, 0),
    trapsTotal: scores.reduce((a, s) => a + s.traps.length, 0),
    avgSeconds: r2(scores.reduce((a, s) => a + s.durationMs, 0) / n / 1000),
    totalCost: Math.round(scores.reduce((a, s) => a + s.cost, 0) * 10000) / 10000,
  };
}

export function toMarkdown(summaries: ModelSummary[], scores: CaseScore[], meta: { date: string; runs: number }): string {
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const lines = [
    `# Policy-to-rules agent: eval results`,
    ``,
    `${meta.date} · ${scores.length / Math.max(summaries.length, 1)} extractions per model (${meta.runs} run(s) × ${scores.length / Math.max(summaries.length, 1) / meta.runs} documents)`,
    ``,
    `| Model | Valid | First try | Recall | Precision | Exact rulesets | Traps caught | Avg time | Cost |`,
    `|---|---|---|---|---|---|---|---|---|`,
    ...summaries.map((s) =>
      `| \`${s.model}\` | ${s.passedValidation}/${s.cases} | ${pct(s.firstTryRate)} | ${pct(s.recall)} | ${pct(s.precision)} | ${s.exactRulesets}/${s.cases} | ${s.trapsPassed}/${s.trapsTotal} | ${s.avgSeconds}s | $${s.totalCost.toFixed(4)} |`),
    ``,
    `**Recall**: of the rules a human wrote, how many the agent got exactly right. **Precision**: of the rules the agent produced, how many were right. **Traps**: the specific hard parts of each document (amendments, unit conversions, Hinglish, tables).`,
    ``,
    `## Per document`,
    ``,
    `| Model | Document | Valid | Attempts | Rules | Rate | Traps | Problems |`,
    `|---|---|---|---|---|---|---|---|`,
    ...scores.map((s) => {
      const problems = s.error ? `error: ${s.error}` : [...s.wrong.map((w) => `wrong ${w}`), ...s.missing.map((m) => `missing ${m}`), ...s.extra.map((e) => `extra ${e}`), ...s.traps.filter((t) => !t.passed).map((t) => `trap: ${t.name}`)].join("<br>") || "—";
      return `| \`${s.model}\` | ${s.case} | ${s.ok ? "✓" : "✗"} | ${s.attempts} | ${s.matched}/${s.expected} | ${s.rateCorrect ? "✓" : "✗"} | ${s.traps.filter((t) => t.passed).length}/${s.traps.length} | ${problems.replace(/\|/g, "\\|")} |`;
    }),
    ``,
  ];
  return lines.join("\n");
}