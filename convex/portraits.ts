// Character portrait AI generation — mirrors the scene-vision pipeline
// (convex/images.ts): gpt-image-2 via the OpenAI-compatible gateway, stored in Convex
// storage. Gated by a per-seat cooldown (like the backstory muse). The free
// upload path lives in characters.ts (generatePortraitUploadUrl).

import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { action, internalMutation } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { requirePlayer } from "./lib/auth";
import { IMAGE_MODEL } from "./lib/llm";

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

    const attempt = async (p: string): Promise<Uint8Array<ArrayBuffer>> => {
      const res = await fetch(`${process.env.LLM_BASE_URL}/images/generations`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.LLM_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: IMAGE_MODEL,
          prompt: p.slice(0, 980),
          n: 1,
          size: "1024x1024",
          quality: "medium",
          format: "png",
        }),
      });
      const json = await res.json();
      const b64 = json.data?.[0]?.b64_json;
      if (!b64) throw new Error(`no image data: ${JSON.stringify(json).slice(0, 220)}`);
      return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)) as Uint8Array<ArrayBuffer>;
    };

    let bytes: Uint8Array<ArrayBuffer>;
    try {
      bytes = await attempt(prompt);
    } catch (firstError) {
      if (/safety|rejected|content.?policy/i.test(String(firstError))) {
        bytes = await attempt(safePrompt);
      } else {
        console.error("portrait generation failed:", firstError);
        throw new ConvexError({ code: "portrait_failed" });
      }
    }
    const storageId = await ctx.storage.store(new Blob([bytes], { type: "image/png" }));
    return { storageId };
  },
});
