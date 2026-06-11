import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { newInviteCode, newToken, requireHost, requirePlayer } from "./lib/auth";

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

export const heartbeatSeen = mutation({
  args: { sessionToken: v.string() },
  handler: async (ctx, args) => {
    const player = await requirePlayer(ctx, args.sessionToken);
    await ctx.db.patch(player._id, { lastSeenAt: Date.now() });
  },
});
