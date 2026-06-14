import { ConvexError, v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { internal } from "./_generated/api";
import { internalMutation, mutation, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { requirePlayer } from "./lib/auth";
import { publicStorageUrl } from "./images";
import {
  parseSegments,
  cleanForDisplay,
  voiceForSpeaker,
  NARRATOR_VOICE,
  type Gender,
} from "./gm/voices";

const GM_STALE_MS = 120_000;

// The GM wake-up: claims the lock if free (or stale) and schedules a turn.
// Called by sendPlayerAction, roll fulfillment, and (later) combat advance.
export async function enqueueGm(ctx: MutationCtx, campaignId: Id<"campaigns">) {
  const campaign = await ctx.db.get(campaignId);
  if (!campaign || campaign.status !== "active") return;
  const stale =
    campaign.gm.status === "running" &&
    Date.now() - (campaign.gm.startedAt ?? 0) > GM_STALE_MS;
  if (campaign.gm.status === "idle" || stale) {
    const generation = campaign.gm.generation + 1;
    await ctx.db.patch(campaignId, {
      gm: { status: "running", startedAt: Date.now(), generation },
    });
    await ctx.scheduler.runAfter(0, internal.gm.turn.respond, {
      campaignId,
      generation,
    });
  }
  // Otherwise: the running turn's finishTurn drains the queue.
}

export const list = query({
  args: {
    sessionToken: v.string(),
    campaignId: v.id("campaigns"),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    await requirePlayer(ctx, args.sessionToken, args.campaignId);
    const page = await ctx.db
      .query("messages")
      .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
      .order("desc")
      .paginate(args.paginationOpts);
    // Join roll docs (with DC stripped while pending) and image URLs
    const items = await Promise.all(
      page.page.map(async (m) => {
        const roll = m.rollId ? await ctx.db.get(m.rollId) : null;
        const image = m.imageId ? await ctx.db.get(m.imageId) : null;
        const rawUrl = image?.storageId ? await ctx.storage.getUrl(image.storageId) : null;
        // Spoken-narration audio (gm messages): resolve to the public proxy URL.
        const rawAudioUrl = m.audioStorageId ? await ctx.storage.getUrl(m.audioStorageId) : null;
        return {
          ...m,
          roll:
            roll && roll.visibility === "public"
              ? { ...roll, dc: roll.status === "rolled" ? roll.dc : undefined }
              : null,
          imageUrl: rawUrl ? publicStorageUrl(rawUrl) : null,
          audioUrl: rawAudioUrl ? publicStorageUrl(rawAudioUrl) : null,
        };
      }),
    );
    return { ...page, page: items };
  },
});

// Lightweight feed for the narration audio player: the most recent GM messages
// that have synthesized audio, newest-first. Each message carries an ordered
// list of voiced segments (narrator + tagged NPC dialogue); the player plays a
// message's segments in order, then advances. Legacy single-voice messages are
// surfaced as a one-element list. The player watermarks at mount and only voices
// messages that arrive afterward (plus segments that land later for the current
// scene). See docs/adr/0006.
export const narrationAudio = query({
  args: { sessionToken: v.string(), campaignId: v.id("campaigns") },
  handler: async (ctx, args) => {
    await requirePlayer(ctx, args.sessionToken, args.campaignId);
    const recent = await ctx.db
      .query("messages")
      .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
      .order("desc")
      .take(25);
    const narrated = recent.filter(
      (m) => m.kind === "gm" && ((m.audioSegments?.length ?? 0) > 0 || !!m.audioStorageId),
    );
    return Promise.all(
      narrated.map(async (m) => {
        let segments: { order: number; audioStatus: string | null; audioUrl: string | null }[];
        if (m.audioSegments?.length) {
          const sorted = [...m.audioSegments].sort((a, b) => a.order - b.order);
          segments = await Promise.all(
            sorted.map(async (s) => {
              const raw = s.audioStorageId ? await ctx.storage.getUrl(s.audioStorageId) : null;
              return {
                order: s.order,
                audioStatus: s.audioStatus,
                audioUrl: raw ? publicStorageUrl(raw) : null,
              };
            }),
          );
        } else {
          // Legacy single-voice message (synthesized before per-speaker voices).
          const raw = m.audioStorageId ? await ctx.storage.getUrl(m.audioStorageId) : null;
          segments = [
            {
              order: 0,
              audioStatus: m.audioStatus ?? null,
              audioUrl: raw ? publicStorageUrl(raw) : null,
            },
          ];
        }
        return { id: String(m._id), createdAt: m._creationTime, segments };
      }),
    );
  },
});

export const sendPlayerAction = mutation({
  args: {
    sessionToken: v.string(),
    campaignId: v.id("campaigns"),
    content: v.string(),
    ooc: v.boolean(),
  },
  handler: async (ctx, args) => {
    const player = await requirePlayer(ctx, args.sessionToken, args.campaignId);
    const campaign = await ctx.db.get(args.campaignId);
    if (!campaign) throw new ConvexError({ code: "campaign_not_found" });
    if (campaign.status !== "active") throw new ConvexError({ code: "not_started" });
    const content = args.content.trim().slice(0, 2000);
    if (!content) throw new ConvexError({ code: "empty" });

    const character = player.characterId ? await ctx.db.get(player.characterId) : null;

    // Incapacitation gate: a downed/dead character cannot take story actions.
    // Their words become table talk so the GM is never asked to honour them
    // (and so a dead PC can never narrate their own resurrection).
    let ooc = args.ooc;
    if (
      !ooc &&
      character?.conditions.some((c) => ["dead", "unconscious", "stable"].includes(c.name))
    ) {
      ooc = true;
    }

    // Combat gate: only the active combatant's words are actions, and only ONE
    // action per turn. Off-turn words are table talk; a typed action spends the
    // turn's single action (shared with the HUD buttons via turnState.actionUsed),
    // and any further words that turn become table talk. The GM resolves the
    // committed action and then advances the turn (see COMBAT_ADDENDUM +
    // autoAdvanceIfPlayerActionDone). Movement and OOC stay unlimited.
    if (campaign.mode === "combat" && !ooc) {
      const combat = campaign.activeCombatId ? await ctx.db.get(campaign.activeCombatId) : null;
      const active = combat?.initiative[combat.activeIndex];
      if (!combat || !active || active.refId !== String(player.characterId)) {
        ooc = true; // not your turn
      } else if (combat.turnState.actionUsed) {
        ooc = true; // already acted this turn
      } else {
        // This message IS your one action this turn — spend it.
        await ctx.db.patch(combat._id, {
          turnState: { ...combat.turnState, actionUsed: true },
        });
      }
    }

    await ctx.db.insert("messages", {
      campaignId: args.campaignId,
      kind: "player",
      playerId: player._id,
      characterName: character?.name ?? player.nickname,
      content,
      status: "complete",
      ooc,
      processed: ooc, // table talk never wakes the GM
    });

    if (!ooc) await enqueueGm(ctx, args.campaignId);

    // Soft spotlight: when the spotlighted hero (or anyone, if unset) takes a
    // story action, pass the beat to the next living party member. A cue only —
    // it never blocks anyone from acting.
    if (campaign.mode === "exploration" && !ooc && character) {
      const holder = campaign.spotlightCharacterId ?? null;
      if (holder === null || holder === character._id) {
        const party = await ctx.db
          .query("characters")
          .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
          .collect();
        const living = party
          .filter(
            (c) => !c.conditions.some((x) => ["dead", "unconscious", "stable"].includes(x.name)),
          )
          .sort((a, b) => a._creationTime - b._creationTime); // stable round-robin
        if (living.length > 0) {
          const idx = living.findIndex((c) => c._id === character._id);
          const next = living[(idx + 1) % living.length];
          if (next._id !== holder) {
            await ctx.db.patch(args.campaignId, { spotlightCharacterId: next._id });
          }
        }
      }
    }
  },
});

// --- internal helpers used by the GM turn --------------------------------

export const createGmMessage = internalMutation({
  args: { campaignId: v.id("campaigns") },
  handler: async (ctx, args) => {
    return await ctx.db.insert("messages", {
      campaignId: args.campaignId,
      kind: "gm",
      content: "",
      status: "streaming",
      ooc: false,
      processed: true,
    });
  },
});

export const appendStreamChunk = internalMutation({
  args: { messageId: v.id("messages"), chunk: v.string(), campaignId: v.id("campaigns") },
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId);
    if (!message || message.status !== "streaming") return;
    await ctx.db.patch(args.messageId, { content: message.content + args.chunk });
    // Heartbeat the GM lock so stale detection trusts an active stream
    const campaign = await ctx.db.get(args.campaignId);
    if (campaign?.gm.status === "running") {
      await ctx.db.patch(args.campaignId, {
        gm: { ...campaign.gm, startedAt: Date.now() },
      });
    }
  },
});

