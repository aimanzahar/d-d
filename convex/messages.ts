import { ConvexError, v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { internal } from "./_generated/api";
import { internalMutation, mutation, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { requirePlayer } from "./lib/auth";

const GM_STALE_MS = 120_000;

// The GM wake-up: claims the lock if free (or stale) and schedules a turn.
// Called by sendPlayerAction, roll fulfillment, and (later) combat advance.
export async function enqueueGm(ctx: MutationCtx, campaignId: Id<"campaigns">) {
  const campaign = await ctx.db.get(campaignId);
  if (!campaign || campaign.status !== "active") return;
  const stale =
    campaign.gm.status === "running" &&
    Date.now() - (campaign.gm.startedAt ?? 0) > GM_STALE_MS;
  if (campaign.gm.status === "idle" || stale) {
    const generation = campaign.gm.generation + 1;
    await ctx.db.patch(campaignId, {
      gm: { status: "running", startedAt: Date.now(), generation },
    });
    await ctx.scheduler.runAfter(0, internal.gm.turn.respond, {
      campaignId,
      generation,
    });
  }
  // Otherwise: the running turn's finishTurn drains the queue.
}

export const list = query({
  args: {
    sessionToken: v.string(),
    campaignId: v.id("campaigns"),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    await requirePlayer(ctx, args.sessionToken, args.campaignId);
    const page = await ctx.db
      .query("messages")
      .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
      .order("desc")
      .paginate(args.paginationOpts);
    // Join roll docs (with DC stripped while pending)
    const items = await Promise.all(
      page.page.map(async (m) => {
        const roll = m.rollId ? await ctx.db.get(m.rollId) : null;
        return {
          ...m,
          roll:
            roll && roll.visibility === "public"
              ? { ...roll, dc: roll.status === "rolled" ? roll.dc : undefined }
              : null,
        };
      }),
    );
    return { ...page, page: items };
  },
});

export const sendPlayerAction = mutation({
  args: {
    sessionToken: v.string(),
    campaignId: v.id("campaigns"),
    content: v.string(),
    ooc: v.boolean(),
  },
  handler: async (ctx, args) => {
    const player = await requirePlayer(ctx, args.sessionToken, args.campaignId);
    const campaign = await ctx.db.get(args.campaignId);
    if (!campaign) throw new ConvexError({ code: "campaign_not_found" });
    if (campaign.status !== "active") throw new ConvexError({ code: "not_started" });
    const content = args.content.trim().slice(0, 2000);
    if (!content) throw new ConvexError({ code: "empty" });

    const character = player.characterId ? await ctx.db.get(player.characterId) : null;

    // Combat gate: only the active combatant's words are actions; everyone
    // else is table talk (Phase 6 sets mode='combat').
    let ooc = args.ooc;
    if (campaign.mode === "combat" && !ooc) {
      const combat = campaign.activeCombatId ? await ctx.db.get(campaign.activeCombatId) : null;
      const active = combat?.initiative[combat.activeIndex];
      if (!active || active.refId !== String(player.characterId)) ooc = true;
    }

    await ctx.db.insert("messages", {
      campaignId: args.campaignId,
      kind: "player",
      playerId: player._id,
      characterName: character?.name ?? player.nickname,
      content,
      status: "complete",
      ooc,
      processed: ooc, // table talk never wakes the GM
    });

    if (!ooc) await enqueueGm(ctx, args.campaignId);
  },
});

// --- internal helpers used by the GM turn --------------------------------

export const createGmMessage = internalMutation({
  args: { campaignId: v.id("campaigns") },
  handler: async (ctx, args) => {
    return await ctx.db.insert("messages", {
      campaignId: args.campaignId,
      kind: "gm",
      content: "",
      status: "streaming",
      ooc: false,
      processed: true,
    });
  },
});

export const appendStreamChunk = internalMutation({
  args: { messageId: v.id("messages"), chunk: v.string(), campaignId: v.id("campaigns") },
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId);
    if (!message || message.status !== "streaming") return;
    await ctx.db.patch(args.messageId, { content: message.content + args.chunk });
    // Heartbeat the GM lock so stale detection trusts an active stream
    const campaign = await ctx.db.get(args.campaignId);
    if (campaign?.gm.status === "running") {
      await ctx.db.patch(args.campaignId, {
        gm: { ...campaign.gm, startedAt: Date.now() },
      });
    }
  },
});

export const finalizeGmMessage = internalMutation({
  args: {
    messageId: v.id("messages"),
    status: v.union(v.literal("complete"), v.literal("error")),
  },
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId);
    if (!message) return;
    // Empty error shells disappear rather than littering the feed
    if (args.status === "error" && message.content.trim() === "") {
      await ctx.db.delete(args.messageId);
      return;
    }
    await ctx.db.patch(args.messageId, { status: args.status });
  },
});

export const insertSystem = internalMutation({
  args: {
    campaignId: v.id("campaigns"),
    content: v.string(),
    processed: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("messages", {
      campaignId: args.campaignId,
      kind: "system",
      content: args.content,
      status: "complete",
      ooc: false,
      processed: args.processed ?? true,
    });
  },
});

export const markProcessed = internalMutation({
  args: { messageIds: v.array(v.id("messages")) },
  handler: async (ctx, args) => {
    for (const id of args.messageIds) await ctx.db.patch(id, { processed: true });
  },
});
