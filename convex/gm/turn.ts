// The GM turn: claim → context → stream with tools → finalize → drain queue.

import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction, internalMutation } from "../_generated/server";
import {
  chatStream,
  embed,
  EMBED_CHAR_BUDGET,
  MAX_OUTPUT_TOKENS,
  type ChatMessage,
  type StreamResult,
  type ToolCall,
} from "../lib/llm";
import { search } from "../lib/qdrant";
import { BASE_PROMPT, COMBAT_ADDENDUM, EXPLORATION_ADDENDUM } from "./prompt";
import { dispatchTool, TOOL_DEFS } from "./tools";

const MAX_ITERATIONS = 6;
const TURN_DEADLINE_MS = 7 * 60 * 1000;
const FLUSH_CHARS = 300;
const FLUSH_MS = 250;
// Reasoning tokens count against max_tokens, so give the model its full
// output limit — it's a cap, not a target; chain-of-thought never starves
// the narration itself.
const GM_MAX_TOKENS = MAX_OUTPUT_TOKENS;

// Verifies this scheduled run still owns the lock (kills stale duplicates).
export const claimTurn = internalMutation({
  args: { campaignId: v.id("campaigns"), generation: v.number() },
  handler: async (ctx, args) => {
    const campaign = await ctx.db.get(args.campaignId);
    return !!campaign && campaign.gm.status === "running" && campaign.gm.generation === args.generation;
  },
});

// Releases the lock; if new unprocessed messages queued up during the turn,
// keeps it and reports the next generation to run.
export const finishTurn = internalMutation({
  args: { campaignId: v.id("campaigns"), generation: v.number() },
  handler: async (ctx, args) => {
    const campaign = await ctx.db.get(args.campaignId);
    if (!campaign || campaign.gm.generation !== args.generation) return { continue: false };
    const pending = await ctx.db
      .query("messages")
      .withIndex("by_campaign_unprocessed", (q) =>
        q.eq("campaignId", args.campaignId).eq("processed", false),
      )
      .first();
    if (pending) {
      const generation = args.generation + 1;
      await ctx.db.patch(args.campaignId, {
        gm: { status: "running", startedAt: Date.now(), generation },
      });
      return { continue: true, generation };
    }
    await ctx.db.patch(args.campaignId, {
      gm: { status: "idle", generation: args.generation },
    });
    return { continue: false };
  },
});

export const releaseOnError = internalMutation({
  args: { campaignId: v.id("campaigns"), generation: v.number() },
  handler: async (ctx, args) => {
    const campaign = await ctx.db.get(args.campaignId);
    if (!campaign || campaign.gm.generation !== args.generation) return;
    await ctx.db.patch(args.campaignId, {
      gm: { status: "idle", generation: args.generation },
    });
    await ctx.db.insert("messages", {
      campaignId: args.campaignId,
      kind: "system",
      content: "The GM lost their train of thought. Speak again to wake them.",
      status: "complete",
      ooc: false,
      processed: true,
    });
  },
});

