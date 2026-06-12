import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requirePlayer } from "./lib/auth";

// Each keystroke ping keeps the player "typing" for this long; the client
// re-pings well within the window so the indicator stays lit while composing.
const TYPING_TTL_MS = 4000;

// Upsert my typing row, extending the TTL. Throttled client-side.
export const ping = mutation({
  args: { sessionToken: v.string(), campaignId: v.id("campaigns") },
  handler: async (ctx, args) => {
    const player = await requirePlayer(ctx, args.sessionToken, args.campaignId);
    const character = player.characterId ? await ctx.db.get(player.characterId) : null;
    const existing = await ctx.db
      .query("typing")
      .withIndex("by_player", (q) => q.eq("playerId", player._id))
      .unique();
    const patch = {
      campaignId: args.campaignId,
      playerId: player._id,
      characterName: character?.name ?? player.nickname,
      typingUntil: Date.now() + TYPING_TTL_MS,
    };
    if (existing) await ctx.db.patch(existing._id, patch);
    else await ctx.db.insert("typing", patch);
  },
});

// Stop typing immediately (on send / blur / idle).
export const clear = mutation({
  args: { sessionToken: v.string(), campaignId: v.id("campaigns") },
  handler: async (ctx, args) => {
    const player = await requirePlayer(ctx, args.sessionToken, args.campaignId);
    const existing = await ctx.db
      .query("typing")
      .withIndex("by_player", (q) => q.eq("playerId", player._id))
      .unique();
    if (existing) await ctx.db.delete(existing._id);
  },
});

// Who else is typing right now. Returns typingUntil so the client can fade names
// locally on a timer (query reactivity alone won't fire on time passing).
export const list = query({
  args: { sessionToken: v.string(), campaignId: v.id("campaigns") },
  handler: async (ctx, args) => {
    const me = await requirePlayer(ctx, args.sessionToken, args.campaignId);
    const now = Date.now();
    const rows = await ctx.db
      .query("typing")
      .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
      .collect();
    return rows
      .filter((r) => r.typingUntil > now && r.playerId !== me._id)
      .map((r) => ({ characterName: r.characterName, typingUntil: r.typingUntil }));
  },
});
