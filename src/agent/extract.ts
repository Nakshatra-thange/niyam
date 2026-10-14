import Anthropic from "@anthropic-ai/sdk";
import { documentMessage, SUBMIT_TOOL, SYSTEM_PROMPT } from "./prompt.js";
import { validateExtraction, type Extraction, type ValidationResult } from "./validate.js";

export const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5";
const MAX_ATTEMPTS = 3;

/** The one call we make to the model. Injected so tests can use a fake. */
export type ModelFn = (req: { system: string; messages: Anthropic.MessageParam[] }) => Promise<{ content: Anthropic.ContentBlock[] }>;

export function anthropicModel(): ModelFn {
  const client = new Anthropic(); // reads ANTHROPIC_API_KEY
  return (req) =>
    client.messages.create({
      model: MODEL,
      max_tokens: 8000,
      temperature: 0, // same document -> same rules, as far as possible
      system: req.system,
      messages: req.messages,
      tools: [SUBMIT_TOOL as unknown as Anthropic.Tool],
      tool_choice: { type: "tool", name: SUBMIT_TOOL.name }, // forces structured output
    });
}

export type ExtractionReport = {
  ok: boolean;
  attempts: number;
  model: string;
  result: ValidationResult;
  raw?: Extraction;
  history: { attempt: number; errors: string[] }[];
};

/**
 * Extract -> validate -> if invalid, show the model its exact errors and let
 * it fix them. This loop is the "agent": it checks its own work against the
 * source document instead of trusting its first answer.
 */
export async function extractRuleset(opts: { pages: string[]; lenderId: string; model: ModelFn; onAttempt?: (n: number, errors: string[]) => void }): Promise<ExtractionReport> {
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: documentMessage(opts.pages, opts.lenderId) }];
  const history: ExtractionReport["history"] = [];
  let last: ValidationResult = { ok: false, errors: ["model was never called"], warnings: [] };
  let raw: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await opts.model({ system: SYSTEM_PROMPT, messages });
    const toolUse = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (!toolUse) {
      last = { ok: false, errors: ["model did not call submit_ruleset"], warnings: [] };
      history.push({ attempt, errors: last.errors });
      messages.push({ role: "assistant", content: res.content }, { role: "user", content: "Call the submit_ruleset tool with your result." });
      continue;
    }

    raw = toolUse.input;
    last = validateExtraction(raw, opts.pages, opts.lenderId);
    history.push({ attempt, errors: last.errors });
    opts.onAttempt?.(attempt, last.errors);
    if (last.ok) break;

    // Hand the errors back as the tool result and ask for a corrected submission.
    messages.push(
      { role: "assistant", content: res.content },
      {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: toolUse.id,
          is_error: true,
          content: `Validation failed. Fix ONLY these problems, keep everything else, and call submit_ruleset again:\n- ${last.errors.join("\n- ")}`,
        }],
      },
    );
  }

  return { ok: last.ok, attempts: history.length, model: MODEL, result: last, raw: raw as Extraction, history };
}