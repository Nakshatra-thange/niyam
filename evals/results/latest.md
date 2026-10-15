# Policy-to-rules agent: eval results

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
