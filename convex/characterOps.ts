// Internal character-state mutations shared by GM tools, dice fulfillment,
// and (later) the combat engine. All clamping/derivation lives here so the
// LLM can never write raw state.

import { ConvexError, v } from "convex/values";
import { internalMutation } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { deriveArmorAndAc } from "./characters";
import { levelForXp } from "./lib/rules5e";
import { CONDITION_NAMES } from "./srd/static";

export async function findCharacterByName(
  ctx: QueryCtx,
  campaignId: Id<"campaigns">,
  name: string,
): Promise<{ character: Doc<"characters"> | null; candidates: string[] }> {
  const all = await ctx.db
    .query("characters")
    .withIndex("by_campaign", (q) => q.eq("campaignId", campaignId))
    .collect();
  const needle = name.trim().toLowerCase();
  const exact = all.find((c) => c.name.toLowerCase() === needle);
  const partial =
    exact ??
    all.find(
      (c) =>
        c.name.toLowerCase().startsWith(needle) ||
        c.name.toLowerCase().split(/\s+/).includes(needle),
    );
  return { character: partial ?? null, candidates: all.map((c) => c.name) };
}

// HP delta with temp-HP absorption, clamping, and death-state transitions.
// Returns a structured result the GM can narrate from.
export async function applyHpDeltaCore(
  ctx: MutationCtx,
  character: Doc<"characters">,
  delta: number,
): Promise<{ hpBefore: number; hpAfter: number; tempAbsorbed: number; status: "ok" | "down" | "dying_progress" | "dead" }> {
  const hpBefore = character.currentHp;
  let tempAbsorbed = 0;
  let hp = character.currentHp;
  let tempHp = character.tempHp;
  let conditions = [...character.conditions];
  let deathSaves = { ...character.deathSaves };
  let status: "ok" | "down" | "dying_progress" | "dead" = "ok";

  if (delta < 0) {
    let damage = -delta;
    tempAbsorbed = Math.min(tempHp, damage);
    tempHp -= tempAbsorbed;
    damage -= tempAbsorbed;
    const newHp = hp - damage;
    if (newHp <= 0) {
      // Instant death on massive damage (overflow ≥ max HP)
      if (-newHp >= character.maxHp) {
        hp = 0;
        status = "dead";
        conditions = upsertCondition(conditions, "unconscious");
        conditions = upsertCondition(conditions, "dead");
      } else if (hp === 0) {
        // Damage while already at 0: failed death save(s)
        deathSaves.failures += 1;
        status = deathSaves.failures >= 3 ? "dead" : "dying_progress";
        if (status === "dead") conditions = upsertCondition(conditions, "dead");
      } else {
        hp = 0;
        status = "down";
        conditions = upsertCondition(conditions, "unconscious");
        conditions = upsertCondition(conditions, "prone");
        deathSaves = { successes: 0, failures: 0 };
      }
    } else {
      hp = newHp;
    }
  } else {
    if (hp === 0 && delta > 0) {
      // Healing from 0 removes unconscious + resets death saves, and voids
      // any still-pending death-save request
      conditions = conditions.filter((c) => c.name !== "unconscious" && c.name !== "stable");
      deathSaves = { successes: 0, failures: 0 };
      const pending = await ctx.db
        .query("rolls")
        .withIndex("by_campaign_status", (q) =>
          q.eq("campaignId", character.campaignId).eq("status", "pending"),
        )
        .collect();
      for (const roll of pending) {
        if (roll.characterId === character._id && roll.purpose === "death_save") {
          await ctx.db.delete(roll._id);
        }
      }
    }
    hp = Math.min(character.maxHp, hp + delta);
  }

  await ctx.db.patch(character._id, { currentHp: hp, tempHp, conditions, deathSaves });
  return { hpBefore, hpAfter: hp, tempAbsorbed, status };
}

function upsertCondition(
  conditions: Doc<"characters">["conditions"],
  name: string,
): Doc<"characters">["conditions"] {
  if (conditions.some((c) => c.name === name)) return conditions;
  return [...conditions, { name }];
}

export const applyHpDelta = internalMutation({
  args: { characterId: v.id("characters"), delta: v.number() },
  handler: async (ctx, args) => {
    const character = await ctx.db.get(args.characterId);
    if (!character) throw new ConvexError({ code: "not_found" });
    return applyHpDeltaCore(ctx, character, args.delta);
  },
});

export const setCondition = internalMutation({
  args: {
    characterId: v.id("characters"),
    condition: v.string(),
    action: v.union(v.literal("add"), v.literal("remove")),
    durationRounds: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const valid = [...CONDITION_NAMES, "stable", "dead", "dodging", "disengaged"];
    if (!valid.includes(args.condition)) {
      return { ok: false, error: `Unknown condition '${args.condition}'. Valid: ${valid.join(", ")}` };
    }
    const character = await ctx.db.get(args.characterId);
    if (!character) return { ok: false, error: "character not found" };
    let conditions = character.conditions.filter((c) => c.name !== args.condition);
    if (args.action === "add") {
      conditions = [...conditions, { name: args.condition, expiresRound: args.durationRounds }];
    }
    await ctx.db.patch(args.characterId, { conditions });
    return { ok: true, conditions: conditions.map((c) => c.name) };
  },
});

