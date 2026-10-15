# Policy-to-rules agent: eval results

2026-10-15 · 6 extractions per model (1 run(s) × 6 documents)

| Model | Valid | First try | Recall | Precision | Exact rulesets | Traps caught | Avg time | Cost |
|---|---|---|---|---|---|---|---|---|
| `openai/gpt-4o-mini` | 6/6 | 83% | 94% | 97% | 4/6 | 17/17 | 9.56s | $0.0031 |

**Recall**: of the rules a human wrote, how many the agent got exactly right. **Precision**: of the rules the agent produced, how many were right. **Traps**: the specific hard parts of each document (amendments, unit conversions, Hinglish, tables).

## Per document

| Model | Document | Valid | Attempts | Rules | Rate | Traps | Problems |
|---|---|---|---|---|---|---|---|
| `openai/gpt-4o-mini` | suvidha.pdf | ✓ | 1 | 5/6 | ✓ | 3/3 | missing employment_type\|in\|["salaried"] |
| `openai/gpt-4o-mini` | dhanrekha.pdf | ✓ | 1 | 5/5 | ✓ | 3/3 | — |
| `openai/gpt-4o-mini` | kirana-credit.pdf | ✓ | 1 | 4/5 | ✓ | 3/3 | wrong employment_type\|in\|["business_owner","self_employed"]  ≠  employment_type\|in\|["self_employed"]<br>extra employment_type\|in\|["self_employed"] |
| `openai/gpt-4o-mini` | metro-bank.pdf | ✓ | 2 | 5/5 | ✓ | 2/2 | — |
| `openai/gpt-4o-mini` | pragati.pdf | ✓ | 1 | 4/4 | ✓ | 3/3 | — |
| `openai/gpt-4o-mini` | metro-bank-v2.pdf | ✓ | 1 | 5/5 | ✓ | 3/3 | — |
