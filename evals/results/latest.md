# Policy-to-rules agent: eval results

2026-10-14 · 6 extractions per model (1 run(s) × 6 documents)

| Model | Valid | First try | Recall | Precision | Exact rulesets | Traps caught | Avg time | Cost |
|---|---|---|---|---|---|---|---|---|
| `nvidia/nemotron-3.5-lightning:free` | 0/6 | 0% | 0% | 0% | 0/6 | 0/17 | 0s | $0.0000 |

**Recall**: of the rules a human wrote, how many the agent got exactly right. **Precision**: of the rules the agent produced, how many were right. **Traps**: the specific hard parts of each document (amendments, unit conversions, Hinglish, tables).

## Per document

| Model | Document | Valid | Attempts | Rules | Rate | Traps | Problems |
|---|---|---|---|---|---|---|---|
| `nvidia/nemotron-3.5-lightning:free` | suvidha.pdf | ✗ | 0 | 0/6 | ✗ | 0/3 | error: OpenRouter 429 for model "nvidia/nemotron-3.5-lightning:free": {"error":{"message":"Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day","code":429,"met |
| `nvidia/nemotron-3.5-lightning:free` | dhanrekha.pdf | ✗ | 0 | 0/5 | ✗ | 0/3 | error: OpenRouter 429 for model "nvidia/nemotron-3.5-lightning:free": {"error":{"message":"Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day","code":429,"met |
| `nvidia/nemotron-3.5-lightning:free` | kirana-credit.pdf | ✗ | 0 | 0/5 | ✗ | 0/3 | error: OpenRouter 429 for model "nvidia/nemotron-3.5-lightning:free": {"error":{"message":"Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day","code":429,"met |
| `nvidia/nemotron-3.5-lightning:free` | metro-bank.pdf | ✗ | 0 | 0/5 | ✗ | 0/2 | error: OpenRouter 429 for model "nvidia/nemotron-3.5-lightning:free": {"error":{"message":"Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day","code":429,"met |
| `nvidia/nemotron-3.5-lightning:free` | pragati.pdf | ✗ | 0 | 0/4 | ✗ | 0/3 | error: OpenRouter 429 for model "nvidia/nemotron-3.5-lightning:free": {"error":{"message":"Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day","code":429,"met |
| `nvidia/nemotron-3.5-lightning:free` | metro-bank-v2.pdf | ✗ | 0 | 0/5 | ✗ | 0/3 | error: OpenRouter 429 for model "nvidia/nemotron-3.5-lightning:free": {"error":{"message":"Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day","code":429,"met |