export const modifyInventory = internalMutation({
  args: {
    characterId: v.id("characters"),
    action: v.union(v.literal("add"), v.literal("remove")),
    itemIndex: v.optional(v.string()),
    itemName: v.string(),
    quantity: v.number(),
    goldDelta: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const character = await ctx.db.get(args.characterId);
    if (!character) return { ok: false, error: "character not found" };
    const inventory = [...character.inventory];
    const qty = Math.max(1, Math.floor(args.quantity));
    if (args.action === "add") {
      const existing = inventory.find(
        (i) =>
          (args.itemIndex && i.itemIndex === args.itemIndex) ||
          i.name.toLowerCase() === args.itemName.toLowerCase(),
      );
      if (existing) existing.quantity += qty;
      else inventory.push({ itemIndex: args.itemIndex, name: args.itemName, quantity: qty, equipped: false });
    }
    let lostEquipped = false;
    if (args.action === "remove") {
      const idx = inventory.findIndex(
        (i) => i.name.toLowerCase() === args.itemName.toLowerCase() || i.itemIndex === args.itemIndex,
      );
      if (idx === -1) {
        return {
          ok: false,
          error: `${character.name} has no '${args.itemName}'. Inventory: ${inventory.map((i) => i.name).join(", ")}`,
        };
      }
      inventory[idx].quantity -= qty;
      if (inventory[idx].quantity <= 0) {
        lostEquipped = inventory[idx].equipped;
        inventory.splice(idx, 1);
      }
    }
    const currency = { ...character.currency };
    if (args.goldDelta) {
      currency.gp = Math.max(0, currency.gp + args.goldDelta);
    }
    // Losing equipped armor/shield changes AC — phantom +2s must not linger.
    const patch: Record<string, unknown> = { inventory, currency };
    if (lostEquipped) {
      const { ac } = await deriveArmorAndAc(ctx, {
        classIndex: character.classIndex,
        abilities: character.abilities,
        inventory,
      });
      patch.ac = ac;
    }
    await ctx.db.patch(args.characterId, patch);
    return { ok: true, gold: currency.gp };
  },
});

export const awardXp = internalMutation({
  args: { characterIds: v.array(v.id("characters")), amount: v.number() },
  handler: async (ctx, args) => {
    const leveled: string[] = [];
    for (const id of args.characterIds) {
      const character = await ctx.db.get(id);
      if (!character) continue;
      const xp = character.xp + Math.max(0, Math.floor(args.amount));
      const newLevel = levelForXp(xp);
      await ctx.db.patch(id, {
        xp,
        pendingLevelUp: character.pendingLevelUp || newLevel > character.level,
      });
      if (newLevel > character.level) leveled.push(character.name);
    }
    return { ok: true, leveled };
  },
});

export const expendSlot = internalMutation({
  args: { characterId: v.id("characters"), slotLevel: v.number() },
  handler: async (ctx, args) => {
    const character = await ctx.db.get(args.characterId);
    if (!character?.spellcasting) return { ok: false, error: "not a spellcaster" };
    const idx = args.slotLevel - 1;
    const slot = character.spellcasting.slots[idx];
    if (!slot || slot.max === 0) return { ok: false, error: `no level-${args.slotLevel} slots` };
    if (slot.used >= slot.max) {
      return { ok: false, error: `no level-${args.slotLevel} slots remaining (${slot.used}/${slot.max} used)` };
    }
    const slots = character.spellcasting.slots.map((s, i) =>
      i === idx ? { ...s, used: s.used + 1 } : s,
    );
    await ctx.db.patch(args.characterId, {
      spellcasting: { ...character.spellcasting, slots },
    });
    return { ok: true, remaining: slot.max - slot.used - 1 };
  },
});

export const applyRest = internalMutation({
  args: {
    characterIds: v.array(v.id("characters")),
    type: v.union(v.literal("short"), v.literal("long")),
  },
  handler: async (ctx, args) => {
    for (const id of args.characterIds) {
      const character = await ctx.db.get(id);
      if (!character || character.conditions.some((c) => c.name === "dead")) continue;
      if (args.type === "long") {
        const spellcasting = character.spellcasting
          ? {
              ...character.spellcasting,
              slots: character.spellcasting.slots.map((s) => ({ ...s, used: 0 })),
            }
          : undefined;
        await ctx.db.patch(id, {
          currentHp: character.maxHp,
          tempHp: 0,
          hitDice: {
            ...character.hitDice,
            used: Math.max(0, character.hitDice.used - Math.max(1, Math.floor(character.hitDice.max / 2))),
          },
          exhaustion: Math.max(0, character.exhaustion - 1),
          deathSaves: { successes: 0, failures: 0 },
          conditions: character.conditions.filter((c) => c.name === "dead"),
          ...(spellcasting ? { spellcasting } : {}),
        });
      }
      // Short rest: hit-dice spending arrives with the sheet UI later; the
      // GM narrates breathers without mechanical change for now.
    }
    return { ok: true };
  },
});
