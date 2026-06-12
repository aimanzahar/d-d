import { internalAction, internalMutation } from "./_generated/server";
import { v } from "convex/values";

// Phase 0 smoke test: validates every external integration from inside the
// Convex V8 runtime (the same runtime the GM loop will run in).
// Run with: npx convex run smoke:run
export const run = internalAction({
  args: {},
  handler: async (ctx) => {
    const results: Record<string, unknown> = {};
    const base = process.env.LLM_BASE_URL!;
    const key = process.env.LLM_API_KEY!;
    const qdrantUrl = process.env.QDRANT_URL!;
    const qdrantKey = process.env.QDRANT_API_KEY!;

    // 1. deepseek-v4-pro: streamed chat with a tool call (SSE reading in V8)
    try {
      const res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "deepseek-v4-pro",
          stream: true,
          max_tokens: 200,
          messages: [
            {
              role: "system",
              content:
                "You are a dice-rolling assistant. Always use the roll_dice tool when asked to roll.",
            },
            { role: "user", content: "Roll 2d6+3 for my damage roll." },
          ],
          tools: [
            {
              type: "function",
              function: {
                name: "roll_dice",
                description: "Roll dice using standard notation",
                parameters: {
                  type: "object",
                  properties: {
                    notation: { type: "string", description: "e.g. 2d6+3" },
                    purpose: { type: "string" },
                  },
                  required: ["notation"],
                },
              },
            },
          ],
        }),
      });
      if (!res.ok || !res.body) {
        results.chatStream = { ok: false, status: res.status, body: (await res.text()).slice(0, 300) };
      } else {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        let chunks = 0;
        let content = "";
        let finishReason = "";
        const toolCalls: { name?: string; args: string }[] = [];
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop()!;
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const data = line.slice(6).trim();
            if (data === "[DONE]") continue;
            chunks++;
            const json = JSON.parse(data);
            const choice = json.choices?.[0];
            if (!choice) continue;
            if (choice.delta?.content) content += choice.delta.content;
            for (const tc of choice.delta?.tool_calls ?? []) {
              toolCalls[tc.index] ??= { args: "" };
              if (tc.function?.name) toolCalls[tc.index].name = tc.function.name;
              if (tc.function?.arguments) toolCalls[tc.index].args += tc.function.arguments;
            }
            if (choice.finish_reason) finishReason = choice.finish_reason;
          }
        }
        results.chatStream = {
          ok: chunks > 1 && finishReason === "tool_calls" && toolCalls[0]?.name === "roll_dice",
          chunks,
          finishReason,
          toolCalls,
          content: content.slice(0, 100),
        };
      }
    } catch (e) {
      results.chatStream = { ok: false, error: String(e) };
    }

    // 2. gemini-embedding-2-preview embeddings
    try {
      const res = await fetch(`${base}/embeddings`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gemini-embedding-2-preview",
          input: ["a goblin ambush", "a peaceful tavern evening"],
        }),
      });
      const json = await res.json();
      results.embeddings = json.data
        ? { ok: true, count: json.data.length, dims: json.data[0].embedding.length }
        : { ok: false, body: JSON.stringify(json).slice(0, 300) };
    } catch (e) {
      results.embeddings = { ok: false, error: String(e) };
    }

    // 3. Qdrant REST round-trip on a throwaway collection
    try {
      const qh = { "api-key": qdrantKey, "Content-Type": "application/json" };
      const col = "smoke_test_dnd";
      await fetch(`${qdrantUrl}/collections/${col}`, { method: "DELETE", headers: qh });
      const create = await fetch(`${qdrantUrl}/collections/${col}`, {
        method: "PUT",
        headers: qh,
        body: JSON.stringify({ vectors: { size: 8, distance: "Cosine" } }),
      });
      const vec = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];
      const pointId = crypto.randomUUID();
      const upsert = await fetch(`${qdrantUrl}/collections/${col}/points?wait=true`, {
        method: "PUT",
        headers: qh,
        body: JSON.stringify({
          points: [{ id: pointId, vector: vec, payload: { campaignId: "smoke", kind: "scene", text: "hello" } }],
        }),
      });
      const search = await fetch(`${qdrantUrl}/collections/${col}/points/query`, {
        method: "POST",
        headers: qh,
        body: JSON.stringify({ query: vec, limit: 1, with_payload: true }),
      });
      const searchJson = await search.json();
      const hit = searchJson.result?.points?.[0];
      await fetch(`${qdrantUrl}/collections/${col}`, { method: "DELETE", headers: qh });
      results.qdrant = {
        ok: create.ok && upsert.ok && hit?.payload?.text === "hello",
        createStatus: create.status,
        upsertStatus: upsert.status,
        hitScore: hit?.score,
        hitPayload: hit?.payload,
      };
    } catch (e) {
      results.qdrant = { ok: false, error: String(e) };
    }

    // 4. Convex file storage: store → getUrl (must be a publicly reachable URL)
    try {
      const blob = new Blob([new TextEncoder().encode("dnd smoke test")], { type: "text/plain" });
      const storageId = await ctx.storage.store(blob);
      const url = await ctx.storage.getUrl(storageId);
      results.storage = { ok: !!url, storageId, url };
    } catch (e) {
      results.storage = { ok: false, error: String(e) };
    }

    // 5. gpt-image-2 generation → storage (full image pipeline)
    try {
      const res = await fetch(`${base}/images/generations`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-image-2",
          prompt: "A tiny red twenty-sided die resting on aged parchment, warm candlelight, simple still life",
          n: 1,
          size: "1024x1024",
          quality: "low",
          format: "webp",
        }),
      });
      const json = await res.json();
      const b64 = json.data?.[0]?.b64_json;
      if (!b64) {
        results.image = { ok: false, status: res.status, body: JSON.stringify(json).slice(0, 400) };
      } else {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const storageId = await ctx.storage.store(new Blob([bytes], { type: "image/webp" }));
        const url = await ctx.storage.getUrl(storageId);
        results.image = { ok: !!url, bytes: bytes.length, storageId, url };
      }
    } catch (e) {
      results.image = { ok: false, error: String(e) };
    }

    return results;
  },
});

