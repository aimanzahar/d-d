import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, mutation, query } from "./_generated/server";
import { newInviteCode, newToken, requireHost, requirePlayer } from "./lib/auth";
import { deleteByFilter } from "./lib/qdrant";
import { enqueueGm } from "./messages";

const MAX_PLAYERS = 6;

export const create = mutation({
  args: {
    name: v.string(),
    nickname: v.string(),
    premise: v.string(),
  },
  handler: async (ctx, args) => {
    const name = args.name.trim().slice(0, 60);
    const nickname = args.nickname.trim().slice(0, 24);
    if (!name || !nickname) throw new ConvexError({ code: "missing_fields" });

    // Collision-checked invite code
    let inviteCode = newInviteCode();
    for (let i = 0; i < 5; i++) {
      const clash = await ctx.db
        .query("campaigns")
        .withIndex("by_inviteCode", (q) => q.eq("inviteCode", inviteCode))
        .unique();
      if (!clash) break;
      inviteCode = newInviteCode();
    }

    const campaignId = await ctx.db.insert("campaigns", {
      name,
      inviteCode,
      status: "lobby",
      mode: "exploration",
      location: {
        name: "The Gathering",
        description: "Adventurers assemble before the journey begins.",
        sceneType: "tavern",
      },
      premise: args.premise.trim().slice(0, 2000),
      summary: "",
      gm: { status: "idle", generation: 0 },
    });

    const sessionToken = newToken();
    const playerId = await ctx.db.insert("players", {
      campaignId,
      nickname,
      sessionToken,
      isHost: true,
      lastSeenAt: Date.now(),
    });

    return { campaignId, inviteCode, sessionToken, playerId };
  },
});

export const join = mutation({
  args: { inviteCode: v.string(), nickname: v.string() },
  handler: async (ctx, args) => {
    const nickname = args.nickname.trim().slice(0, 24);
    if (!nickname) throw new ConvexError({ code: "missing_fields" });

    const campaign = await ctx.db
      .query("campaigns")
      .withIndex("by_inviteCode", (q) =>
        q.eq("inviteCode", args.inviteCode.trim().toUpperCase()),
      )
      .unique();
    if (!campaign) throw new ConvexError({ code: "campaign_not_found" });
    if (campaign.status !== "lobby") throw new ConvexError({ code: "campaign_started" });

    const players = await ctx.db
      .query("players")
      .withIndex("by_campaign", (q) => q.eq("campaignId", campaign._id))
      .collect();
    if (players.length >= MAX_PLAYERS) throw new ConvexError({ code: "campaign_full" });
    if (players.some((p) => p.nickname.toLowerCase() === nickname.toLowerCase())) {
      throw new ConvexError({ code: "nickname_taken" });
    }

    const sessionToken = newToken();
    const playerId = await ctx.db.insert("players", {
      campaignId: campaign._id,
      nickname,
      sessionToken,
      isHost: false,
      lastSeenAt: Date.now(),
    });

    return { campaignId: campaign._id, inviteCode: campaign.inviteCode, sessionToken, playerId };
  },
});

// Campaign state for the game shell. Validates membership.
export const get = query({
  args: { sessionToken: v.string(), inviteCode: v.string() },
  handler: async (ctx, args) => {
    const campaign = await ctx.db
      .query("campaigns")
      .withIndex("by_inviteCode", (q) =>
        q.eq("inviteCode", args.inviteCode.trim().toUpperCase()),
      )
      .unique();
    if (!campaign) return null;
    const player = await ctx.db
      .query("players")
      .withIndex("by_token", (q) => q.eq("sessionToken", args.sessionToken))
      .unique();
    if (!player || player.campaignId !== campaign._id) return null;
    return {
      _id: campaign._id,
      name: campaign.name,
      inviteCode: campaign.inviteCode,
      status: campaign.status,
      mode: campaign.mode,
      location: campaign.location,
      gmStatus: campaign.gm.status,
      activeCombatId: campaign.activeCombatId ?? null,
    };
  },
});

