// "Inspire me": LLM-generated campaign seeds for the forge card. Gated on a
// signed-in account with a short per-user cooldown so the muse stays cheap.

import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { action, internalMutation } from "./_generated/server";
import { requireAccount, requirePlayer } from "./lib/auth";
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

// Atomic cooldown gate for the backstory muse (per seat, not per account —
// the create page is session-scoped) that also hands back the campaign seed.
export const claimBackstoryMuse = internalMutation({
  args: { sessionToken: v.string(), campaignId: v.id("campaigns") },
  handler: async (ctx, args) => {
    const player = await requirePlayer(ctx, args.sessionToken, args.campaignId);
    if (player.lastInspiredAt && Date.now() - player.lastInspiredAt < COOLDOWN_MS) {
      throw new ConvexError({ code: "muse_cooldown" });
    }
    await ctx.db.patch(player._id, { lastInspiredAt: Date.now() });
    const campaign = await ctx.db.get(args.campaignId);
    if (!campaign) throw new ConvexError({ code: "campaign_not_found" });
    return { campaignName: campaign.name, premise: campaign.premise };
  },
});

// "Inspire me" for the forge's backstory whisper: a hook grown from the
// campaign seed and the hero taking shape.
export const generateBackstory = action({
  args: {
    sessionToken: v.string(),
    campaignId: v.id("campaigns"),
    raceIndex: v.string(),
    classIndex: v.string(),
    name: v.optional(v.string()),
    alignment: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ backstory: string }> => {
    const seed = await ctx.runMutation(internal.inspiration.claimBackstoryMuse, {
      sessionToken: args.sessionToken,
      campaignId: args.campaignId,
    });

    const hero = [
      args.name?.trim() ? `named ${args.name.trim().slice(0, 40)}` : null,
      `a ${args.raceIndex} ${args.classIndex}`,
      args.alignment ? `leaning ${args.alignment}` : null,
    ]
      .filter(Boolean)
      .join(", ");
    try {
      const result = await chatJson<{ backstory: string }>({
        schemaName: "backstory_whisper",
        schema: {
          type: "object",
          properties: {
            backstory: {
              type: "string",
              description:
                'A D&D character backstory whisper: 2-4 short, fragmentary, evocative sentences (max 450 characters) in the style of "Raised by temple bells. Owes a debt to a man with no shadow." — concrete hooks, no plot resolutions, no names of campaign NPCs the player has not met',
            },
          },
          required: ["backstory"],
          additionalProperties: false,
        },
        temperature: 1.0,
        messages: [
          {
            role: "system",
            content:
              "You whisper Dungeons & Dragons character backstories. Vivid, specific, playable — never generic fantasy mush. The backstory must give the Game Master threads to pull on, not answers.",
          },
          {
            role: "user",
            content: `The campaign "${seed.campaignName}" is seeded by this premise: ${seed.premise}\n\nWhisper a backstory for ${hero} that ties them to this world. Return only the backstory.`,
          },
        ],
      });
      const backstory = result.backstory.trim().slice(0, 2000);
      if (!backstory) throw new Error("empty backstory");
      return { backstory };
    } catch (e) {
      if (e instanceof ConvexError) throw e;
      console.error("backstory muse failed:", e);
      throw new ConvexError({ code: "muse_silent" });
    }
  },
});
