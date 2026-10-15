# Niyam

**Onboard a lender's credit policy in minutes, not sprints.**

A loan marketplace routes every applicant to the lenders most likely to approve them. That depends on each lender's eligibility rules, which arrive as PDFs and change often. Turning them into code is slow and error-prone, and a wrong rule means wasted leads and rejected customers.

Niyam does two things:

1. **Policy → rules agent.** Upload a lender's policy PDF. An LLM extracts eligibility rules; every rule must cite the exact text it came from, and a validator rejects anything it can't verify against the document. A human reviews, sees the impact on recent applicants, and approves. Routing changes immediately.
2. **Routing and submission backend.** Ranks lenders per applicant with plain-English reasons, submits to the top N through per-lender adapters, and survives flaky lender APIs: retries with jittered backoff, per-lender circuit breakers, rate-limit handling, signed async webhooks, idempotency end to end.

> Built as a demo project. All lenders, policies and applicants are fictional.

## The demo in one command

```bash
npm run demo
```

Priya (Indore, CIBIL 760) applies and Metro SFB rejects her: wrong city, score too low. Metro then sends a revised policy PDF. The agent extracts the new rules with citations, the reviewer sees "+5 recent applicants gain access, 0 lose it" and approves, and Priya applies again. Metro is now her cheapest option, and the application is submitted through Metro's (mock) API.

## Agent eval results

2026-10-15 · 18 extractions per model (3 run(s) × 6 documents)

| Model | Valid | First try | Recall | Precision | Exact rulesets | Traps caught | Avg time | Cost |
|---|---|---|---|---|---|---|---|---|
| `openai/gpt-4o-mini` | 18/18 | 89% | 100% | 100% | 18/18 | 51/51 | 5.32s | $0.0084 |

**Recall**: of the rules a human wrote, how many the agent got exactly right. **Precision**: of the rules the agent produced, how many were right. **Traps**: the specific hard parts of each document (amendments, unit conversions, Hinglish, tables).

## Per document

| Model | Document | Valid | Attempts | Rules | Rate | Traps | Problems |
|---|---|---|---|---|---|---|---|
| `openai/gpt-4o-mini` | suvidha.pdf | ✓ | 1 | 6/6 | ✓ | 3/3 | — |
| `openai/gpt-4o-mini` | dhanrekha.pdf | ✓ | 1 | 5/5 | ✓ | 3/3 | extra employment_type\|in\|["salaried","self_employed"] |
| `openai/gpt-4o-mini` | kirana-credit.pdf | ✓ | 1 | 5/5 | ✓ | 3/3 | — |
| `openai/gpt-4o-mini` | metro-bank.pdf | ✓ | 2 | 5/5 | ✓ | 2/2 | — |
| `openai/gpt-4o-mini` | pragati.pdf | ✓ | 1 | 4/4 | ✓ | 3/3 | — |
| `openai/gpt-4o-mini` | metro-bank-v2.pdf | ✓ | 1 | 5/5 | ✓ | 3/3 | — |
| `openai/gpt-4o-mini` | suvidha.pdf | ✓ | 1 | 6/6 | ✓ | 3/3 | — |
| `openai/gpt-4o-mini` | dhanrekha.pdf | ✓ | 1 | 5/5 | ✓ | 3/3 | extra employment_type\|in\|["salaried","self_employed"] |
| `openai/gpt-4o-mini` | kirana-credit.pdf | ✓ | 1 | 5/5 | ✓ | 3/3 | — |
| `openai/gpt-4o-mini` | metro-bank.pdf | ✓ | 2 | 5/5 | ✓ | 2/2 | — |
| `openai/gpt-4o-mini` | pragati.pdf | ✓ | 1 | 4/4 | ✓ | 3/3 | — |
| `openai/gpt-4o-mini` | metro-bank-v2.pdf | ✓ | 1 | 5/5 | ✓ | 3/3 | — |
| `openai/gpt-4o-mini` | suvidha.pdf | ✓ | 1 | 6/6 | ✓ | 3/3 | — |
| `openai/gpt-4o-mini` | dhanrekha.pdf | ✓ | 1 | 5/5 | ✓ | 3/3 | extra employment_type\|in\|["salaried","self_employed"] |
| `openai/gpt-4o-mini` | kirana-credit.pdf | ✓ | 1 | 5/5 | ✓ | 3/3 | — |
| `openai/gpt-4o-mini` | metro-bank.pdf | ✓ | 1 | 5/5 | ✓ | 2/2 | — |
| `openai/gpt-4o-mini` | pragati.pdf | ✓ | 1 | 4/4 | ✓ | 3/3 | — |
| `openai/gpt-4o-mini` | metro-bank-v2.pdf | ✓ | 1 | 5/5 | ✓ | 3/3 | — |

