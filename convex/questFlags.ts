import { v } from "convex/values";
import { internalMutation, query } from "./_generated/server";
import { requirePlayer } from "./lib/auth";

export const list = query({
  args: { sessionToken: v.string(), campaignId: v.id("campaigns") },
  handler: async (ctx, args) => {
    await requirePlayer(ctx, args.sessionToken, args.campaignId);
    const flags = await ctx.db
      .query("questFlags")
      .withIndex("by_campaign_key", (q) => q.eq("campaignId", args.campaignId))
      .collect();
    // secret.* flags are GM-only
    return flags.filter((f) => !f.key.startsWith("secret."));
  },
});

export const set = internalMutation({
  args: {
    campaignId: v.id("campaigns"),
    key: v.string(),
    value: v.union(v.string(), v.number(), v.boolean()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("questFlags")
      .withIndex("by_campaign_key", (q) =>
        q.eq("campaignId", args.campaignId).eq("key", args.key),
      )
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, { value: args.value, updatedAt: Date.now() });
    } else {
      await ctx.db.insert("questFlags", {
        campaignId: args.campaignId,
        key: args.key,
        value: args.value,
        updatedAt: Date.now(),
      });
    }
    return { ok: true };
  },
});