// Host starts the game: every seated player needs a forged hero.
export const startAdventure = mutation({
  args: { sessionToken: v.string(), campaignId: v.id("campaigns") },
  handler: async (ctx, args) => {
    await requireHost(ctx, args.sessionToken, args.campaignId);
    const campaign = await ctx.db.get(args.campaignId);
    if (!campaign) throw new ConvexError({ code: "campaign_not_found" });
    if (campaign.status !== "lobby") throw new ConvexError({ code: "campaign_started" });

    const players = await ctx.db
      .query("players")
      .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
      .collect();
    if (players.length === 0 || players.some((p) => !p.characterId)) {
      throw new ConvexError({ code: "party_not_ready" });
    }

    await ctx.db.patch(args.campaignId, { status: "active" });
    // Kickoff: an unprocessed system message is the GM's first work item.
    // ooc:true marks it as a GM directive — hidden from the player feed.
    await ctx.db.insert("messages", {
      campaignId: args.campaignId,
      kind: "system",
      content:
        "The campaign begins NOW. Open the adventure: establish the starting location with change_location, set the scene vividly from the premise, introduce each party member as present, and end with a hook that demands a decision.",
      status: "complete",
      ooc: true,
      processed: false,
    });
    await enqueueGm(ctx, args.campaignId);
  },
});

// Retry after a GM error: wakes the GM if idle.
export const retryGm = mutation({
  args: { sessionToken: v.string(), campaignId: v.id("campaigns") },
  handler: async (ctx, args) => {
    await requirePlayer(ctx, args.sessionToken, args.campaignId);
    await enqueueGm(ctx, args.campaignId);
  },
});

// Host-only recovery for a player who lost their localStorage token (G2).
// Returns a fresh token to hand to that player out-of-band.
export const reissueToken = mutation({
  args: {
    sessionToken: v.string(),
    campaignId: v.id("campaigns"),
    playerId: v.id("players"),
  },
  handler: async (ctx, args) => {
    await requireHost(ctx, args.sessionToken, args.campaignId);
    const target = await ctx.db.get(args.playerId);
    if (!target || target.campaignId !== args.campaignId) {
      throw new ConvexError({ code: "player_not_found" });
    }
    const fresh = newToken();
    await ctx.db.patch(args.playerId, { sessionToken: fresh });
    return { sessionToken: fresh, nickname: target.nickname };
  },
});

// Host-only: delete the campaign and every trace of it — tables, stored
// images, and Qdrant memories (G4).
export const deleteCampaign = mutation({
  args: { sessionToken: v.string(), campaignId: v.id("campaigns") },
  handler: async (ctx, args) => {
    await requireHost(ctx, args.sessionToken, args.campaignId);

    const images = await ctx.db
      .query("images")
      .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
      .collect();
    for (const image of images) {
      if (image.storageId) await ctx.storage.delete(image.storageId);
      await ctx.db.delete(image._id);
    }
    for (const doc of await ctx.db
      .query("players")
      .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
      .collect()) {
      await ctx.db.delete(doc._id);
    }
    for (const doc of await ctx.db
      .query("characters")
      .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
      .collect()) {
      await ctx.db.delete(doc._id);
    }
    for (const doc of await ctx.db
      .query("messages")
      .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
      .collect()) {
      await ctx.db.delete(doc._id);
    }
    for (const doc of await ctx.db
      .query("rolls")
      .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
      .collect()) {
      await ctx.db.delete(doc._id);
    }
    const combats = await ctx.db
      .query("combats")
      .withIndex("by_campaign_status", (q) => q.eq("campaignId", args.campaignId))
      .collect();
    for (const combat of combats) {
      const monsters = await ctx.db
        .query("monsters")
        .withIndex("by_combat", (q) => q.eq("combatId", combat._id))
        .collect();
      for (const m of monsters) await ctx.db.delete(m._id);
      await ctx.db.delete(combat._id);
    }
    const flags = await ctx.db
      .query("questFlags")
      .withIndex("by_campaign_key", (q) => q.eq("campaignId", args.campaignId))
      .collect();
    for (const flag of flags) await ctx.db.delete(flag._id);
    await ctx.db.delete(args.campaignId);
    // Qdrant memories go in a fire-and-forget action
    await ctx.scheduler.runAfter(0, internal.campaigns.purgeMemories, {
      campaignId: String(args.campaignId),
    });
  },
});

export const purgeMemories = internalAction({
  args: { campaignId: v.string() },
  handler: async (_ctx, args) => {
    try {
      await deleteByFilter({ campaignId: args.campaignId });
    } catch (error) {
      console.error("Qdrant purge failed (non-fatal):", error);
    }
  },
});

export const heartbeatSeen = mutation({
  args: { sessionToken: v.string() },
  handler: async (ctx, args) => {
    const player = await requirePlayer(ctx, args.sessionToken);
    await ctx.db.patch(player._id, { lastSeenAt: Date.now() });
  },
});