export const finalizeGmMessage = internalMutation({
  args: {
    messageId: v.id("messages"),
    status: v.union(v.literal("complete"), v.literal("error")),
  },
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId);
    if (!message) return;
    // Empty error shells disappear rather than littering the feed
    if (args.status === "error" && message.content.trim() === "") {
      await ctx.db.delete(args.messageId);
      return;
    }
    // On a completed gm message, split the prose into per-speaker voiced segments
    // (docs/adr/0006, 0007) and rewrite the body to clean prose (voice tags removed)
    // for the feed, transcript, and memory. gm/tts.synthesize fills each clip in.
    if (args.status === "complete" && message.kind === "gm") {
      const parsed = parseSegments(message.content);

      // Per-campaign gender registry (docs/adr/0007): remembered genders so a later
      // mention that OMITS gender still picks the right pool. Writes here are race-free
      // because finalize runs under the per-campaign GM lock (one GM turn at a time).
      const rows = await ctx.db
        .query("npcGenders")
        .withIndex("by_campaign", (q) => q.eq("campaignId", message.campaignId))
        .collect();
      const registry = new Map<string, Gender>();
      for (const r of rows) registry.set(r.nameKey, r.gender);

      // First gender the GM tagged for each name in THIS message (lowest order wins).
      const tagged = new Map<string, Gender>();
      for (const s of parsed) {
        if (!s.name || !s.gender) continue;
        const key = s.name.trim().toLowerCase();
        if (!tagged.has(key)) tagged.set(key, s.gender);
      }
      // Effective gender = remembered ?? tagged-this-message. Registry is sticky, so a
      // remembered gender always wins; a genderless first sighting auto-upgrades to the
      // right gendered voice the first time the GM tags it.
      const effective = (name: string): Gender | undefined => {
        const key = name.trim().toLowerCase();
        return registry.get(key) ?? tagged.get(key);
      };

      const segments = parsed.map((s) => ({
        order: s.order,
        voiceId: s.name === null ? NARRATOR_VOICE : voiceForSpeaker(s.name, effective(s.name)),
        text: s.text,
        ...(s.emotion ? { emotion: s.emotion } : {}),
        audioStatus: "pending" as const,
      }));

      await ctx.db.patch(args.messageId, {
        status: args.status,
        content: cleanForDisplay(message.content),
        ...(segments.length > 0 ? { audioSegments: segments } : {}),
      });

      // Learn any newly-tagged gender not already remembered (upgrade-once, sticky —
      // never flip a remembered gender). Defensive unique() check guards the insert.
      for (const [key, gender] of tagged) {
        if (registry.has(key)) continue;
        const existing = await ctx.db
          .query("npcGenders")
          .withIndex("by_campaign_name", (q) =>
            q.eq("campaignId", message.campaignId).eq("nameKey", key),
          )
          .unique();
        if (!existing) {
          await ctx.db.insert("npcGenders", {
            campaignId: message.campaignId,
            nameKey: key,
            gender,
          });
        }
      }
      return;
    }
    await ctx.db.patch(args.messageId, { status: args.status });
  },
});

