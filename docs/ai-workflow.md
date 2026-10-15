
# How I built this with AI

I built Niyam in about a 2 days, mostly by directing AI rather than typing code. This page is an honest account of how: what the AI did, what I decided and checked, and where it was wrong.

## Setup

- **Claude** for architecture, code and tests. I worked in one long conversation: day by day, layer by layer.
- **OpenRouter** for the policy agent's model. That lets me swap models with a flag and compare them in the eval. The default is `openai/gpt-4o-mini`.
- **Neon** (Postgres), **Redis** in Docker, TypeScript, Fastify, BullMQ, Vitest.
- **The rule I worked by:** nothing counts as done until a test proves it. Every layer had passing tests before I moved to the next one, and I ran everything on my own machine, not just in the AI's sandbox.

## How the week went

| Phase | Layer | How it was verified |
|---|---|---|
| 1 | Rule DSL, 5 mock lenders with deliberate chaos, schema | Schema tests, seed validation |
| 2 | Rules engine, idempotent application API | 10 identical concurrent requests → exactly 1 application |
| 3 | Queue, adapters, retries, circuit breaker, webhooks | Load test: 40 applications through flaky lenders, zero lost or duplicated |
| 4 | Policy-to-rules agent with self-correcting validation loop | Fake-model tests for every failure mode |
| 5 | Human review UI, versioning, rollback, impact preview | Scripted browser test of the full approve flow |
| 6 | Eval harness, end-to-end demo | Real model runs, 3× each |

## What the AI did vs. what I decided

| AI did | I decided or verified |
|---|---|
| Wrote most of the code and tests | What to build: I chose the policy-to-rules angle because onboarding lenders looked like ClickPe's real bottleneck |
| Proposed the architecture | That the agent never writes live rules: a named human approves every version |
| Designed the mock lenders' bad behaviour | The trade-offs: Neon over local Postgres, OpenRouter over a single provider, gpt-4o-mini over pricier models once the eval showed it was enough |
| Wrote the eval harness | Ran the evals on real models, read the failures, and pushed for the fix |

## Bugs the AI wrote that tests caught

These are real. Each one was caught by a test or a check, not by luck.

1. **The annual-income hole.** The first validator only checked that monthly income was between ₹1k and ₹10L. That never catches the most likely mistake: "₹3.6 lakh per annum" used as if it were monthly, which sits comfortably inside that range. A test failed, and the fix reads the quoted text: if it says "per annum" and the number wasn't divided by 12, the model is told to fix it.
2. **The success message that vanished.** In the review UI, approving a version re-drew the panel *after* showing "v5 is live", silently erasing the confirmation. A scripted browser test found it; reading the code didn't.
3. **Diff noise.** The review screen showed `loan_amount [1L, 25L] → [1L, 25L]` as a change, because only the wording of the message differed. In a review tool, noise trains reviewers to stop reading, so I split it into "changed" (affects who qualifies) and "reworded" (cosmetic).
4. **Stale applicant messages.** A reviewer could change CIBIL from 750 to 755 and leave the message saying "750 or above", so a rejected applicant would be told the wrong reason. Approval now warns about it.
5. **The eval caught a real bug, and it was the important one.** On its first real run, gpt-4o-mini passed every "hard" trap (amendments, unit conversions, Hinglish) but got the "easy" part wrong:
   - It dropped "salaried only" from Suvidha's policy, so self-employed applicants would have been routed to a lender that rejects them.
   - It read "self-employed individuals and proprietors / business owners" as only `self_employed`. **In production, that would have rejected every shop owner from the lender built for shop owners**, who are exactly ClickPe's daily-repayment customers.

## Prompt iterations (from the eval)

The fix for bug 5 had two parts:
- **Prompt:** an explicit rule for mapping job descriptions to employment types (rule 7 in `src/agent/prompt.ts`).
- **Guardrail:** a coverage check in `src/agent/validate.ts`. If a policy mentions something, like "salaried", "CIBIL" or "age", but no rule uses it, the reviewer is warned. It's a warning rather than an error, because sometimes leaving it out is correct ("credit score not mandatory").

gpt-4o-mini via OpenRouter, 6 policy documents, 3 runs each (18 extractions):

| | Recall | Precision | Exact rulesets | Traps caught | Cost |
|---|---|---|---|---|---|
| Before (prompt v1) | 94% | 97% | 12/18 | 51/51 | $0.0083 |
| After | **100%** | **100%** | **18/18** | 51/51 | $0.0084 |

Results were identical across all 3 runs. A few extractions needed a second attempt; that's the validator rejecting the first answer and the model correcting itself, which is the system working as designed.

I also tried NVIDIA's free `nemotron-3.5-lightning`. It got every document it completed right, but took about 65 seconds per document versus about 5. So gpt-4o-mini stays the default, at under $0.001 per policy. For real lender policies, I'd use a paid endpoint with no data retention.

## What I learned

- **The hard-looking parts weren't where it failed.** The model handled amendments and Hinglish perfectly and tripped on job titles. I'd never have guessed that without an eval.
- **"The tests pass" and "it works" are different claims.** Two of the five bugs only showed up when something real ran: a browser and a real model.
- **AI is fast at writing code and bad at knowing what matters.** It took a human to see that "shop owners can't get the shop-owner loan" was the worst possible bug for this business.