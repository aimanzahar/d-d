// Character portrait AI generation — mirrors the scene-vision pipeline
// (convex/images.ts): qwen-image-2.0 via the OpenAI-compatible gateway, stored in Convex
// storage. Gated by a per-seat cooldown (like the backstory muse). The free
// upload path lives in characters.ts (generatePortraitUploadUrl).

import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { action, internalMutation } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { requirePlayer } from "./lib/auth";
import { generateAndStoreImage } from "./lib/imageGen";

const COOLDOWN_MS = 120_000;
const PORTRAIT_STYLE =
  "Head-and-shoulders character portrait, dark fantasy digital painting, painterly brushwork, dramatic candle-and-comet light, detailed expressive face, plain dark background, no text, no watermark, no UI";

// Per-seat cooldown gate (the create page is session-scoped, like the muse).
export const claimPortraitMuse = internalMutation({
  args: { sessionToken: v.string(), campaignId: v.id("campaigns") },
  handler: async (ctx, args) => {
    const player = await requirePlayer(ctx, args.sessionToken, args.campaignId);
    const now = Date.now();
    if (player.lastPortraitAt && now - player.lastPortraitAt < COOLDOWN_MS) {
      throw new ConvexError({
        code: "portrait_cooldown",
        retryInMs: COOLDOWN_MS - (now - player.lastPortraitAt),
      });
    }
    await ctx.db.patch(player._id, { lastPortraitAt: now });
  },
});

export const generatePortrait = action({
  args: {
    sessionToken: v.string(),
    campaignId: v.id("campaigns"),
    raceIndex: v.string(),
    classIndex: v.string(),
    name: v.optional(v.string()),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ storageId: Id<"_storage"> }> => {
    await ctx.runMutation(internal.portraits.claimPortraitMuse, {
      sessionToken: args.sessionToken,
      campaignId: args.campaignId,
    });

    const who = `${args.name?.trim() || "an adventurer"}, a ${args.raceIndex} ${args.classIndex}`;
    const backstory = (args.notes ?? "").replace(/[*>#_]/g, "").slice(0, 400);
    const prompt = `Character portrait of ${who}. ${backstory}. ${PORTRAIT_STYLE}`;
    // Scenery-safe fallback if the backstory trips the safety filter.
    const safePrompt = `Heroic fantasy character portrait of a ${args.raceIndex} ${args.classIndex}, noble bearing, dramatic lighting. ${PORTRAIT_STYLE}`;

    let storageId: Id<"_storage">;
    try {
      storageId = await generateAndStoreImage(ctx, prompt, "1024x1024");
    } catch (firstError) {
      if (/safety|rejected|content.?policy/i.test(String(firstError))) {
        storageId = await generateAndStoreImage(ctx, safePrompt, "1024x1024");
      } else {
        console.error("portrait generation failed:", firstError);
        throw new ConvexError({ code: "portrait_failed" });
      }
    }
    return { storageId };
  },
});
