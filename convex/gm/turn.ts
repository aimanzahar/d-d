// The GM turn: claim → context → stream with tools → finalize → drain queue.

import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction, internalMutation } from "../_generated/server";
import { chatStream, type ChatMessage, type ToolCall } from "../lib/llm";
import { BASE_PROMPT, EXPLORATION_ADDENDUM } from "./prompt";
import { dispatchTool, TOOL_DEFS } from "./tools";

const MAX_ITERATIONS = 6;
const TURN_DEADLINE_MS = 7 * 60 * 1000;
const FLUSH_CHARS = 300;
const FLUSH_MS = 250;

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

      const transcript: ChatMessage[] = [
        { role: "system", content: `${BASE_PROMPT}\n\n${EXPLORATION_ADDENDUM}` },
        { role: "user", content: context.contextBlock },
      ];

      gmMessageId = await ctx.runMutation(internal.messages.createGmMessage, {
        campaignId: args.campaignId,
      });

      // Throttled append-only flushing into the message doc
      let buffer = "";
      let lastFlush = Date.now();
      const flush = async (force = false) => {
        if (!buffer) return;
        if (!force && buffer.length < FLUSH_CHARS && Date.now() - lastFlush < FLUSH_MS) return;
        const chunk = buffer;
        buffer = "";
        lastFlush = Date.now();
        await ctx.runMutation(internal.messages.appendStreamChunk, {
          messageId: gmMessageId,
          campaignId: args.campaignId,
          chunk,
        });
      };

      const errorBudget = new Map<string, number>();
      let endTurn = false;

      for (let iteration = 0; iteration < MAX_ITERATIONS && !endTurn; iteration++) {
        const overDeadline = Date.now() - startedAt > TURN_DEADLINE_MS;
        const result = await chatStream({
          messages: transcript,
          tools: overDeadline ? undefined : TOOL_DEFS,
          maxTokens: 900,
          onText: async (delta) => {
            buffer += delta;
            await flush();
          },
        });

        if (result.finishReason !== "tool_calls" || result.toolCalls.length === 0) break;

        transcript.push({
          role: "assistant",
          content: result.content || null,
          tool_calls: result.toolCalls,
        });

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
        }
      }

      await flush(true);
      await ctx.runMutation(internal.messages.finalizeGmMessage, {
        messageId: gmMessageId,
        status: "complete",
      });

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