// Test helper: simulate a crashed GM turn (stale lock + orphaned stream).
export const simulateCrashedGm = internalMutation({
  args: { campaignId: v.id("campaigns") },
  handler: async (ctx, args) => {
    const campaign = await ctx.db.get(args.campaignId);
    if (!campaign) return "no campaign";
    await ctx.db.patch(args.campaignId, {
      gm: {
        status: "running",
        startedAt: Date.now() - 10 * 60 * 1000, // 10 min ago = very stale
        generation: campaign.gm.generation + 1,
      },
    });
    const orphanId = await ctx.db.insert("messages", {
      campaignId: args.campaignId,
      kind: "gm",
      content: "The torchlight flickers as",
      status: "streaming",
      ooc: false,
      processed: true,
    });
    return { orphanId, generation: campaign.gm.generation + 1 };
  },
});

// Test helper: instantly slay a monster by label.
export const slayMonster = internalMutation({
  args: { label: v.string() },
  handler: async (ctx, args) => {
    const monsters = await ctx.db.query("monsters").collect();
    const target = monsters.find((m) => m.label === args.label && !m.isDead);
    if (!target) return "not found";
    await ctx.db.patch(target._id, { currentHp: 0, isDead: true });
    return `${target.label} slain`;
  },
});

export const woundMonster = internalMutation({
  args: { label: v.string(), hp: v.number() },
  handler: async (ctx, args) => {
    const monsters = await ctx.db.query("monsters").collect();
    const target = monsters.find((m) => m.label === args.label && !m.isDead);
    if (!target) return "not found";
    await ctx.db.patch(target._id, { currentHp: args.hp });
    return `${target.label} at ${args.hp} HP`;
  },
});

// Accounts prereq: prove PBKDF2 via crypto.subtle works on this self-hosted
// backend build and measure cost at 600k iterations. Run: npx convex run smoke:pbkdf2
export const pbkdf2 = internalAction({
  args: {},
  handler: async () => {
    const salt = new Uint8Array(16);
    crypto.getRandomValues(salt);
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("smoke-test-password"),
      "PBKDF2",
      false,
      ["deriveBits"],
    );
    const t0 = Date.now();
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", iterations: 600_000, salt },
      key,
      256,
    );
    return { ok: bits.byteLength === 32, ms: Date.now() - t0 };
  },
});