export const respond = internalAction({
  args: { campaignId: v.id("campaigns"), generation: v.number() },
  handler: async (ctx, args) => {
    const owns = await ctx.runMutation(internal.gm.turn.claimTurn, args);
    if (!owns) return;

    const startedAt = Date.now();
    let gmMessageId: any = null;

    try {
      const context = await ctx.runQuery(internal.gm.context.getContext, {
        campaignId: args.campaignId,
      });
      if (!context) throw new Error("campaign vanished");
      if (context.unprocessedIds.length > 0) {
        await ctx.runMutation(internal.messages.markProcessed, {
          messageIds: context.unprocessedIds,
        });
      }

      // RAG: campaign memories + 5e rules, degraded to empty on any failure
      let memoryBlock = "";
      try {
        if (context.newActionsText) {
          const [vector] = await embed([
            `${context.newActionsText}\n(at ${context.locationName})`.slice(0, EMBED_CHAR_BUDGET),
          ]);
          const [memories, rules] = await Promise.all([
            search({ vector, campaignId: args.campaignId, kinds: ["scene", "npc", "lore"], limit: 6 }),
            search({ vector, campaignId: "global", kinds: ["rule"], limit: 3 }),
          ]);
          const memoryLines = memories
            .filter((h) => h.score > 0.45)
            .map((h) => `[${h.payload.kind}] ${h.payload.text}`);
          const ruleLines = rules
            .filter((h) => h.score > 0.55)
            .map((h) => `[rule: ${h.payload.title}] ${h.payload.text.slice(0, 2000)}`);
          if (memoryLines.length > 0) {
            memoryBlock += `\n\n# RECALLED MEMORIES (older events that may be relevant)\n${memoryLines.join("\n")}`;
          }
          if (ruleLines.length > 0) {
            memoryBlock += `\n\n# RULES REFERENCE\n${ruleLines.join("\n")}`;
          }
        }
      } catch (error) {
        console.error("RAG degraded to empty:", error);
      }

      const addendum = context.mode === "combat" ? COMBAT_ADDENDUM : EXPLORATION_ADDENDUM;
      const transcript: ChatMessage[] = [
        { role: "system", content: `${BASE_PROMPT}\n\n${addendum}` },
        { role: "user", content: context.contextBlock + memoryBlock },
      ];

      // The GM narration message is created lazily — on the first real flush —
      // so in combat a creature's roll docs (inserted during tool execution)
      // sort BEFORE the narration that describes them. A pure-mechanical turn
      // with no prose creates no message at all.
      const isCombat = context.mode === "combat";
      let buffer = "";
      let lastFlush = Date.now();
      const ensureMessage = async () => {
        if (gmMessageId === null) {
          gmMessageId = await ctx.runMutation(internal.messages.createGmMessage, {
            campaignId: args.campaignId,
          });
        }
      };
      const flush = async (force = false) => {
        if (!buffer) return;
        if (!force && buffer.length < FLUSH_CHARS && Date.now() - lastFlush < FLUSH_MS) return;
        const chunk = buffer;
        buffer = "";
        lastFlush = Date.now();
        await ensureMessage();
        await ctx.runMutation(internal.messages.appendStreamChunk, {
          messageId: gmMessageId,
          campaignId: args.campaignId,
          chunk,
        });
      };

      const errorBudget = new Map<string, number>();
      let endTurn = false;
      let streamedChars = 0;
      let result: StreamResult | undefined;
      const maxIterations = isCombat ? 10 : MAX_ITERATIONS;
      const onText = async (delta: string) => {
        buffer += delta;
        // trim: a bare "\n" alongside a tool call is not narration
        streamedChars += delta.trim().length;
        // In combat, defer flushing until after the iteration's tools have run
        // (so narration lands below the dice); elsewhere stream live.
        if (!isCombat) await flush();
      };

      for (let iteration = 0; iteration < maxIterations && !endTurn; iteration++) {
        const overDeadline = Date.now() - startedAt > TURN_DEADLINE_MS;
        result = await chatStream({
          messages: transcript,
          tools: overDeadline ? undefined : TOOL_DEFS,
          maxTokens: GM_MAX_TOKENS,
          onText,
        });

        if (result.finishReason !== "tool_calls" || result.toolCalls.length === 0) break;

        transcript.push({
          role: "assistant",
          content: result.content || null,
          tool_calls: result.toolCalls,
        });

        let advancedTurn = false;
        for (const call of result.toolCalls) {
          const toolResult = await executeCall(ctx, args.campaignId, call, errorBudget);
          transcript.push({
            role: "tool",
            tool_call_id: call.id,
            content: JSON.stringify(toolResult),
          });
          if (
            call.function.name === "request_player_roll" &&
            (toolResult as any)?.ok === true
          ) {
            endTurn = true; // wait for the player's dice
          }
          if (call.function.name === "advance_turn" && (toolResult as any)?.ok === true) {
            advancedTurn = true; // one creature per response — stop after this
          }
        }

        // Combat: this response's rolls are now in — flush its narration below
        // them, then stop so the next creature is a fresh, separate turn.
        if (isCombat) await flush(true);
        if (advancedTurn) break;
      }

      // Reasoning models can burn the whole token budget on hidden
      // chain-of-thought and stream zero narration. Unless we're legitimately
      // waiting on a player's dice, retry once without tools so the turn
      // never ends in silence.
      if (streamedChars === 0 && !endTurn) {
        console.error(
          `GM produced no narration (finishReason=${result?.finishReason}); retrying without tools`,
        );
        // When the loop broke without tool calls the assistant turn was never
        // pushed — restore role alternation or strict backends reject the retry.
        if (result && (result.finishReason !== "tool_calls" || result.toolCalls.length === 0)) {
          transcript.push({ role: "assistant", content: result.content || "(no narration)" });
        }
        transcript.push({
          role: "user",
          content:
            "(Your previous reply contained no narration text. Respond now with in-world narration for the player. Do not call tools.)",
        });
        await chatStream({ messages: transcript, maxTokens: GM_MAX_TOKENS, onText });
      }

      await flush(true);
      // A silent dice-wait (endTurn) is healthy — the roll prompt is up and
      // the feed's ghost guard drops the empty row; only true silence errors.
      // gmMessageId is null when a turn was pure mechanics with no prose.
      if (gmMessageId !== null) {
        await ctx.runMutation(internal.messages.finalizeGmMessage, {
          messageId: gmMessageId,
          status: streamedChars > 0 || endTurn ? "complete" : "error",
        });
      }

      // Combat safety net: if a monster is still the active combatant after
      // the GM finished (and we're not waiting on a player roll), the engine
      // advances the turn itself so the fight never stalls. Checked on every
      // turn — context.mode is a stale snapshot when start_combat ran mid-
      // turn; the mutation self-guards on live state and queued work.
      if (!endTurn) {
        await ctx.runMutation(internal.combat.autoAdvanceIfMonsterStuck, {
          campaignId: args.campaignId,
        });
        // Pacing safety net: count quiet exploration turns; the mutation self-
        // guards on mode/progress and fires a one-shot complication directive at
        // the threshold so a dithering scene never grinds in place.
        await ctx.runMutation(internal.messages.tickStall, {
          campaignId: args.campaignId,
        });
      }

      // Fire-and-forget memorization — never extends or blocks the turn
      if (gmMessageId !== null) {
        await ctx.scheduler.runAfter(0, internal.gm.memory.memorizeTurn, {
          campaignId: args.campaignId,
          gmMessageId,
        });
      }

      const next = await ctx.runMutation(internal.gm.turn.finishTurn, args);
      if (next.continue) {
        await ctx.scheduler.runAfter(0, internal.gm.turn.respond, {
          campaignId: args.campaignId,
          generation: next.generation!,
        });
      }
    } catch (error) {
      console.error("GM turn failed:", error);
      if (gmMessageId) {
        await ctx.runMutation(internal.messages.finalizeGmMessage, {
          messageId: gmMessageId,
          status: "error",
        });
      }
      await ctx.runMutation(internal.gm.turn.releaseOnError, args);
    }
  },
});

async function executeCall(
  ctx: any,
  campaignId: any,
  call: ToolCall,
  errorBudget: Map<string, number>,
): Promise<unknown> {
  const name = call.function.name;
  if ((errorBudget.get(name) ?? 0) >= 2) {
    return { ok: false, error: `${name} is unavailable for the rest of this turn — narrate around it.` };
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(call.function.arguments || "{}");
  } catch {
    errorBudget.set(name, (errorBudget.get(name) ?? 0) + 1);
    return { ok: false, error: `Invalid JSON arguments for ${name}. Send a single valid JSON object.` };
  }
  try {
    const result = await dispatchTool(ctx, campaignId, name, parsed);
    if ((result as any)?.ok === false) {
      errorBudget.set(name, (errorBudget.get(name) ?? 0) + 1);
    }
    return result;
  } catch (error) {
    errorBudget.set(name, (errorBudget.get(name) ?? 0) + 1);
    return { ok: false, error: `${name} failed: ${String(error).slice(0, 200)}` };
  }
}
