// "Inspire me": LLM-generated campaign seeds for the forge card. Gated on a
// signed-in account with a short per-user cooldown so the muse stays cheap.

import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { action, internalMutation } from "./_generated/server";
import { requireAccount } from "./lib/auth";
import { chatJson } from "./lib/llm";

const COOLDOWN_MS = 15_000;

// Random sparks keep consecutive seeds from rhyming with each other.
const TONES = [
  "folk-horror",
  "swashbuckling adventure",
  "melancholy mystery",
  "high-stakes heist",
  "weird and dreamlike",
  "grim frontier survival",
  "political intrigue",
  "found-family comedy with teeth",
];
const SETTINGS = [
  "a monsoon-lashed port town",
  "a mine beneath a glacier",
  "a city built on the back of something sleeping",
  "a drowned valley where rooftops break the water",
  "a desert caravanserai at the edge of the map",
  "a forest that rearranges itself at night",
  "an island that appears once a generation",
  "a border fort nobody resupplies anymore",
];
const HOOKS = [
  "everyone is lying about the same night",
  "the dead pay better than the living",
  "a child's drawing predicted all of it",
  "the festival must not be cancelled, no matter what",
  "the last expedition came back wrong",
  "someone is buying up all the salt",
  "the bells ring from beneath the water",
  "the harvest is double, and that frightens the elders",
];

const pick = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

// Atomic cooldown gate — charged up front so failed generations still count.
export const claimInspiration = internalMutation({
  args: { accountToken: v.string() },
  handler: async (ctx, args) => {
    const { user } = await requireAccount(ctx, args.accountToken);
    if (user.lastInspiredAt && Date.now() - user.lastInspiredAt < COOLDOWN_MS) {
      throw new ConvexError({ code: "muse_cooldown" });
    }
    await ctx.db.patch(user._id, { lastInspiredAt: Date.now() });
  },
});

export const generate = action({
  args: { accountToken: v.string() },
  handler: async (ctx, args): Promise<{ name: string; premise: string }> => {
    await ctx.runMutation(internal.inspiration.claimInspiration, {
      accountToken: args.accountToken,
    });

    const spark = `${pick(TONES)}; set in ${pick(SETTINGS)}; hook: ${pick(HOOKS)}`;
    try {
      const seed = await chatJson<{ name: string; premise: string }>({
        schemaName: "campaign_seed",
        schema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Evocative campaign name, max 50 characters, no quotes" },
            premise: {
              type: "string",
              description:
                "2-4 sentence campaign premise (max 450 characters) addressed to a Game Master as a story seed, ending on an open hook",
            },
          },
          required: ["name", "premise"],
          additionalProperties: false,
        },
        temperature: 1.0,
        messages: [
          {
            role: "system",
            content:
              "You invent Dungeons & Dragons campaign seeds. Vivid, specific, playable — never generic fantasy mush.",
          },
          {
            role: "user",
            content: `Weave these sparks into one campaign seed: ${spark}. Return the name and the premise.`,
          },
        ],
      });
      const name = seed.name.trim().replace(/^["']|["']$/g, "").slice(0, 60);
      const premise = seed.premise.trim().slice(0, 2000);
      if (!name || !premise) throw new Error("empty seed");
      return { name, premise };
    } catch (e) {
      if (e instanceof ConvexError) throw e;
      console.error("inspiration failed:", e);
      throw new ConvexError({ code: "muse_silent" });
    }
  },
});
