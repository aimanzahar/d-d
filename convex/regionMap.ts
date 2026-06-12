// AI-generated region map. The image is a label-free parchment backdrop stored
// on the campaign; POI markers overlay it from the pois table's normalized x/y.
// Mirrors convex/images.ts for the provider call + watchdog, but state lives on
// campaign.regionMap (one per campaign) rather than the images table.

import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, internalMutation, mutation, query } from "./_generated/server";
import { requireHost, requirePlayer } from "./lib/auth";
import { IMAGE_MODEL } from "./lib/llm";
import { publicStorageUrl } from "./images";

const MAP_STYLE =
  "Top-down hand-drawn fantasy region map on aged parchment, ink linework, mountains forests rivers lakes and coastlines, cartographic style, a compass rose in one corner, muted earthy palette, NO text, NO labels, NO words, no grid lines";

export const generateRegionMap = mutation({
  args: { sessionToken: v.string(), campaignId: v.id("campaigns") },
  handler: async (ctx, args) => {
    await requireHost(ctx, args.sessionToken, args.campaignId);
    const campaign = await ctx.db.get(args.campaignId);
    if (!campaign) throw new ConvexError({ code: "campaign_not_found" });
    if (campaign.regionMap?.status === "generating") {
      throw new ConvexError({ code: "map_in_flight" });
    }
    const pois = await ctx.db
      .query("pois")
      .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
      .collect();
    const places = pois
      .map((p) => p.name)
      .slice(0, 12)
      .join(", ");
    const prompt = [
      `A region map for the realm of "${campaign.name}".`,
      campaign.premise ? `Setting: ${campaign.premise.slice(0, 300)}.` : "",
      places ? `It contains places such as: ${places}.` : "",
      MAP_STYLE,
    ]
      .filter(Boolean)
      .join(" ");
    await ctx.db.patch(args.campaignId, { regionMap: { status: "generating", prompt } });
    await ctx.scheduler.runAfter(0, internal.regionMap.generate, {
      campaignId: args.campaignId,
      prompt,
    });
    // Watchdog: never leave a generation (and its "drawing…" UI) wedged.
    await ctx.scheduler.runAfter(5 * 60_000, internal.regionMap.failIfStuck, {
      campaignId: args.campaignId,
    });
    return { ok: true };
  },
});

export const generate = internalAction({
  args: { campaignId: v.id("campaigns"), prompt: v.string() },
  handler: async (ctx, args) => {
    try {
      const res = await fetch(`${process.env.LLM_BASE_URL}/images/generations`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.LLM_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: IMAGE_MODEL,
          prompt: args.prompt.slice(0, 980),
          n: 1,
          size: "1536x1024",
          quality: "medium",
          format: "png",
        }),
      });
      const json = await res.json();
      const b64 = json.data?.[0]?.b64_json;
      if (!b64) throw new Error(`no image data: ${JSON.stringify(json).slice(0, 220)}`);
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)) as Uint8Array<ArrayBuffer>;
      const storageId = await ctx.storage.store(new Blob([bytes], { type: "image/png" }));
      await ctx.runMutation(internal.regionMap.finishMap, {
        campaignId: args.campaignId,
        storageId,
      });
    } catch (error) {
      console.error("region map generation failed:", error);
      await ctx.runMutation(internal.regionMap.failMap, { campaignId: args.campaignId });
    }
  },
});

export const finishMap = internalMutation({
  args: { campaignId: v.id("campaigns"), storageId: v.id("_storage") },
  handler: async (ctx, args) => {
    const campaign = await ctx.db.get(args.campaignId);
    if (!campaign) return;
    // Free a prior map blob if this is a redraw.
    if (campaign.regionMap?.storageId && campaign.regionMap.storageId !== args.storageId) {
      await ctx.storage.delete(campaign.regionMap.storageId);
    }
    await ctx.db.patch(args.campaignId, {
      regionMap: {
        status: "done",
        storageId: args.storageId,
        prompt: campaign.regionMap?.prompt,
        generatedAt: Date.now(),
      },
    });
  },
});

export const failMap = internalMutation({
  args: { campaignId: v.id("campaigns") },
  handler: async (ctx, args) => {
    const campaign = await ctx.db.get(args.campaignId);
    if (!campaign?.regionMap) return;
    await ctx.db.patch(args.campaignId, {
      regionMap: { ...campaign.regionMap, status: "failed" },
    });
  },
});

export const failIfStuck = internalMutation({
  args: { campaignId: v.id("campaigns") },
  handler: async (ctx, args) => {
    const campaign = await ctx.db.get(args.campaignId);
    if (campaign?.regionMap?.status === "generating") {
      await ctx.db.patch(args.campaignId, {
        regionMap: { ...campaign.regionMap, status: "failed" },
      });
    }
  },
});

// Status + image URL for the Region Map window. Markers come from the codex
// query (full POI/faction docs), so this stays lean.
export const getRegionMap = query({
  args: { sessionToken: v.string(), campaignId: v.id("campaigns") },
  handler: async (ctx, args) => {
    await requirePlayer(ctx, args.sessionToken, args.campaignId);
    const campaign = await ctx.db.get(args.campaignId);
    const rm = campaign?.regionMap;
    const url = rm?.storageId ? publicStorageUrl(await ctx.storage.getUrl(rm.storageId)) : null;
    return { status: rm?.status ?? null, url };
  },
});
