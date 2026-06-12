// Post-turn memorization: one structured LLM call distills the turn into a
// rewritten rolling summary + discrete memories, which are embedded and
// upserted to Qdrant. Fire-and-forget — errors never block the game.

import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { chatJson, embed } from "../lib/llm";
import { upsertPoints } from "../lib/qdrant";

const MEMORY_SCHEMA = {
  type: "object",
  properties: {
    updatedSummary: {
      type: "string",
      description:
        "The full story-so-far, rewritten to include this turn. Max 1500 characters. Past tense, names not pronouns, keep plot-critical facts and drop color.",
    },
    memories: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["scene", "npc", "lore"] },
          text: {
            type: "string",
            description: "One self-contained fact or scene beat, ≤40 words, names not pronouns",
          },
        },
        required: ["kind", "text"],
        additionalProperties: false,
      },
    },
  },
  required: ["updatedSummary", "memories"],
  additionalProperties: false,
};

export const getTurnDigest = internalQuery({
  args: { campaignId: v.id("campaigns"), gmMessageId: v.id("messages") },
  handler: async (ctx, args) => {
    const campaign = await ctx.db.get(args.campaignId);
    const gmMessage = await ctx.db.get(args.gmMessageId);
    if (!campaign || !gmMessage) return null;
    // The few messages leading up to this GM response (player actions, rolls)
    const recent = await ctx.db
      .query("messages")
      .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
      .order("desc")
      .take(16);
    const lead = recent
      .filter((m) => m._id !== args.gmMessageId && m._creationTime < gmMessage._creationTime)
      .reverse()
      .map((m) => `${m.characterName ?? m.kind}: ${m.content.slice(0, 1200)}`)
      .join("\n");
    return {
      summary: campaign.summary,
      location: campaign.location.name,
      lead,
      narration: gmMessage.content.slice(0, 16_000),
    };
  },
});

export const saveSummary = internalMutation({
  args: { campaignId: v.id("campaigns"), summary: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.campaignId, { summary: args.summary.slice(0, 8000) });
  },
});

export const memorizeTurn = internalAction({
  args: { campaignId: v.id("campaigns"), gmMessageId: v.id("messages") },
  handler: async (ctx, args) => {
    try {
      const digest = await ctx.runQuery(internal.gm.memory.getTurnDigest, args);
      if (!digest || digest.narration.length < 120) return; // nothing worth keeping

      const result = await chatJson<{
        updatedSummary: string;
        memories: { kind: "scene" | "npc" | "lore"; text: string }[];
      }>({
        schemaName: "turn_memory",
        schema: MEMORY_SCHEMA,
        // default cap = full model output limit — reasoning tokens count
        // against it, so a tight cap here starves the JSON just like turns
        messages: [
          {
            role: "system",
            content:
              "You are the memory-keeper for a D&D campaign. Rewrite the rolling summary to fold in the new turn, and extract durable facts as discrete memories (new NPCs and their dispositions, revealed lore, important scene beats). Record only NEW information not already in the summary.",
          },
          {
            role: "user",
            content: `CURRENT SUMMARY:\n${digest.summary || "(the story has just begun)"}\n\nLOCATION: ${digest.location}\n\nWHAT LED TO THIS TURN:\n${digest.lead || "(opening)"}\n\nGM NARRATION THIS TURN:\n${digest.narration}`,
          },
        ],
      });

      await ctx.runMutation(internal.gm.memory.saveSummary, {
        campaignId: args.campaignId,
        summary: result.updatedSummary,
      });

      const memories = (result.memories ?? []).filter((m) => m.text?.length > 10).slice(0, 8);
      if (memories.length > 0) {
        const vectors = await embed(memories.map((m) => m.text));
        await upsertPoints(
          memories.map((m, i) => ({
            id: crypto.randomUUID(),
            vector: vectors[i],
            payload: {
              campaignId: args.campaignId,
              kind: m.kind,
              text: m.text,
              createdAt: Date.now(),
            },
          })),
        );
      }
    } catch (error) {
      console.error("memorizeTurn failed (non-fatal):", error);
    }
  },
});
