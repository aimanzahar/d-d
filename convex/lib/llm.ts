// LLM gateway access (OpenAI-compatible) via plain fetch — runs in
// Convex's V8 runtime. No SDK: smoke-tested directly.

export const GM_MODEL = "grok-4.3";
export const EMBEDDING_MODEL = "gemini-embedding-2-preview";
export const EMBEDDING_DIM = 3072;
// qwen-image-2.0 (accelerated): ~7s vs gpt-image-2's ~48s at
// 1536x1024 on this gateway. Returns data[0].url (not b64) — see lib/imageGen.ts.
export const IMAGE_MODEL = "qwen-image-2.0-2026-03-03";

// Gateway model limits: grok-4.3 has a large (500K-class) context window;
// output is capped at 15K (plenty for narration and structured side-channels).
// NOTE: the gateway's "grok-4.2-fast" route does NOT support tool calls —
// probed 2026-06-12; grok-4.3 streams them correctly.
// gemini-embedding-2-preview accepts 8,192-token inputs.
export const MAX_OUTPUT_TOKENS = 15_000;
export const EMBED_CHAR_BUDGET = 24_000; // ~6K tokens, safe under the 8,192 cap

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env var ${name} (set with npx convex env set)`);
  return value;
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  { attempts = 3, timeoutMs = 90_000 }: { attempts?: number; timeoutMs?: number } = {},
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) {
      const backoff = 1000 * 4 ** (attempt - 1) + Math.random() * 1000;
      await new Promise((r) => setTimeout(r, backoff));
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      if (RETRYABLE.has(res.status) && attempt < attempts - 1) {
        lastError = new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
        continue;
      }
      return res;
    } catch (e) {
      lastError = e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
};

export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type ToolDef = {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

export type StreamResult = {
  content: string;
  toolCalls: ToolCall[];
  finishReason: string;
};

// Streams a chat completion. Invokes onText with each content delta as it
// arrives (the caller throttles flushes to the message doc). Tool-call deltas
// are accumulated internally (fragments keyed by index) and returned whole.
export async function chatStream(opts: {
  messages: ChatMessage[];
  tools?: ToolDef[];
  toolChoice?: "auto" | "none";
  maxTokens: number;
  temperature?: number;
  onText: (delta: string) => Promise<void>;
  timeoutMs?: number;
}): Promise<StreamResult> {
  const res = await fetchWithRetry(
    `${env("LLM_BASE_URL")}/chat/completions`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env("LLM_API_KEY")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: GM_MODEL,
        stream: true,
        max_tokens: opts.maxTokens,
        temperature: opts.temperature ?? 0.85,
        messages: opts.messages,
        ...(opts.tools && opts.tools.length > 0
          ? { tools: opts.tools, tool_choice: opts.toolChoice ?? "auto" }
          : {}),
      }),
    },
    { timeoutMs: opts.timeoutMs ?? 90_000 },
  );
  if (!res.ok || !res.body) {
    throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let content = "";
  let finishReason = "";
  const partial: { id?: string; name?: string; args: string }[] = [];

  const handleLine = async (line: string) => {
    if (!line.startsWith("data: ")) return;
    const data = line.slice(6).trim();
    if (!data || data === "[DONE]") return;
    let json: any;
    try {
      json = JSON.parse(data);
    } catch {
      return; // malformed keep-alive lines etc.
    }
    const choice = json.choices?.[0];
    if (!choice) return;
    if (choice.delta?.content) {
      content += choice.delta.content;
      await opts.onText(choice.delta.content);
    }
    for (const tc of choice.delta?.tool_calls ?? []) {
      const slot = (partial[tc.index] ??= { args: "" });
      if (tc.id) slot.id = tc.id;
      if (tc.function?.name) slot.name = (slot.name ?? "") + tc.function.name;
      if (tc.function?.arguments) slot.args += tc.function.arguments;
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop()!;
    for (const line of lines) await handleLine(line);
  }
  // Flush the decoder and process any trailing buffered line (the final
  // finish_reason chunk often lives here — learned in the Phase 0 smoke test).
  buf += decoder.decode();
  for (const line of buf.split("\n")) await handleLine(line);

  const toolCalls: ToolCall[] = partial
    .filter((p) => p.name)
    .map((p, i) => ({
      id: p.id ?? `call_${i}`,
      type: "function" as const,
      function: { name: p.name!, arguments: p.args },
    }));
  if (!finishReason) finishReason = toolCalls.length > 0 ? "tool_calls" : "stop";
  return { content, toolCalls, finishReason };
}

// Non-streaming structured-output call. Used by the memorizer and other
// structured side-channels — never for live narration. The gateway has no
// upstream supporting strict `json_schema` for this model (it answers 429
// "group saturated"), so we use plain json_object mode with the schema
// embedded in the prompt and parse defensively.
export async function chatJson<T>(opts: {
  messages: ChatMessage[];
  schemaName: string;
  schema: Record<string, unknown>;
  maxTokens?: number;
  temperature?: number;
}): Promise<T> {
  const schemaNote = `Respond with ONLY a single JSON object matching this JSON Schema ("${opts.schemaName}") — no markdown fences, no commentary:\n${JSON.stringify(opts.schema)}`;
  const messages = [...opts.messages];
  const last = messages[messages.length - 1];
  if (last?.role === "user") {
    messages[messages.length - 1] = { ...last, content: `${last.content}\n\n${schemaNote}` };
  } else {
    messages.push({ role: "user", content: schemaNote });
  }

  const res = await fetchWithRetry(`${env("LLM_BASE_URL")}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env("LLM_API_KEY")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: GM_MODEL,
      max_tokens: opts.maxTokens ?? MAX_OUTPUT_TOKENS,
      temperature: opts.temperature ?? 0.3,
      messages,
      response_format: { type: "json_object" },
    }),
  });
  if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  const text: string | undefined = json.choices?.[0]?.message?.content;
  if (!text) throw new Error("LLM returned no content for JSON call");
  // Belt and braces: some models fence the JSON anyway
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  return JSON.parse(stripped) as T;
}

// Batch-embeds texts. Returns one EMBEDDING_DIM vector per input.
export async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const res = await fetchWithRetry(`${env("LLM_BASE_URL")}/embeddings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env("LLM_API_KEY")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: texts }),
  });
  if (!res.ok) throw new Error(`Embeddings ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  const data = json.data as { index: number; embedding: number[] }[];
  const out: number[][] = new Array(texts.length);
  for (const d of data) out[d.index] = d.embedding;
  return out;
}