Six policy documents with deliberate traps: an annexure amendment that overrides an earlier clause, annual income that must be converted to monthly, Hinglish phrasing, interest quoted per month, "credit score not mandatory", operating states that must *not* become city rules.

## Architecture

```
 Policy PDF ─► extract text ─► LLM (OpenRouter, forced tool call) ─► validator ─┐
                                   ▲                                           │ errors fed back
                                   └──────────── up to 3 attempts ◄────────────┘
                                                                               │ valid
                                            human review UI (diff, impact) ◄───┘ DRAFT
                                                        │ approve
                                                        ▼
 Applicant ─► POST /applications ─► rules engine (ACTIVE rules) ─► top N lenders
   (Idempotency-Key)                                                  │
                                         Postgres: application + submissions (one tx)
                                                                      │ enqueue after commit
                                         BullMQ worker ─► circuit breaker ─► lender adapter ─► lender API
                                                                      │                           │
                                         sync decision ◄──────────────┘     async webhook (HMAC) ─┘
```

| Concern | How |
|---|---|
| Never submit twice | `Idempotency-Key` + unique constraint; job id = submission id; worker skips finished submissions |
| Crash between DB commit and enqueue | Sweeper re-enqueues stuck submissions every minute (safe: enqueue is idempotent) |
| Flaky lenders | Timeouts, exponential backoff with jitter, `Retry-After` respected, 429s don't trip the breaker |
| Lender down | Redis circuit breaker shared by all workers; open → jobs delayed without burning retries; half-open → one probe |
| Async lenders | HMAC-verified, deduplicated webhooks; early webhooks reconciled when the worker catches up |
| LLM hallucinations | Every rule cites a quote that must exist on that page; unit/range checks; amendment double-counting detected |
| LLM mistakes that pass validation | Human approval required; impact preview; every edit recorded as agent-output vs approved diff |
| Bad rules in production | Versioned rulesets, one active per lender (DB-enforced), one-click rollback, full event log |
| Audit | Every application stores the exact ruleset versions used to route it |
| PII | PAN masked in API responses; impact preview never exposes names |

## Run it

Requires Node 20+, a Postgres URL (Neon free tier works), Docker for Redis, and an OpenRouter key.

```bash
cp .env.example .env               # fill in DATABASE_URL, OPENROUTER_API_KEY, ADMIN_TOKEN
npm install
docker compose up -d               # Redis
npm run db:migrate && npm run db:seed
npm run policies:pdf               # generates the policy PDFs
npm test                           # 58 tests

# three terminals
npm run dev:lenders                # 5 mock lenders with chaos (latency, 500s, 429s, async)
npm run dev:api                    # http://localhost:3000/review
npm run dev:worker

npm run demo
npm run eval -- --models nvidia/nemotron-3.5-lightning:free,openai/gpt-4.1-mini
npm run load-test -- 40
```

## What's deliberately out of scope

Real lender integrations, auth beyond an admin token, OCR for scanned PDFs, rules that need data we don't collect (job tenure, GST registration). The agent flags those for the human instead of guessing.

## How this was built

With AI, deliberately. See [docs/ai-workflow.md](docs/ai-workflow.md) for the workflow and the bugs AI introduced that tests caught.