import { ConvexError, v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { requirePlayer } from "./lib/auth";
import { advanceAndSignal } from "./combat";
import { checkPartyWipe } from "./characterOps";
import { rollD20, rollNotation } from "./lib/dice";
import { abilityMod, profBonus, type AbilityKey } from "./lib/rules5e";
import { SKILL_TO_ABILITY } from "./srd/static";
import { enqueueGm } from "./messages";

// Modifier math from the live sheet — the client never supplies numbers.
export function d20ModifierFor(
  character: Doc<"characters">,
  rollType: string,
  ability?: string,
  skill?: string,
): { modifier: number; label: string } {
  const prof = profBonus(character.level);
  if (rollType === "death_save") return { modifier: 0, label: "death save" };
  if (rollType === "initiative") {
    return { modifier: abilityMod(character.abilities.dex), label: "initiative" };
  }
  if (skill) {
    const skillAbility = (SKILL_TO_ABILITY[skill] ?? ability ?? "dex") as AbilityKey;
    const proficient = character.proficiencies.skills.includes(skill);
    return {
      modifier: abilityMod(character.abilities[skillAbility]) + (proficient ? prof : 0),
      label: `${skill} (${skillAbility.toUpperCase()})`,
    };
  }
  const key = (ability ?? "str") as AbilityKey;
  if (rollType === "saving_throw") {
    const proficient = character.proficiencies.savingThrows.includes(key);
    return {
      modifier: abilityMod(character.abilities[key]) + (proficient ? prof : 0),
      label: `${key.toUpperCase()} save`,
    };
  }
  return { modifier: abilityMod(character.abilities[key]), label: `${key.toUpperCase()} check` };
}

// Shared fulfillment: rolls, persists, handles death-save bookkeeping, and
// wakes the GM (or advances the combat turn after a death save).
export async function fulfillCore(
  ctx: MutationCtx,
  roll: Doc<"rolls">,
  character: Doc<"characters">,
  suffix = "",
): Promise<{ total: number }> {
  const { modifier } = d20ModifierFor(character, roll.purpose, roll.ability, roll.skill);
  const outcome = rollD20(roll.advantage, modifier);
  const success = roll.dc !== undefined ? outcome.total >= roll.dc : undefined;
  const crit =
    outcome.d20 === 20 ? ("hit" as const) : outcome.d20 === 1 ? ("miss" as const) : undefined;

  await ctx.db.patch(roll._id, {
    status: "rolled",
    rolledAt: Date.now(),
    notation: outcome.notation,
    dice: outcome.dice,
    modifier,
    total: outcome.total,
    success,
    crit,
  });

  if (roll.purpose === "death_save") {
    const deathSaves = { ...character.deathSaves };
    let note = "";
    if (outcome.d20 === 20) {
      await ctx.db.patch(character._id, {
        currentHp: 1,
        deathSaves: { successes: 0, failures: 0 },
        conditions: character.conditions.filter(
          (c) => c.name !== "unconscious" && c.name !== "stable" && c.name !== "prone",
        ),
      });
      note = " — a miracle: back on their feet with 1 HP!";
    } else {
      if (outcome.d20 === 1) deathSaves.failures += 2;
      else if (outcome.total >= 10) deathSaves.successes += 1;
      else deathSaves.failures += 1;
      let conditions = character.conditions;
      if (deathSaves.successes >= 3) {
        conditions = [...conditions.filter((c) => c.name !== "stable"), { name: "stable" }];
        deathSaves.successes = 0;
        deathSaves.failures = 0;
        note = " — stable, but unconscious.";
      } else if (deathSaves.failures >= 3) {
        conditions = [...conditions, { name: "dead" }];
        note = " — three failures. They are gone.";
      }
      await ctx.db.patch(character._id, { deathSaves, conditions });
      if (conditions.some((c) => c.name === "dead")) {
        await checkPartyWipe(ctx, roll.campaignId);
      }
    }
    await ctx.db.insert("messages", {
      campaignId: roll.campaignId,
      kind: "roll",
      characterName: character.name,
      content: `${character.name} death save${suffix}: ${outcome.total}${note}`,
      status: "complete",
      ooc: false,
      processed: false,
      rollId: roll._id,
    });
    // In combat, the death save IS the dying character's whole turn — advance.
    const campaign = await ctx.db.get(roll.campaignId);
    if (campaign?.mode === "combat" && campaign.activeCombatId) {
      const combat = await ctx.db.get(campaign.activeCombatId);
      if (combat?.status === "active") {
        await advanceAndSignal(ctx, roll.campaignId, combat);
        return { total: outcome.total };
      }
    }
  } else {
    await ctx.db.insert("messages", {
      campaignId: roll.campaignId,
      kind: "roll",
      characterName: character.name,
      content: `${character.name} rolls ${roll.context ?? roll.purpose}${suffix}: ${outcome.total}${crit === "hit" ? " — natural 20!" : crit === "miss" ? " — natural 1!" : ""}`,
      status: "complete",
      ooc: false,
      processed: false,
      rollId: roll._id,
    });
  }

  await enqueueGm(ctx, roll.campaignId);
  return { total: outcome.total };
}

// Player clicks "Roll!" on a GM-requested pending roll.
export const fulfillRequest = mutation({
  args: { sessionToken: v.string(), rollId: v.id("rolls") },
  handler: async (ctx, args) => {
    const player = await requirePlayer(ctx, args.sessionToken);
    const roll = await ctx.db.get(args.rollId);
    if (!roll || roll.campaignId !== player.campaignId) {
      throw new ConvexError({ code: "not_found" });
    }
    if (roll.status !== "pending") throw new ConvexError({ code: "already_rolled" });
    if (!roll.characterId || roll.characterId !== player.characterId) {
      throw new ConvexError({ code: "not_your_roll" });
    }
    const character = await ctx.db.get(roll.characterId);
    if (!character) throw new ConvexError({ code: "not_found" });
    return await fulfillCore(ctx, roll, character);
  },
});

// Player-initiated check from the sheet UI; informational, never wakes the GM.
export const freeRoll = mutation({
  args: {
    sessionToken: v.string(),
    ability: v.optional(v.string()),
    skill: v.optional(v.string()),
    advantage: v.union(v.literal("normal"), v.literal("advantage"), v.literal("disadvantage")),
  },
  handler: async (ctx, args) => {
    const player = await requirePlayer(ctx, args.sessionToken);
    if (!player.characterId) throw new ConvexError({ code: "no_character" });
    const character = await ctx.db.get(player.characterId);
    if (!character) throw new ConvexError({ code: "not_found" });

    const { modifier, label } = d20ModifierFor(
      character,
      "ability_check",
      args.ability,
      args.skill,
    );
    const outcome = rollD20(args.advantage, modifier);
    const rollId = await ctx.db.insert("rolls", {
      campaignId: player.campaignId,
      characterId: character._id,
      actorName: character.name,
      requestedBy: "player",
      purpose: "ability_check",
      context: label,
      skill: args.skill,
      ability: args.ability,
      advantage: args.advantage,
      visibility: "public",
      status: "rolled",
      rolledAt: Date.now(),
      notation: outcome.notation,
      dice: outcome.dice,
      modifier,
      total: outcome.total,
      crit: outcome.d20 === 20 ? "hit" : outcome.d20 === 1 ? "miss" : undefined,
    });
    await ctx.db.insert("messages", {
      campaignId: player.campaignId,
      kind: "roll",
      characterName: character.name,
      content: `${character.name} rolls ${label}: ${outcome.total}`,
      status: "complete",
      ooc: true,
      processed: true,
      rollId,
    });
    return { total: outcome.total };
  },
});

// Used by GM tools (roll_dice) — plain notation roll, optionally public.
export const createNotationRoll = internalMutation({
  args: {
    campaignId: v.id("campaigns"),
    notation: v.string(),
    actorName: v.string(),
    purpose: v.string(),
    visibility: v.union(v.literal("public"), v.literal("secret")),
  },
  handler: async (ctx, args) => {
    const outcome = rollNotation(args.notation);
    if (!outcome) return { ok: false as const, error: `Bad notation '${args.notation}' — use XdY+Z, e.g. 2d6+3` };
    const rollId = await ctx.db.insert("rolls", {
      campaignId: args.campaignId,
      actorName: args.actorName,
      requestedBy: "gm",
      purpose: args.purpose,
      advantage: "normal",
      visibility: args.visibility,
      status: "rolled",
      rolledAt: Date.now(),
      notation: outcome.notation,
      dice: outcome.dice,
      modifier: outcome.modifier,
      total: outcome.total,
    });
    if (args.visibility === "public") {
      await ctx.db.insert("messages", {
        campaignId: args.campaignId,
        kind: "roll",
        characterName: args.actorName,
        content: `${args.actorName}: ${args.notation} (${args.purpose}) = ${outcome.total}`,
        status: "complete",
        ooc: false,
        processed: true,
        rollId,
      });
    }
    return { ok: true as const, rolls: outcome.dice[0].results, total: outcome.total };
  },
});

// Used by the request_player_roll tool — creates the pending roll + banner.
export const createPendingRoll = internalMutation({
  args: {
    campaignId: v.id("campaigns"),
    characterId: v.id("characters"),
    purpose: v.string(),
    ability: v.optional(v.string()),
    skill: v.optional(v.string()),
    dc: v.optional(v.number()),
    advantage: v.union(v.literal("normal"), v.literal("advantage"), v.literal("disadvantage")),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const character = await ctx.db.get(args.characterId);
    if (!character) return { ok: false as const, error: "character not found" };
    const rollId = await ctx.db.insert("rolls", {
      campaignId: args.campaignId,
      characterId: args.characterId,
      actorName: character.name,
      requestedBy: "gm",
      purpose: args.purpose,
      context: args.reason,
      ability: args.ability,
      skill: args.skill,
      advantage: args.advantage,
      dc: args.dc,
      visibility: "public",
      status: "pending",
    });
    return { ok: true as const, rollId };
  },
});

// All pending public rolls for the campaign (the RollPrompt banner data).
export const pendingRolls = query({
  args: { sessionToken: v.string(), campaignId: v.id("campaigns") },
  handler: async (ctx, args) => {
    const player = await requirePlayer(ctx, args.sessionToken, args.campaignId);
    const pending = await ctx.db
      .query("rolls")
      .withIndex("by_campaign_status", (q) =>
        q.eq("campaignId", args.campaignId).eq("status", "pending"),
      )
      .collect();
    return pending
      .filter((r) => r.visibility === "public")
      .map((r) => ({
        _id: r._id,
        actorName: r.actorName,
        purpose: r.purpose,
        context: r.context,
        ability: r.ability,
        skill: r.skill,
        advantage: r.advantage,
        mine: r.characterId === player.characterId,
      }));
  },
});

// AFK guard (combat only): if a pending roll is still unanswered after the
// scheduled delay, the server rolls it, tagged "(auto)".
export const autoFulfillIfPending = internalMutation({
  args: { campaignId: v.id("campaigns"), characterId: v.id("characters") },
  handler: async (ctx, args) => {
    const campaign = await ctx.db.get(args.campaignId);
    if (campaign?.mode !== "combat") return; // exploration rolls wait forever
    const pending = await ctx.db
      .query("rolls")
      .withIndex("by_campaign_status", (q) =>
        q.eq("campaignId", args.campaignId).eq("status", "pending"),
      )
      .collect();
    const roll = pending.find((r) => r.characterId === args.characterId);
    if (!roll) return;
    const character = await ctx.db.get(args.characterId);
    if (!character) return;
    await fulfillCore(ctx, roll, character, " (auto)");
  },
});

// Recent resolved public rolls — the 3D dice animation feed.
export const recentRolls = query({
  args: { sessionToken: v.string(), campaignId: v.id("campaigns") },
  handler: async (ctx, args) => {
    await requirePlayer(ctx, args.sessionToken, args.campaignId);
    const rolls = await ctx.db
      .query("rolls")
      .withIndex("by_campaign_status", (q) =>
        q.eq("campaignId", args.campaignId).eq("status", "rolled"),
      )
      .order("desc")
      .take(24); // combat bursts (multi-attack rounds) can outrun a small window
    return rolls
      .filter((r) => r.visibility === "public" && r.dice)
      .map((r) => ({
        rollId: String(r._id),
        actorName: r.actorName,
        purpose: r.context ?? r.purpose,
        dice: r.dice!,
        total: r.total ?? 0,
        crit: r.crit,
        at: r.rolledAt ?? r._creationTime,
      }));
  },
});
