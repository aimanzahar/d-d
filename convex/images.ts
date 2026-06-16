import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, internalMutation, internalQuery, query } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { requirePlayer } from "./lib/auth";
import { generateAndStoreImage } from "./lib/imageGen";

// Skip an auto scene image if one is already generating for the campaign AND it
// started within this window — coalesces combat's rapid per-creature GM messages,
// while not letting a hung generation block auto-images for the full watchdog.
const AUTO_THROTTLE_MS = 60_000;

const SCENE_STYLE =
  "Epic dark fantasy digital painting, painterly brushwork, dramatic candle-and-comet light, rich color, wide cinematic establishing shot, no text, no watermark, no UI";

// Build the scene-vision prompt from the location + a GM narration beat (+ a fixed
// style suffix), with a scenery-only fallback for safety rejections.
function buildSceneImagePrompt(
  campaign: Doc<"campaigns">,
  narration: string,
): { prompt: string; safePrompt: string } {
  const excerpt = narration
    .replace(/[*>#_]/g, "")
    .slice(0, 420)
    .replace(/\s+\S*$/, "");
  const prompt = [`${campaign.location.name}: ${campaign.location.description}`, excerpt, SCENE_STYLE]
    .filter(Boolean)
    .join(". ");
  const safePrompt = `A fantasy landscape. ${campaign.location.name}: ${campaign.location.description}. Empty of people, atmospheric scenery only. ${SCENE_STYLE}`;
  return { prompt, safePrompt };
}

// Self-hosted CONVEX_CLOUD_ORIGIN is misconfigured (LAN address), so storage
// URLs are rewritten onto the public proxy origin — verified working.
export function publicStorageUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const path = new URL(url).pathname + new URL(url).search;
    return `https://convex.zahar.my${path}`;
  } catch {
    return url;
  }
}

// Auto scene image: fired fire-and-forget after every GM output (gm/turn.ts). No
// auth / cooldown / daily-cap — the throttle below is the only gate. Builds the
// prompt from THIS GM message's narration so the image matches the beat just told.
export const autoSceneImage = internalMutation({
  args: { campaignId: v.id("campaigns"), gmMessageId: v.id("messages") },
  handler: async (ctx, args) => {
    const campaign = await ctx.db.get(args.campaignId);
    if (!campaign) return;
    const recent = await ctx.db
      .query("images")
      .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
      .order("desc")
      .take(3);
    const now = Date.now();
    if (recent.some((i) => i.status === "generating" && now - i._creationTime < AUTO_THROTTLE_MS)) {
      return; // one already in flight — coalesce
    }
    const gm = await ctx.db.get(args.gmMessageId);
    const { prompt, safePrompt } = buildSceneImagePrompt(campaign, gm?.content ?? "");
    const imageId = await ctx.db.insert("images", {
      campaignId: args.campaignId,
      auto: true,
      prompt,
      safePrompt,
      locationName: campaign.location.name,
      status: "generating",
    });
    await ctx.scheduler.runAfter(0, internal.images.generate, { imageId });
    // Watchdog: if the generate action dies without reaching finish/fail (deploy,
    // restart), don't leave "generating" stuck — it would block later auto-images.
    await ctx.scheduler.runAfter(5 * 60_000, internal.images.failIfStillGenerating, { imageId });
  },
});

export const failIfStillGenerating = internalMutation({
  args: { imageId: v.id("images") },
  handler: async (ctx, args) => {
    const image = await ctx.db.get(args.imageId);
    if (image?.status === "generating") {
      await ctx.db.patch(args.imageId, { status: "failed", error: "timed out" });
    }
  },
});

export const generate = internalAction({
  args: { imageId: v.id("images") },
  handler: async (ctx, args) => {
    const image = await ctx.runQuery(internal.images.getById, { imageId: args.imageId });
    if (!image) return;

    try {
      let storageId;
      try {
        storageId = await generateAndStoreImage(ctx, image.prompt, "1536x1024");
      } catch (firstError) {
        // Safety-filter rejections get one scenery-only retry
        if (/safety|rejected|content.?policy/i.test(String(firstError)) && image.safePrompt) {
          storageId = await generateAndStoreImage(ctx, image.safePrompt, "1536x1024");
        } else {
          throw firstError;
        }
      }
      await ctx.runMutation(internal.images.finish, {
        imageId: args.imageId,
        storageId,
      });
    } catch (error) {
      console.error("image generation failed:", error);
      await ctx.runMutation(internal.images.fail, {
        imageId: args.imageId,
        error: String(error).slice(0, 300),
      });
    }
  },
});

export const getById = internalQuery({
  args: { imageId: v.id("images") },
  handler: async (ctx, args) => ctx.db.get(args.imageId),
});

export const finish = internalMutation({
  args: { imageId: v.id("images"), storageId: v.id("_storage") },
  handler: async (ctx, args) => {
    const image = await ctx.db.get(args.imageId);
    if (!image) return;
    await ctx.db.patch(args.imageId, { status: "done", storageId: args.storageId });
    await ctx.db.insert("messages", {
      campaignId: image.campaignId,
      kind: "image",
      content: `A vision of ${image.locationName} takes shape…`,
      status: "complete",
      ooc: false,
      processed: true,
      imageId: args.imageId,
    });
  },
});

export const fail = internalMutation({
  args: { imageId: v.id("images"), error: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.imageId, { status: "failed", error: args.error });
  },
});

// Most recent image's status — drives the persistent "vision is forming" note.
export const latest = query({
  args: { sessionToken: v.string(), campaignId: v.id("campaigns") },
  handler: async (ctx, args) => {
    await requirePlayer(ctx, args.sessionToken, args.campaignId);
    const image = await ctx.db
      .query("images")
      .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
      .order("desc")
      .first();
    return image ? { status: image.status } : null;
  },
});

export const gallery = query({
  args: { sessionToken: v.string(), campaignId: v.id("campaigns") },
  handler: async (ctx, args) => {
    await requirePlayer(ctx, args.sessionToken, args.campaignId);
    const images = await ctx.db
      .query("images")
      .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
      .order("desc")
      .take(50);
    return Promise.all(
      images.map(async (i) => ({
        _id: i._id,
        status: i.status,
        prompt: i.prompt,
        locationName: i.locationName,
        at: i._creationTime,
        url: i.storageId ? publicStorageUrl(await ctx.storage.getUrl(i.storageId)) : null,
      })),
    );
  },
});
