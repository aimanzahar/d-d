// World Codex: the party's player-facing journal (factions, POIs, quests),
// written by GM tools (see gm/tools.ts record_*) and read by the Codex/Map UI.

import { v } from "convex/values";
import { internalMutation, query } from "./_generated/server";
import { requirePlayer } from "./lib/auth";
import { fallbackCoord } from "./lib/mapCoords";

const POI_KINDS = ["settlement", "dungeon", "landmark", "wilds", "danger", "quest_site"] as const;
const STANDINGS = ["allied", "friendly", "neutral", "unfriendly", "hostile", "unknown"] as const;
const QUEST_STATUS = ["active", "completed", "failed"] as const;
type PoiKind = (typeof POI_KINDS)[number];
type Standing = (typeof STANDINGS)[number];
type QuestStatus = (typeof QUEST_STATUS)[number];

export const upsertPoi = internalMutation({
  args: {
    campaignId: v.id("campaigns"),
    slug: v.string(),
    name: v.string(),
    kind: v.string(),
    description: v.string(),
    factionSlug: v.optional(v.string()),
    x: v.optional(v.number()),
    y: v.optional(v.number()),
    discovered: v.boolean(),
  },
  handler: async (ctx, args) => {
    const kind: PoiKind = (POI_KINDS as readonly string[]).includes(args.kind)
      ? (args.kind as PoiKind)
      : "landmark";
    const existing = await ctx.db
      .query("pois")
      .withIndex("by_campaign_slug", (q) =>
        q.eq("campaignId", args.campaignId).eq("slug", args.slug),
      )
      .unique();
    // Coords: use the GM's when supplied; keep prior coords on update; otherwise
    // assign a deterministic fallback so every POI always has a place on the map.
    const gmCoords =
      args.x !== undefined && args.y !== undefined ? { x: args.x, y: args.y } : null;
    if (existing) {
      const coords =
        gmCoords ?? (existing.x == null || existing.y == null ? fallbackCoord(args.slug) : {});
      await ctx.db.patch(existing._id, {
        name: args.name.slice(0, 80),
        kind,
        description: args.description.slice(0, 600),
        factionSlug: args.factionSlug,
        ...coords,
        discovered: args.discovered,
        updatedAt: Date.now(),
      });
    } else {
      const coords = gmCoords ?? fallbackCoord(args.slug);
      await ctx.db.insert("pois", {
        campaignId: args.campaignId,
        slug: args.slug,
        name: args.name.slice(0, 80),
        kind,
        description: args.description.slice(0, 600),
        factionSlug: args.factionSlug,
        x: coords.x,
        y: coords.y,
        discovered: args.discovered,
        isCurrent: false,
        updatedAt: Date.now(),
      });
    }
    return { ok: true, slug: args.slug };
  },
});

export const upsertFaction = internalMutation({
  args: {
    campaignId: v.id("campaigns"),
    slug: v.string(),
    name: v.string(),
    description: v.string(),
    standing: v.string(),
    symbol: v.optional(v.string()),
    discovered: v.boolean(),
  },
  handler: async (ctx, args) => {
    const standing: Standing = (STANDINGS as readonly string[]).includes(args.standing)
      ? (args.standing as Standing)
      : "unknown";
    const existing = await ctx.db
      .query("factions")
      .withIndex("by_campaign_slug", (q) =>
        q.eq("campaignId", args.campaignId).eq("slug", args.slug),
      )
      .unique();
    const fields = {
      name: args.name.slice(0, 80),
      description: args.description.slice(0, 600),
      standing,
      symbol: args.symbol,
      discovered: args.discovered,
      updatedAt: Date.now(),
    };
    if (existing) await ctx.db.patch(existing._id, fields);
    else await ctx.db.insert("factions", { campaignId: args.campaignId, slug: args.slug, ...fields });
    return { ok: true, slug: args.slug };
  },
});

export const upsertQuest = internalMutation({
  args: {
    campaignId: v.id("campaigns"),
    slug: v.string(),
    title: v.string(),
    description: v.string(),
    status: v.string(),
    factionSlug: v.optional(v.string()),
    poiSlug: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const status: QuestStatus = (QUEST_STATUS as readonly string[]).includes(args.status)
      ? (args.status as QuestStatus)
      : "active";
    const existing = await ctx.db
      .query("quests")
      .withIndex("by_campaign_slug", (q) =>
        q.eq("campaignId", args.campaignId).eq("slug", args.slug),
      )
      .unique();
    const fields = {
      title: args.title.slice(0, 100),
      description: args.description.slice(0, 600),
      status,
      factionSlug: args.factionSlug,
      poiSlug: args.poiSlug,
      updatedAt: Date.now(),
    };
    if (existing) await ctx.db.patch(existing._id, fields);
    else await ctx.db.insert("quests", { campaignId: args.campaignId, slug: args.slug, ...fields });

    // Keep the quest.<slug>.status flag in sync so the GM's flag reasoning and
    // the codex never diverge (a quest change is also meaningful progress).
    const key = `quest.${args.slug}.status`;
    const flag = await ctx.db
      .query("questFlags")
      .withIndex("by_campaign_key", (q) => q.eq("campaignId", args.campaignId).eq("key", key))
      .unique();
    if (flag) await ctx.db.patch(flag._id, { value: status, updatedAt: Date.now() });
    else
      await ctx.db.insert("questFlags", {
        campaignId: args.campaignId,
        key,
        value: status,
        updatedAt: Date.now(),
      });
    await ctx.db.patch(args.campaignId, { stall: { count: 0 } });
    return { ok: true, slug: args.slug };
  },
});

// Powers the Codex sidebar window.
export const getCodex = query({
  args: { sessionToken: v.string(), campaignId: v.id("campaigns") },
  handler: async (ctx, args) => {
    await requirePlayer(ctx, args.sessionToken, args.campaignId);
    const campaign = await ctx.db.get(args.campaignId);
    const [factions, pois, quests] = await Promise.all([
      ctx.db
        .query("factions")
        .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
        .collect(),
      ctx.db
        .query("pois")
        .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
        .collect(),
      ctx.db
        .query("quests")
        .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
        .collect(),
    ]);
    return {
      currentLocation: campaign?.location ?? null,
      factions: factions.sort((a, b) => a.name.localeCompare(b.name)),
      pois: pois.sort(
        (a, b) => Number(b.discovered) - Number(a.discovered) || a.name.localeCompare(b.name),
      ),
      quests: {
        active: quests.filter((q) => q.status === "active"),
        completed: quests.filter((q) => q.status === "completed"),
        failed: quests.filter((q) => q.status === "failed"),
      },
    };
  },
});