export const insertSystem = internalMutation({
  args: {
    campaignId: v.id("campaigns"),
    content: v.string(),
    processed: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("messages", {
      campaignId: args.campaignId,
      kind: "system",
      content: args.content,
      status: "complete",
      ooc: false,
      processed: args.processed ?? true,
    });
  },
});

export const markProcessed = internalMutation({
  args: { messageIds: v.array(v.id("messages")) },
  handler: async (ctx, args) => {
    for (const id of args.messageIds) await ctx.db.patch(id, { processed: true });
  },
});

const STALL_THRESHOLD = 4; // consecutive quiet exploration GM turns before the world intervenes

// Pacing safety net: counts exploration GM turns with no meaningful progress
// (a location or quest-flag change resets the counter). At the threshold it
// injects a one-shot complication directive for the next turn so a dithering
// scene never grinds in place. Self-guards on mode/status; safe to call on every
// non-dice-wait turn — it only counts in exploration.
export const tickStall = internalMutation({
  args: { campaignId: v.id("campaigns") },
  handler: async (ctx, args) => {
    const campaign = await ctx.db.get(args.campaignId);
    if (!campaign || campaign.status !== "active" || campaign.mode !== "exploration") return;
    // Escape hatch: a table can disable the stall-breaker with a quest flag.
    const optOut = await ctx.db
      .query("questFlags")
      .withIndex("by_campaign_key", (q) =>
        q.eq("campaignId", args.campaignId).eq("key", "flag.no_stall_breaker"),
      )
      .unique();
    if (optOut?.value === true) return;

    const count = (campaign.stall?.count ?? 0) + 1;
    if (count < STALL_THRESHOLD) {
      await ctx.db.patch(args.campaignId, { stall: { count } });
      return;
    }
    // Threshold crossed: fire ONE complication directive, reset so we don't spam.
    await ctx.db.patch(args.campaignId, { stall: { count: 0, firedAt: Date.now() } });
    await ctx.db.insert("messages", {
      campaignId: args.campaignId,
      kind: "system",
      content:
        "PACING DIRECTIVE: the scene is stalling — the party is circling without committing. " +
        "Introduce an UNEXPECTED COMPLICATION NOW: an NPC acts, a clock runs out, something " +
        "arrives or erupts. Make the world move, force a fresh decision, and do not re-offer any " +
        "choice you already gave. One concrete event, grounded in the established fiction.",
      status: "complete",
      ooc: true, // GM directive — hidden from players, matches combat directives
      processed: false, // unprocessed → it's in the GM queue for the chained turn
    });
    await enqueueGm(ctx, args.campaignId);
  },
});
