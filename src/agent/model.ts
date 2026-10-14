import { SUBMIT_TOOL } from "./prompt.js";

/**
 * OpenRouter speaks the OpenAI chat-completions format, so these are the
 * OpenAI message shapes. Any OpenRouter model that supports tool calling works.
 */
export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type AssistantMessage = { role: "assistant"; content: string | null; tool_calls?: ToolCall[] };
export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | AssistantMessage
  | { role: "tool"; tool_call_id: string; content: string };

export type Usage = { promptTokens: number; completionTokens: number; cost: number };
export type ModelReply = { message: AssistantMessage; usage?: Usage };

/** Anything that can answer a conversation. Tests pass a fake one. */
export type Model = { name: string; call: (messages: ChatMessage[]) => Promise<ModelReply> };

export const DEFAULT_MODEL = process.env.OPENROUTER_MODEL ?? "openai/gpt-4o-mini";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function openRouterModel(opts: { model?: string; apiKey?: string; baseUrl?: string; timeoutMs?: number } = {}): Model {
  const name = opts.model ?? DEFAULT_MODEL;
  const baseUrl = opts.baseUrl ?? process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";
  const timeoutMs = opts.timeoutMs ?? 120_000;

  return {
    name,
    async call(messages) {
      const apiKey = opts.apiKey ?? process.env.OPENROUTER_API_KEY;
      if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set. Add it to .env (openrouter.ai/keys).");

      // OpenRouter itself can rate-limit or have a bad upstream; retry those twice.
      for (let attempt = 1; ; attempt++) {
        const res = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
            "x-title": "Niyam", // shows up in your OpenRouter dashboard
          },
          body: JSON.stringify({
            model: name,
            messages,
            tools: [SUBMIT_TOOL],
            tool_choice: { type: "function", function: { name: SUBMIT_TOOL.function.name } }, // force structured output
            temperature: 0,
            max_tokens: 8000,
            usage: { include: true }, // ask OpenRouter to report cost
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });

        if ((res.status === 429 || res.status >= 500) && attempt < 3) {
          await sleep(2000 * attempt);
          continue;
        }
        const text = await res.text();
        if (!res.ok) throw new Error(`OpenRouter ${res.status} for model "${name}": ${text.slice(0, 400)}`);

        const data = JSON.parse(text);
        if (data.error) throw new Error(`OpenRouter error for model "${name}": ${JSON.stringify(data.error).slice(0, 400)}`);
        const msg = data.choices?.[0]?.message;
        if (!msg) throw new Error(`OpenRouter returned no message: ${text.slice(0, 300)}`);

        return {
          message: { role: "assistant", content: msg.content ?? null, tool_calls: msg.tool_calls?.length ? msg.tool_calls : undefined },
          usage: data.usage
            ? { promptTokens: data.usage.prompt_tokens ?? 0, completionTokens: data.usage.completion_tokens ?? 0, cost: Number(data.usage.cost ?? 0) }
            : undefined,
        };
      }
    },
  };
}