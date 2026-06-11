import { v } from "convex/values";
import { query } from "./_generated/server";

// localStorage rejoin: token → player + campaign route info. Null = invalid.
export const resume = query({
  args: { sessionToken: v.string() },
  handler: async (ctx, args) => {
    if (!args.sessionToken) return null;
    const player = await ctx.db
      .query("players")
      .withIndex("by_token", (q) => q.eq("sessionToken", args.sessionToken))
      .unique();
    if (!player) return null;
    const campaign = await ctx.db.get(player.campaignId);
    if (!campaign) return null;
    return {
      playerId: player._id,
      nickname: player.nickname,
      isHost: player.isHost,
      characterId: player.characterId ?? null,
      campaignId: campaign._id,
      inviteCode: campaign.inviteCode,
      campaignName: campaign.name,
      campaignStatus: campaign.status,
    };
  },
});

// Lobby roster. Joined with character readiness so the host can see who's set.
export const list = query({
  args: { sessionToken: v.string(), campaignId: v.id("campaigns") },
  handler: async (ctx, args) => {
    const me = await ctx.db
      .query("players")
      .withIndex("by_token", (q) => q.eq("sessionToken", args.sessionToken))
      .unique();
    if (!me || me.campaignId !== args.campaignId) return null;

    const players = await ctx.db
      .query("players")
      .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
      .collect();

    return Promise.all(
      players.map(async (p) => {
        const character = p.characterId ? await ctx.db.get(p.characterId) : null;
        return {
          playerId: p._id,
          nickname: p.nickname,
          isHost: p.isHost,
          isMe: p._id === me._id,
          lastSeenAt: p.lastSeenAt,
          character: character
            ? {
                _id: character._id,
                name: character.name,
                raceIndex: character.raceIndex,
                classIndex: character.classIndex,
                level: character.level,
              }
            : null,
        };
      }),
    );
  },
});
