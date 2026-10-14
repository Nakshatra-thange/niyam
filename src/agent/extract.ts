import { documentMessage, SUBMIT_TOOL, SYSTEM_PROMPT } from "./prompt.js";
import { validateExtraction, type Extraction, type ValidationResult } from "./validate.js";
import type { ChatMessage, Model, ToolCall, Usage } from "./model.js";

const MAX_ATTEMPTS = 3;

/** The one call we make to the model when using function-style models (e.g. Anthropic/tests). */
export type ModelFn = (req: { system: string; messages: any[] }) => Promise<{ content: any[] }>;

export type ExtractionReport = {
  ok: boolean;
  attempts: number;
  model: string;
  result: ValidationResult;
  raw?: Extraction;
  history: { attempt: number; errors: string[] }[];
  usage: Usage;
  durationMs: number;
};

/** Some models ignore tool_choice and reply with JSON in plain text. Accept that too. */
function jsonFromText(text: string | null): unknown | undefined {
  if (!text) return undefined;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

/**
 * Extract -> validate -> if invalid, show the model its exact errors and let
 * it fix them. This loop is the "agent": it checks its own work against the
 * source document instead of trusting its first answer.
 */
export async function extractRuleset(opts: {
  pages: string[];
  lenderId: string;
  model: Model | ModelFn;
  onAttempt?: (n: number, errors: string[]) => void;
}): Promise<ExtractionReport> {
  const started = Date.now();

  if (typeof opts.model === "function") {
    const messages: any[] = [{ role: "user", content: documentMessage(opts.pages, opts.lenderId) }];
    const history: ExtractionReport["history"] = [];
    let last: ValidationResult = { ok: false, errors: ["model was never called"], warnings: [] };
    let raw: unknown;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const res = await opts.model({ system: SYSTEM_PROMPT, messages });
      const toolUse = res.content.find((b: any) => b.type === "tool_use");
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

    return {
      ok: last.ok,
      attempts: history.length,
      model: "claude-sonnet-5-5",
      result: last,
      raw: raw as Extraction,
      history,
      usage: { promptTokens: 0, completionTokens: 0, cost: 0 },
      durationMs: Date.now() - started,
    };
  }

  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: documentMessage(opts.pages, opts.lenderId) },
  ];
  const history: ExtractionReport["history"] = [];
  const usage: Usage = { promptTokens: 0, completionTokens: 0, cost: 0 };
  let last: ValidationResult = { ok: false, errors: ["model was never called"], warnings: [] };
  let raw: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const reply = await opts.model.call(messages);
    if (reply.usage) {
      usage.promptTokens += reply.usage.promptTokens;
      usage.completionTokens += reply.usage.completionTokens;
      usage.cost += reply.usage.cost;
    }
    messages.push(reply.message);

    const calls: ToolCall[] = reply.message.tool_calls ?? [];
    const submit = calls.find((c) => c.function.name === SUBMIT_TOOL.function.name);

    // Every tool call must get a tool response, or the next request is invalid.
    const respond = (text: string) => {
      if (calls.length === 0) {
        messages.push({ role: "user", content: text });
        return;
      }
      for (const c of calls) messages.push({ role: "tool", tool_call_id: c.id, content: c === submit ? text : "Ignored." });
    };

    let errors: string[];
    if (submit) {
      try {
        raw = JSON.parse(submit.function.arguments);
        last = validateExtraction(raw, opts.pages, opts.lenderId);
        errors = last.errors;
      } catch {
        errors = ["submit_ruleset arguments were not valid JSON"];
        last = { ok: false, errors, warnings: [] };
      }
    } else if ((raw = jsonFromText(reply.message.content)) !== undefined) {
      last = validateExtraction(raw, opts.pages, opts.lenderId);
      errors = last.errors;
    } else {
      errors = ["You did not call submit_ruleset"];
      last = { ok: false, errors, warnings: [] };
    }

    history.push({ attempt, errors });
    opts.onAttempt?.(attempt, errors);
    if (last.ok) break;

    respond(`Validation failed. Fix ONLY these problems, keep everything else, and call submit_ruleset again:\n- ${errors.join("\n- ")}`);
  }

  return {
    ok: last.ok,
    attempts: history.length,
    model: opts.model.name,
    result: last,
    raw: raw as Extraction,
    history,
    usage: { ...usage, cost: Math.round(usage.cost * 1e6) / 1e6 },
    durationMs: Date.now() - started,
  };
}