import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { requirePlayer } from "./lib/auth";
import { IMAGE_MODEL } from "./lib/llm";

const COOLDOWN_MS = 120_000;
const DAILY_CAP = 24;

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

export const requestSceneImage = mutation({
  args: { sessionToken: v.string(), campaignId: v.id("campaigns") },
  handler: async (ctx, args) => {
    const player = await requirePlayer(ctx, args.sessionToken, args.campaignId);
    const campaign = await ctx.db.get(args.campaignId);
    if (!campaign) throw new ConvexError({ code: "campaign_not_found" });

    const recent = await ctx.db
      .query("images")
      .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
      .order("desc")
      .take(DAILY_CAP);
    if (recent.some((i) => i.status === "generating")) {
      throw new ConvexError({ code: "image_in_flight" });
    }
    const now = Date.now();
    const last = recent[0];
    if (last && now - last._creationTime < COOLDOWN_MS) {
      throw new ConvexError({
        code: "image_cooldown",
        retryInMs: COOLDOWN_MS - (now - last._creationTime),
      });
    }
    if (recent.filter((i) => now - i._creationTime < 86_400_000).length >= DAILY_CAP) {
      throw new ConvexError({ code: "image_daily_cap" });
    }

    // Prompt: scene + the latest GM narration beat + a fixed style suffix
    const lastGm = (
      await ctx.db
        .query("messages")
        .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
        .order("desc")
        .take(12)
    ).find((m) => m.kind === "gm" && m.status === "complete" && m.content.length > 80);
    const excerpt = (lastGm?.content ?? "")
      .replace(/[*>#_]/g, "")
      .slice(0, 420)
      .replace(/\s+\S*$/, "");
    const STYLE =
      "Epic dark fantasy digital painting, painterly brushwork, dramatic candle-and-comet light, rich color, wide cinematic establishing shot, no text, no watermark, no UI";
    const prompt = [
      `${campaign.location.name}: ${campaign.location.description}`,
      excerpt,
      STYLE,
    ]
      .filter(Boolean)
      .join(". ");
    // Scenery-only fallback: combat narration regularly trips safety filters
    const safePrompt = `A fantasy landscape. ${campaign.location.name}: ${campaign.location.description}. Empty of people, atmospheric scenery only. ${STYLE}`;

    const imageId = await ctx.db.insert("images", {
      campaignId: args.campaignId,
      requestedByPlayerId: player._id,
      prompt,
      safePrompt,
      locationName: campaign.location.name,
      status: "generating",
    });
    await ctx.scheduler.runAfter(0, internal.images.generate, { imageId });
    return { imageId };
  },
});

export const generate = internalAction({
  args: { imageId: v.id("images") },
  handler: async (ctx, args) => {
    const image = await ctx.runQuery(internal.images.getById, { imageId: args.imageId });
    if (!image) return;

    const attempt = async (prompt: string): Promise<Uint8Array<ArrayBuffer>> => {
      const res = await fetch(`${process.env.LLM_BASE_URL}/images/generations`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.LLM_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: IMAGE_MODEL,
          prompt: prompt.slice(0, 980),
          n: 1,
          size: "1536x1024",
          quality: "medium",
          format: "png",
        }),
      });
      const json = await res.json();
      const b64 = json.data?.[0]?.b64_json;
      if (!b64) throw new Error(`no image data: ${JSON.stringify(json).slice(0, 220)}`);
      return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)) as Uint8Array<ArrayBuffer>;
    };

    try {
      let bytes: Uint8Array<ArrayBuffer>;
      try {
        bytes = await attempt(image.prompt);
      } catch (firstError) {
        // Safety-filter rejections get one scenery-only retry
        if (/safety|rejected|content.?policy/i.test(String(firstError)) && image.safePrompt) {
          bytes = await attempt(image.safePrompt);
        } else {
          throw firstError;
        }
      }
      const storageId = await ctx.storage.store(new Blob([bytes], { type: "image/png" }));
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
