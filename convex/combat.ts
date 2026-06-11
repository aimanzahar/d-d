// The combat engine: code enforces initiative, action economy, movement,
// attack/spell math, and death; the GM (via tools) decides tactics and
// narrates. Code-resolved player actions emit messages with NO LLM call —
// the GM narrates the accumulated round when it next wakes (G7).

import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation, mutation, query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { requirePlayer, requireHost } from "./lib/auth";
import { rollD20, rollDie, rollNotation, parseNotation } from "./lib/dice";
import { abilityMod, profBonus, type AbilityKey } from "./lib/rules5e";
import {
  aoeCells,
  chebyshev,
  endableCells,
  key,
  pathTo,
  provokedFrom,
  reachableCells,
  type Cell,
} from "./lib/grid";
import { presetForScene } from "./lib/battleMaps";
import { applyHpDeltaCore, findCharacterByName } from "./characterOps";
import { enqueueGm } from "./messages";

// ---------------------------------------------------------------- helpers

async function activeCombat(ctx: MutationCtx, campaignId: Id<"campaigns">) {
  const campaign = await ctx.db.get(campaignId);
  if (!campaign?.activeCombatId) return null;
  const combat = await ctx.db.get(campaign.activeCombatId);
  return combat?.status === "active" ? { campaign, combat } : null;
}

async function combatMonsters(ctx: MutationCtx, combatId: Id<"combats">) {
  return await ctx.db
    .query("monsters")
    .withIndex("by_combat", (q) => q.eq("combatId", combatId))
    .collect();
}

async function occupancy(
  ctx: MutationCtx,
  campaignId: Id<"campaigns">,
  combatId: Id<"combats">,
) {
  const characters = await ctx.db
    .query("characters")
    .withIndex("by_campaign", (q) => q.eq("campaignId", campaignId))
    .collect();
  const monsters = await combatMonsters(ctx, combatId);
  return { characters, monsters };
}

function fuzzyMonster(monsters: Doc<"monsters">[], label: string) {
  const needle = label.trim().toLowerCase();
  return (
    monsters.find((m) => m.label.toLowerCase() === needle && !m.isDead) ??
    monsters.find((m) => m.label.toLowerCase().startsWith(needle) && !m.isDead) ??
    null
  );
}

// Net advantage from the 5e condition matrix.
function netAdvantage(opts: {
  attackerConditions: string[];
  targetConditions: string[];
  melee: boolean;
}): "normal" | "advantage" | "disadvantage" {
  const a = new Set(opts.attackerConditions);
  const t = new Set(opts.targetConditions);
  let adv = false;
  let dis = false;
  if (t.has("prone")) opts.melee ? (adv = true) : (dis = true);
  for (const c of ["restrained", "stunned", "paralyzed", "unconscious", "petrified", "blinded"]) {
    if (t.has(c)) adv = true;
  }
  if (t.has("dodging")) dis = true;
  if (t.has("invisible")) dis = true;
  for (const c of ["poisoned", "prone", "restrained", "blinded", "frightened"]) {
    if (a.has(c)) dis = true;
  }
  if (a.has("invisible")) adv = true;
  if (adv && dis) return "normal";
  return adv ? "advantage" : dis ? "disadvantage" : "normal";
}

function diceOnly(notation: string): string {
  const parsed = parseNotation(notation);
  return parsed ? `${parsed.count}d${parsed.sides}` : "1d4";
}

async function publicRoll(
  ctx: MutationCtx,
  campaignId: Id<"campaigns">,
  args: {
    actorName: string;
    purpose: string;
    context?: string;
    outcome: ReturnType<typeof rollNotation> & { d20?: number };
    dc?: number;
    success?: boolean;
    crit?: "hit" | "miss";
    message?: string;
    processed?: boolean;
  },
) {
  const rollId = await ctx.db.insert("rolls", {
    campaignId,
    actorName: args.actorName,
    requestedBy: "system",
    purpose: args.purpose,
    context: args.context,
    advantage: "normal",
    visibility: "public",
    status: "rolled",
    rolledAt: Date.now(),
    notation: args.outcome!.notation,
    dice: args.outcome!.dice,
    modifier: args.outcome!.modifier,
    total: args.outcome!.total,
    dc: args.dc,
    success: args.success,
    crit: args.crit,
  });
  if (args.message) {
    await ctx.db.insert("messages", {
      campaignId,
      kind: "roll",
      characterName: args.actorName,
      content: args.message,
      status: "complete",
      ooc: false,
      processed: args.processed ?? true,
      rollId,
    });
  }
  return rollId;
}

// Damage application against monster or character; returns narrative status.
async function damageEntity(
  ctx: MutationCtx,
  target: { kind: "pc"; character: Doc<"characters"> } | { kind: "monster"; monster: Doc<"monsters"> },
  amount: number,
): Promise<{ hpAfter: number; status: string }> {
  if (target.kind === "pc") {
    const result = await applyHpDeltaCore(ctx, target.character, -amount);
    return { hpAfter: result.hpAfter, status: result.status };
  }
  const hpAfter = Math.max(0, target.monster.currentHp - amount);
  const isDead = hpAfter === 0;
  await ctx.db.patch(target.monster._id, { currentHp: hpAfter, isDead });
  return { hpAfter, status: isDead ? "dead" : "ok" };
}

// Advances initiative: skips dead entries, ticks conditions, resets economy.
// Returns the new active entry plus whether the GM must act (monster turn)
// and any auto-created death save.
export async function advanceCore(
  ctx: MutationCtx,
  combat: Doc<"combats">,
): Promise<{ name: string; kind: "pc" | "monster"; round: number; note?: string } | null> {
  const monsters = await combatMonsters(ctx, combat._id);
  let index = combat.activeIndex;
  let round = combat.round;
  for (let hops = 0; hops < combat.initiative.length + 1; hops++) {
    index += 1;
    if (index >= combat.initiative.length) {
      index = 0;
      round += 1;
    }
    const entry = combat.initiative[index];
    if (entry.kind === "monster") {
      const monster = monsters.find((m) => String(m._id) === entry.refId);
      if (!monster || monster.isDead) continue;
      // tick monster condition durations at the start of its turn
      const conditions = monster.conditions.filter(
        (c) => c.expiresRound === undefined || c.expiresRound > round,
      );
      if (conditions.length !== monster.conditions.length) {
        await ctx.db.patch(monster._id, { conditions });
      }
      await ctx.db.patch(combat._id, {
        activeIndex: index,
        round,
        turnState: { movementUsed: 0, actionUsed: false, bonusActionUsed: false, reactionUsed: false },
      });
      return { name: monster.label, kind: "monster", round };
    }
    const character = await ctx.db.get(entry.refId as Id<"characters">);
    if (!character) continue;
    const names = new Set(character.conditions.map((c) => c.name));
    if (names.has("dead")) continue;
    // tick expiring conditions (dodging/disengaged/etc.)
    const conditions = character.conditions.filter(
      (c) => c.expiresRound === undefined || c.expiresRound > round,
    );
    if (conditions.length !== character.conditions.length) {
      await ctx.db.patch(character._id, { conditions });
    }
    await ctx.db.patch(combat._id, {
      activeIndex: index,
      round,
      turnState: { movementUsed: 0, actionUsed: false, bonusActionUsed: false, reactionUsed: false },
    });
    if (names.has("stable")) {
      return { name: character.name, kind: "pc", round, note: "stable_skip" };
    }
    if (names.has("unconscious")) {
      // dying: their turn is a death save (auto-created pending roll)
      await ctx.db.insert("rolls", {
        campaignId: combat.campaignId,
        characterId: character._id,
        actorName: character.name,
        requestedBy: "system",
        purpose: "death_save",
        context: "clinging to life",
        advantage: "normal",
        visibility: "public",
        status: "pending",
      });
      await ctx.scheduler.runAfter(120_000, internal.dice.autoFulfillIfPending, {
        campaignId: combat.campaignId,
        characterId: character._id,
      });
      return { name: character.name, kind: "pc", round, note: "death_save" };
    }
    return { name: character.name, kind: "pc", round };
  }
  return null;
}

// All monsters dead / all PCs down? Returns a hint string for the GM.
export async function checkEndCore(
  ctx: MutationCtx,
  combat: Doc<"combats">,
): Promise<string | null> {
  const monsters = await combatMonsters(ctx, combat._id);
  if (monsters.length > 0 && monsters.every((m) => m.isDead)) {
    return "All enemies are defeated — call end_combat with the outcome, then award_xp.";
  }
  const characters = await ctx.db
    .query("characters")
    .withIndex("by_campaign", (q) => q.eq("campaignId", combat.campaignId))
    .collect();
  const standing = characters.filter(
    (c) => !c.conditions.some((x) => x.name === "unconscious" || x.name === "dead" || x.name === "stable"),
  );
  if (characters.length > 0 && standing.length === 0) {
    return "The entire party is down. Adjudicate: death, capture, or an unlikely rescue. Consider end_combat.";
  }
  return null;
}

async function endCombatCore(
  ctx: MutationCtx,
  campaignId: Id<"campaigns">,
  combat: Doc<"combats">,
  outcome: string,
) {
  await ctx.db.patch(combat._id, { status: "ended", outcome });
  await ctx.db.patch(campaignId, { mode: "exploration", activeCombatId: undefined });
  const characters = await ctx.db
    .query("characters")
    .withIndex("by_campaign", (q) => q.eq("campaignId", campaignId))
    .collect();
  for (const c of characters) {
    await ctx.db.patch(c._id, {
      position: undefined,
      conditions: c.conditions.filter((x) => !["dodging", "disengaged"].includes(x.name)),
    });
  }
}

// Turn-gate: throws unless the caller's character is the active entry.
async function requireActivePc(ctx: MutationCtx, sessionToken: string) {
  const player = await requirePlayer(ctx, sessionToken);
  const state = await activeCombat(ctx, player.campaignId);
  if (!state) throw new ConvexError({ code: "no_combat" });
  const entry = state.combat.initiative[state.combat.activeIndex];
  if (!player.characterId || entry.refId !== String(player.characterId)) {
    throw new ConvexError({ code: "not_your_turn", active: entry.name });
  }
  const character = await ctx.db.get(player.characterId);
  if (!character) throw new ConvexError({ code: "not_found" });
  if (character.conditions.some((c) => ["unconscious", "dead", "stable"].includes(c.name))) {
    throw new ConvexError({ code: "incapacitated" });
  }
  return { player, character, ...state };
}

// After a PC ends their turn (explicitly or via skip): advance, and if a
// monster is next, wake the GM through the standard queue (G5).
export async function advanceAndSignal(ctx: MutationCtx, campaignId: Id<"campaigns">, combat: Doc<"combats">) {
  const fresh = (await ctx.db.get(combat._id))!;
  const next = await advanceCore(ctx, fresh);
  if (!next) return;
  if (next.kind === "monster") {
    await ctx.db.insert("messages", {
      campaignId,
      kind: "system",
      content: `Round ${next.round}: ${next.name} acts. Resolve this creature's turn now — move_token and npc_attack as needed, then advance_turn. Keep resolving consecutive monster turns until a player is up.`,
      status: "complete",
      ooc: true, // GM directive, hidden from players
      processed: false,
    });
    await enqueueGm(ctx, campaignId);
  } else if (next.note === "death_save") {
    await ctx.db.insert("messages", {
      campaignId,
      kind: "system",
      content: `Round ${next.round}: ${next.name} is dying and must make a death saving throw.`,
      status: "complete",
      ooc: false,
      processed: true,
    });
  } else if (next.note === "stable_skip") {
    const fresh2 = (await ctx.db.get(combat._id))!;
    await advanceAndSignal(ctx, campaignId, fresh2); // recurse past stable bodies
  } else {
    await ctx.db.insert("messages", {
      campaignId,
      kind: "system",
      content: `Round ${next.round}: it's ${next.name}'s turn.`,
      status: "complete",
      ooc: false,
      processed: true,
    });
  }
}

// ---------------------------------------------------------------- queries

export const get = query({
  args: { sessionToken: v.string(), campaignId: v.id("campaigns") },
  handler: async (ctx, args) => {
    await requirePlayer(ctx, args.sessionToken, args.campaignId);
    const campaign = await ctx.db.get(args.campaignId);
    if (!campaign?.activeCombatId) return null;
    const combat = await ctx.db.get(campaign.activeCombatId);
    if (!combat || combat.status !== "active") return null;
    const monsters = await ctx.db
      .query("monsters")
      .withIndex("by_combat", (q) => q.eq("combatId", combat._id))
      .collect();
    return {
      _id: combat._id,
      round: combat.round,
      activeIndex: combat.activeIndex,
      initiative: combat.initiative,
      turnState: combat.turnState,
      map: combat.map,
      monsters: monsters.map((m) => ({
        _id: m._id,
        label: m.label,
        srdIndex: m.srdIndex,
        currentHp: m.currentHp,
        maxHp: m.maxHp,
        position: m.position,
        isDead: m.isDead,
        conditions: m.conditions.map((c) => c.name),
      })),
    };
  },
});

// ------------------------------------------------------- player mutations

export const move = mutation({
  args: { sessionToken: v.string(), toX: v.number(), toY: v.number() },
  handler: async (ctx, args) => {
    const { player, character, combat } = await requireActivePc(ctx, args.sessionToken);
    if (!character.position) throw new ConvexError({ code: "no_position" });
    const { characters, monsters } = await occupancy(ctx, player.campaignId, combat._id);

    const blockers = new Set<string>(
      monsters.filter((m) => !m.isDead).map((m) => key(m.position)),
    );
    const passThrough = new Set<string>(
      characters
        .filter((c) => c._id !== character._id && c.position)
        .map((c) => key(c.position!)),
    );
    const budget = character.speed - combat.turnState.movementUsed;
    const reach = reachableCells({
      terrain: combat.map.terrain,
      width: combat.map.width,
      height: combat.map.height,
      start: character.position,
      budgetFeet: budget,
      blockers,
      passThrough,
    });
    const goal = { x: args.toX, y: args.toY };
    const endable = endableCells(reach, passThrough);
    const cost = endable.get(key(goal));
    if (cost === undefined) {
      throw new ConvexError({ code: "unreachable", budget });
    }
    const path = pathTo(reach, character.position, goal)!;
    const provokers = provokedFrom(
      path,
      character.position,
      monsters
        .filter((m) => !m.isDead)
        .map((m) => ({ name: m.label, cell: m.position, reachFeet: Math.max(...m.stats.attacks.map((a) => a.reach), 5) })),
    );
    const disengaged = character.conditions.some((c) => c.name === "disengaged");

    await ctx.db.patch(character._id, { position: goal });
    await ctx.db.patch(combat._id, {
      turnState: { ...combat.turnState, movementUsed: combat.turnState.movementUsed + cost },
    });
    if (provokers.length > 0 && !disengaged) {
      // The GM decides whether the opportunity attack happens (queued, not immediate)
      await ctx.db.insert("messages", {
        campaignId: player.campaignId,
        kind: "system",
        content: `${character.name} moved away from ${provokers.join(", ")} — this may provoke opportunity attacks (your call: npc_attack or let it slide).`,
        status: "complete",
        ooc: true,
        processed: false,
      });
    }
    return { path, cost, provoked: disengaged ? [] : provokers };
  },
});

export const attack = mutation({
  args: { sessionToken: v.string(), targetLabel: v.string(), weaponName: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const { player, character, combat } = await requireActivePc(ctx, args.sessionToken);
    if (combat.turnState.actionUsed) throw new ConvexError({ code: "action_used" });
    const monsters = await combatMonsters(ctx, combat._id);
    const target = fuzzyMonster(monsters, args.targetLabel);
    if (!target) {
      throw new ConvexError({
        code: "no_target",
        candidates: monsters.filter((m) => !m.isDead).map((m) => m.label),
      });
    }

    // Weapon: named, else first equipped weapon, else first weapon, else fists
    const weapons = [];
    for (const item of character.inventory) {
      if (!item.itemIndex) continue;
      const doc = await ctx.db
        .query("srd")
        .withIndex("by_category_index", (q) => q.eq("category", "equipment").eq("index", item.itemIndex!))
        .unique();
      const data = doc?.data as any;
      if (data?.damage) weapons.push({ item, data });
    }
    let weapon = args.weaponName
      ? weapons.find((w) => w.item.name.toLowerCase().includes(args.weaponName!.toLowerCase()))
      : (weapons.find((w) => w.item.equipped) ?? weapons[0]);
    const data = weapon?.data;

    const properties: string[] = (data?.properties ?? []).map((p: any) => p.index);
    const isRanged = data?.weapon_range === "Ranged";
    const finesse = properties.includes("finesse");
    const strMod = abilityMod(character.abilities.str);
    const dexMod = abilityMod(character.abilities.dex);
    const mod = isRanged ? dexMod : finesse ? Math.max(strMod, dexMod) : strMod;
    const prof = profBonus(character.level);

    // Range check
    const dist = chebyshev(character.position!, target.position);
    if (isRanged) {
      const normal = Math.round((data.range?.normal ?? 30) / 5);
      if (dist > normal) {
        throw new ConvexError({ code: "out_of_range", distance: dist * 5, range: data.range?.normal });
      }
    } else {
      const reachCells = properties.includes("reach") ? 2 : 1;
      if (dist > reachCells) {
        throw new ConvexError({ code: "out_of_range", distance: dist * 5, range: reachCells * 5 });
      }
    }

    let advantage = netAdvantage({
      attackerConditions: character.conditions.map((c) => c.name),
      targetConditions: target.conditions.map((c) => c.name),
      melee: !isRanged,
    });
    // Ranged attack with an enemy adjacent = disadvantage
    if (isRanged && monsters.some((m) => !m.isDead && chebyshev(character.position!, m.position) <= 1)) {
      advantage = advantage === "advantage" ? "normal" : "disadvantage";
    }

    const attackRoll = rollD20(advantage, mod + prof);
    const autoCrit =
      !isRanged && dist <= 1 && target.conditions.some((c) => ["paralyzed", "unconscious"].includes(c.name));
    const crit = attackRoll.d20 === 20 || (autoCrit && attackRoll.total >= target.ac);
    const fumble = attackRoll.d20 === 1;
    const hit = !fumble && (attackRoll.d20 === 20 || attackRoll.total >= target.ac);

    const weaponLabel = weapon?.item.name ?? "unarmed strike";
    await publicRoll(ctx, player.campaignId, {
      actorName: character.name,
      purpose: "attack",
      context: `${weaponLabel} vs ${target.label}`,
      outcome: attackRoll,
      dc: target.ac,
      success: hit,
      crit: attackRoll.d20 === 20 ? "hit" : fumble ? "miss" : undefined,
      message: `${character.name} attacks ${target.label} with ${weaponLabel}: ${attackRoll.total} vs AC — ${hit ? (crit ? "CRITICAL HIT!" : "hit!") : "miss."}`,
      processed: false, // GM narrates the accumulated round on its next wake
    });

    let damageTotal = 0;
    if (hit) {
      const baseNotation = `${data?.damage?.damage_dice ?? "1d4"}`.replace(/\s/g, "");
      const parsed = parseNotation(baseNotation) ? baseNotation : "1d4";
      const dmg = rollNotation(parsed)!;
      let total = dmg.total + mod;
      if (crit) total += rollNotation(diceOnly(parsed))!.total;
      damageTotal = Math.max(1, total);
      const result = await damageEntity(ctx, { kind: "monster", monster: target }, damageTotal);
      await publicRoll(ctx, player.campaignId, {
        actorName: character.name,
        purpose: "damage",
        context: `${weaponLabel} damage`,
        outcome: { ...dmg, total: damageTotal, modifier: mod },
        message: `${damageTotal} ${data?.damage?.damage_type?.name?.toLowerCase() ?? ""} damage to ${target.label}${result.status === "dead" ? ` — ${target.label} falls!` : ` (${result.hpAfter}/${target.maxHp} HP)`}`,
        processed: false,
      });
      if (result.status === "dead") {
        const fresh = (await ctx.db.get(combat._id))!;
        const hint = await checkEndCore(ctx, fresh);
        if (hint) {
          await ctx.db.insert("messages", {
            campaignId: player.campaignId,
            kind: "system",
            content: hint,
            status: "complete",
            ooc: true,
            processed: false,
          });
          await enqueueGm(ctx, player.campaignId);
        }
      }
    }

    await ctx.db.patch(combat._id, {
      turnState: { ...combat.turnState, actionUsed: true },
    });
    return { hit, crit, total: attackRoll.total, damage: damageTotal };
  },
});

export const castSpell = mutation({
  args: {
    sessionToken: v.string(),
    spellIndex: v.string(),
    slotLevel: v.optional(v.number()),
    targetLabel: v.optional(v.string()),
    targetCharacterName: v.optional(v.string()),
    originX: v.optional(v.number()),
    originY: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { player, character, combat } = await requireActivePc(ctx, args.sessionToken);
    if (combat.turnState.actionUsed) throw new ConvexError({ code: "action_used" });
    if (!character.spellcasting) throw new ConvexError({ code: "not_a_caster" });

    const doc = await ctx.db
      .query("srd")
      .withIndex("by_category_index", (q) => q.eq("category", "spells").eq("index", args.spellIndex))
      .unique();
    if (!doc) throw new ConvexError({ code: "unknown_spell" });
    const spell = doc.data as any;
    const sc = character.spellcasting;
    const isCantrip = spell.level === 0;
    if (isCantrip ? !sc.cantrips.includes(args.spellIndex) : !sc.prepared.includes(args.spellIndex)) {
      throw new ConvexError({ code: "not_prepared" });
    }
    const slotLevel = isCantrip ? 0 : Math.max(spell.level, args.slotLevel ?? spell.level);
    if (!isCantrip) {
      const slot = sc.slots[slotLevel - 1];
      if (!slot || slot.used >= slot.max) throw new ConvexError({ code: "no_slot", slotLevel });
    }

    const castMod = abilityMod(character.abilities[sc.ability as AbilityKey]);
    const prof = profBonus(character.level);
    const dc = 8 + prof + castMod;
    const monsters = await combatMonsters(ctx, combat._id);

    const expendSlot = async () => {
      if (isCantrip) return;
      const slots = sc.slots.map((s, i) => (i === slotLevel - 1 ? { ...s, used: s.used + 1 } : s));
      await ctx.db.patch(character._id, { spellcasting: { ...sc, slots } });
    };
    const useAction = async () => {
      await ctx.db.patch(combat._id, { turnState: { ...combat.turnState, actionUsed: true } });
    };

    // Healing spells (heal_at_slot_level)
    if (spell.heal_at_slot_level) {
      const targetName = args.targetCharacterName ?? character.name;
      const { character: ally } = await findCharacterByName(ctx, player.campaignId, targetName);
      if (!ally) throw new ConvexError({ code: "no_target" });
      const healDice = String(spell.heal_at_slot_level[String(slotLevel)] ?? "1d8").replace("+ MOD", "").trim();
      const parsed = parseNotation(healDice.replace(/\s/g, "")) ? healDice.replace(/\s/g, "") : "1d8";
      const heal = rollNotation(parsed)!;
      const total = heal.total + castMod;
      await applyHpDeltaCore(ctx, ally, total);
      await expendSlot();
      await useAction();
      await publicRoll(ctx, player.campaignId, {
        actorName: character.name,
        purpose: "healing",
        context: spell.name,
        outcome: { ...heal, total, modifier: castMod },
        message: `${character.name} casts ${spell.name} on ${ally.name} — ${total} HP restored.`,
        processed: false,
      });
      return { healed: total };
    }

    // Damage spells (attack roll or saving throw, single target or AoE)
    if (spell.damage) {
      const diceTable = spell.damage.damage_at_slot_level ?? spell.damage.damage_at_character_level;
      const diceRaw = String(
        diceTable?.[String(slotLevel)] ?? diceTable?.["1"] ?? Object.values(diceTable ?? {})[0] ?? "1d8",
      ).replace(/\s/g, "");
      const notation = parseNotation(diceRaw) ? diceRaw : "1d8";
      const damageType = spell.damage.damage_type?.name?.toLowerCase() ?? "";

      // Work out targets
      let targets: Doc<"monsters">[] = [];
      if (spell.area_of_effect && args.originX !== undefined && args.originY !== undefined) {
        const cells = aoeCells({
          shape: spell.area_of_effect.type,
          sizeFeet: spell.area_of_effect.size,
          origin: character.position!,
          target: { x: args.originX, y: args.originY },
          width: combat.map.width,
          height: combat.map.height,
        });
        const cellSet = new Set(cells.map(key));
        targets = monsters.filter((m) => !m.isDead && cellSet.has(key(m.position)));
        if (targets.length === 0) throw new ConvexError({ code: "no_targets_in_area" });
      } else {
        const target = args.targetLabel ? fuzzyMonster(monsters, args.targetLabel) : null;
        if (!target) {
          throw new ConvexError({
            code: "no_target",
            candidates: monsters.filter((m) => !m.isDead).map((m) => m.label),
          });
        }
        // Range gate
        const rangeFeet = parseInt(String(spell.range).match(/(\d+)/)?.[1] ?? "30", 10);
        const dist = chebyshev(character.position!, target.position) * 5;
        if (String(spell.range).toLowerCase() !== "touch" && dist > rangeFeet) {
          throw new ConvexError({ code: "out_of_range", distance: dist, range: rangeFeet });
        }
        targets = [target];
      }

      await expendSlot();
      await useAction();
      const results: string[] = [];
      for (const target of targets) {
        if (spell.attack_type) {
          // Spell attack vs AC
          const advantage = netAdvantage({
            attackerConditions: character.conditions.map((c) => c.name),
            targetConditions: target.conditions.map((c) => c.name),
            melee: spell.attack_type === "melee",
          });
          const atk = rollD20(advantage, castMod + prof);
          const hit = atk.d20 !== 1 && (atk.d20 === 20 || atk.total >= target.ac);
          let damage = 0;
          if (hit) {
            const dmg = rollNotation(notation)!;
            damage = dmg.total + (atk.d20 === 20 ? rollNotation(diceOnly(notation))!.total : 0);
            await damageEntity(ctx, { kind: "monster", monster: target }, damage);
          }
          await publicRoll(ctx, player.campaignId, {
            actorName: character.name,
            purpose: "attack",
            context: `${spell.name} vs ${target.label}`,
            outcome: atk,
            dc: target.ac,
            success: hit,
            crit: atk.d20 === 20 ? "hit" : atk.d20 === 1 ? "miss" : undefined,
            message: `${character.name} casts ${spell.name} at ${target.label}: ${hit ? `hit — ${damage} ${damageType} damage` : "miss"}.`,
            processed: false,
          });
          results.push(`${target.label}: ${hit ? `${damage} dmg` : "miss"}`);
        } else if (spell.dc) {
          // Target saves vs caster DC
          const saveAbility = String(spell.dc.dc_type?.index ?? "dex") as AbilityKey;
          const saveBonus = Number(target.stats.saveBonuses?.[saveAbility] ?? abilityMod(target.stats.abilities[saveAbility]));
          const save = rollD20("normal", saveBonus);
          const saved = save.total >= dc;
          const dmg = rollNotation(notation)!;
          const halfOnSave = spell.dc.dc_success === "half";
          const damage = saved ? (halfOnSave ? Math.floor(dmg.total / 2) : 0) : dmg.total;
          if (damage > 0) await damageEntity(ctx, { kind: "monster", monster: target }, damage);
          await publicRoll(ctx, player.campaignId, {
            actorName: target.label,
            purpose: "saving_throw",
            context: `${saveAbility.toUpperCase()} save vs ${spell.name}`,
            outcome: save,
            dc,
            success: saved,
            message: `${target.label} ${saved ? "saves against" : "fails to resist"} ${spell.name} — ${damage} ${damageType} damage.`,
            processed: false,
          });
          results.push(`${target.label}: ${damage} dmg${saved ? " (saved)" : ""}`);
        }
      }
      // Deaths → end check
      const fresh = (await ctx.db.get(combat._id))!;
      const hint = await checkEndCore(ctx, fresh);
      if (hint) {
        await ctx.db.insert("messages", {
          campaignId: player.campaignId,
          kind: "system",
          content: hint,
          status: "complete",
          ooc: true,
          processed: false,
        });
        await enqueueGm(ctx, player.campaignId);
      }
      return { results };
    }

    // Utility spell: expend + route to the GM for adjudication (immediate)
    await expendSlot();
    await useAction();
    await ctx.db.insert("messages", {
      campaignId: player.campaignId,
      kind: "player",
      playerId: player._id,
      characterName: character.name,
      content: `casts ${spell.name}${args.targetLabel ? ` at ${args.targetLabel}` : ""} — adjudicate its effect (slot already spent).`,
      status: "complete",
      ooc: false,
      processed: false,
    });
    await enqueueGm(ctx, player.campaignId);
    return { routed: true };
  },
});

export const useSimpleAction = mutation({
  args: {
    sessionToken: v.string(),
    action: v.union(v.literal("dodge"), v.literal("dash"), v.literal("disengage")),
  },
  handler: async (ctx, args) => {
    const { player, character, combat } = await requireActivePc(ctx, args.sessionToken);
    if (combat.turnState.actionUsed) throw new ConvexError({ code: "action_used" });
    if (args.action === "dash") {
      await ctx.db.patch(combat._id, {
        turnState: {
          ...combat.turnState,
          actionUsed: true,
          movementUsed: combat.turnState.movementUsed - character.speed,
        },
      });
    } else {
      await ctx.db.patch(character._id, {
        conditions: [
          ...character.conditions.filter((c) => c.name !== (args.action === "dodge" ? "dodging" : "disengaged")),
          { name: args.action === "dodge" ? "dodging" : "disengaged", expiresRound: combat.round + 1 },
        ],
      });
      await ctx.db.patch(combat._id, {
        turnState: { ...combat.turnState, actionUsed: true },
      });
    }
    await ctx.db.insert("messages", {
      campaignId: player.campaignId,
      kind: "system",
      content: `${character.name} takes the ${args.action[0].toUpperCase()}${args.action.slice(1)} action.`,
      status: "complete",
      ooc: false,
      processed: true,
    });
    return { ok: true };
  },
});

export const endTurn = mutation({
  args: { sessionToken: v.string() },
  handler: async (ctx, args) => {
    const { player, combat } = await requireActivePc(ctx, args.sessionToken);
    await advanceAndSignal(ctx, player.campaignId, combat);
  },
});

export const hostSkipTurn = mutation({
  args: { sessionToken: v.string(), campaignId: v.id("campaigns") },
  handler: async (ctx, args) => {
    await requireHost(ctx, args.sessionToken, args.campaignId);
    const state = await activeCombat(ctx, args.campaignId);
    if (!state) throw new ConvexError({ code: "no_combat" });
    const entry = state.combat.initiative[state.combat.activeIndex];
    await ctx.db.insert("messages", {
      campaignId: args.campaignId,
      kind: "system",
      content: `The host skips ${entry.name}'s turn.`,
      status: "complete",
      ooc: false,
      processed: true,
    });
    await advanceAndSignal(ctx, args.campaignId, state.combat);
  },
});

export const hostRemovePlayer = mutation({
  args: { sessionToken: v.string(), campaignId: v.id("campaigns"), playerId: v.id("players") },
  handler: async (ctx, args) => {
    await requireHost(ctx, args.sessionToken, args.campaignId);
    const target = await ctx.db.get(args.playerId);
    if (!target || target.campaignId !== args.campaignId) throw new ConvexError({ code: "not_found" });
    const state = await activeCombat(ctx, args.campaignId);
    if (state && target.characterId) {
      const idx = state.combat.initiative.findIndex((e) => e.refId === String(target.characterId));
      if (idx !== -1) {
        const initiative = state.combat.initiative.filter((_, i) => i !== idx);
        const activeIndex =
          idx < state.combat.activeIndex ? state.combat.activeIndex - 1 : state.combat.activeIndex;
        const wasActive = idx === state.combat.activeIndex;
        await ctx.db.patch(state.combat._id, {
          initiative,
          activeIndex: Math.max(0, Math.min(activeIndex, initiative.length - 1)),
        });
        if (wasActive) {
          const fresh = (await ctx.db.get(state.combat._id))!;
          await advanceAndSignal(ctx, args.campaignId, { ...fresh, activeIndex: fresh.activeIndex - 1 } as any);
        }
      }
    }
    if (target.characterId) await ctx.db.delete(target.characterId);
    await ctx.db.delete(args.playerId);
    await ctx.db.insert("messages", {
      campaignId: args.campaignId,
      kind: "system",
      content: `${target.nickname} has left the table.`,
      status: "complete",
      ooc: false,
      processed: true,
    });
  },
});

// Safety net: if a GM turn completes while a monster is STILL the active
// combatant (the model forgot advance_turn or ran out of iterations), the
// engine advances for it and queues the next directive so combat never stalls.
export const autoAdvanceIfMonsterStuck = internalMutation({
  args: { campaignId: v.id("campaigns") },
  handler: async (ctx, args) => {
    const state = await activeCombat(ctx, args.campaignId);
    if (!state) return { advanced: false };
    const entry = state.combat.initiative[state.combat.activeIndex];
    if (entry?.kind !== "monster") return { advanced: false };
    const monsters = await combatMonsters(ctx, state.combat._id);
    const monster = monsters.find((m) => String(m._id) === entry.refId);
    if (monster && !monster.isDead) {
      await advanceAndSignal(ctx, args.campaignId, state.combat);
      return { advanced: true, skipped: entry.name };
    }
    // dead active monster: advance silently
    await advanceAndSignal(ctx, args.campaignId, state.combat);
    return { advanced: true };
  },
});

// ------------------------------------------------ GM-tool internal mutations

function parseSpeedFeet(speed: any): number {
  const m = String(speed?.walk ?? "30 ft.").match(/(\d+)/);
  return m ? parseInt(m[1], 10) : 30;
}

function condenseMonster(data: any) {
  const attacks = (data.actions ?? [])
    .filter((a: any) => typeof a.attack_bonus === "number")
    .map((a: any) => ({
      name: a.name,
      attackBonus: a.attack_bonus,
      damageDice: String(a.damage?.[0]?.damage_dice ?? "1d4").replace(/\s/g, ""),
      damageType: a.damage?.[0]?.damage_type?.name ?? "bludgeoning",
      reach: parseInt(String(a.desc ?? "").match(/reach (\d+) ft/)?.[1] ?? "5", 10),
      range: a.desc?.match(/range (\d+)/)
        ? parseInt(String(a.desc).match(/range (\d+)/)![1], 10)
        : undefined,
    }));
  const saveBonuses: Record<string, number> = {};
  for (const p of data.proficiencies ?? []) {
    const m = String(p.proficiency?.index ?? "").match(/^saving-throw-(\w+)$/);
    if (m) saveBonuses[m[1]] = p.value;
  }
  return {
    abilities: {
      str: data.strength ?? 10,
      dex: data.dexterity ?? 10,
      con: data.constitution ?? 10,
      int: data.intelligence ?? 10,
      wis: data.wisdom ?? 10,
      cha: data.charisma ?? 10,
    },
    attacks: attacks.length > 0 ? attacks : [{ name: "Slam", attackBonus: 2, damageDice: "1d4", damageType: "bludgeoning", reach: 5, range: undefined }],
    saveBonuses,
    cr: Number(data.challenge_rating ?? 0),
    xp: Number(data.xp ?? 10),
  };
}

// Spiral outward from a seed cell to find free placements.
function placeTokens(
  count: number,
  seed: Cell,
  map: { width: number; height: number; terrain: string[] },
  taken: Set<string>,
): Cell[] {
  const placed: Cell[] = [];
  for (let radius = 0; radius < Math.max(map.width, map.height) && placed.length < count; radius++) {
    for (let dy = -radius; dy <= radius && placed.length < count; dy++) {
      for (let dx = -radius; dx <= radius && placed.length < count; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
        const c = { x: seed.x + dx, y: seed.y + dy };
        if (c.x < 0 || c.y < 0 || c.x >= map.width || c.y >= map.height) continue;
        if ((map.terrain[c.y]?.[c.x] ?? "#") === "#") continue;
        if (taken.has(key(c))) continue;
        taken.add(key(c));
        placed.push(c);
      }
    }
  }
  return placed;
}

export const toolStartCombat = internalMutation({
  args: {
    campaignId: v.id("campaigns"),
    mapPreset: v.optional(v.string()),
    monsters: v.array(
      v.object({
        srdIndex: v.string(),
        count: v.number(),
      }),
    ),
    surprised: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const campaign = await ctx.db.get(args.campaignId);
    if (!campaign) return { ok: false, error: "campaign missing" };
    if (campaign.activeCombatId) return { ok: false, error: "combat is already running" };
    const totalMonsters = args.monsters.reduce((s, m) => s + Math.max(1, m.count), 0);
    if (totalMonsters === 0 || totalMonsters > 12) {
      return { ok: false, error: "monster count must be 1-12" };
    }

    const preset = presetForScene(args.mapPreset ?? campaign.location.sceneType);
    const characters = (
      await ctx.db
        .query("characters")
        .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
        .collect()
    ).filter((c) => !c.conditions.some((x) => x.name === "dead"));
    if (characters.length === 0) return { ok: false, error: "no living party" };

    const combatId = await ctx.db.insert("combats", {
      campaignId: args.campaignId,
      status: "active",
      round: 1,
      activeIndex: 0,
      initiative: [],
      turnState: { movementUsed: 0, actionUsed: false, bonusActionUsed: false, reactionUsed: false },
      map: {
        width: preset.width,
        height: preset.height,
        terrain: preset.terrain,
        theme: preset.theme as any,
      },
    });

    const taken = new Set<string>();
    // Place party
    const pcCells = placeTokens(characters.length, preset.playerArea, preset, taken);
    for (let i = 0; i < characters.length; i++) {
      await ctx.db.patch(characters[i]._id, { position: pcCells[i] });
    }

    // Spawn monsters
    const initiative: { kind: "pc" | "monster"; refId: string; name: string; total: number; dexMod: number }[] = [];
    const labelCounts: Record<string, number> = {};
    const spawned: string[] = [];
    for (const group of args.monsters) {
      const doc = await ctx.db
        .query("srd")
        .withIndex("by_category_index", (q) => q.eq("category", "monsters").eq("index", group.srdIndex.toLowerCase()))
        .unique();
      if (!doc) {
        return { ok: false, error: `No monster '${group.srdIndex}' in the SRD — use lookup_srd or a valid index like 'goblin', 'wolf', 'skeleton'.` };
      }
      const data = doc.data as any;
      const stats = condenseMonster(data);
      const cells = placeTokens(Math.max(1, group.count), preset.enemyArea, preset, taken);
      for (let i = 0; i < Math.max(1, group.count); i++) {
        labelCounts[doc.name] = (labelCounts[doc.name] ?? 0) + 1;
        const label = group.count > 1 ? `${doc.name} ${labelCounts[doc.name]}` : doc.name;
        const hp = rollNotation(String(data.hit_points_roll ?? "").replace(/\s/g, ""))?.total ?? data.hit_points ?? 7;
        const monsterId = await ctx.db.insert("monsters", {
          campaignId: args.campaignId,
          combatId,
          srdIndex: group.srdIndex.toLowerCase(),
          label,
          maxHp: hp,
          currentHp: hp,
          ac: data.armor_class?.[0]?.value ?? 10,
          speed: parseSpeedFeet(data.speed),
          position: cells[i] ?? preset.enemyArea,
          conditions: [],
          isDead: false,
          stats,
        });
        const dexMod = abilityMod(stats.abilities.dex);
        const roll = rollDie(20);
        initiative.push({ kind: "monster", refId: String(monsterId), name: label, total: roll + dexMod, dexMod });
        spawned.push(label);
      }
    }

    // Party initiative — public roll docs so dice rain on every screen
    for (const c of characters) {
      const dexMod = abilityMod(c.abilities.dex);
      const outcome = rollD20("normal", dexMod);
      initiative.push({ kind: "pc", refId: String(c._id), name: c.name, total: outcome.total, dexMod });
      await publicRoll(ctx, args.campaignId, {
        actorName: c.name,
        purpose: "initiative",
        context: "initiative",
        outcome,
        message: `${c.name} rolls initiative: ${outcome.total}`,
        processed: true,
      });
    }

    initiative.sort((a, b) => b.total - a.total || b.dexMod - a.dexMod);
    await ctx.db.patch(combatId, { initiative });
    await ctx.db.patch(args.campaignId, { mode: "combat", activeCombatId: combatId });

    const order = initiative.map((e, i) => `${i + 1}. ${e.name} (${e.total})`).join("  ");
    await ctx.db.insert("messages", {
      campaignId: args.campaignId,
      kind: "system",
      content: `⚔ Combat begins! Initiative: ${order}`,
      status: "complete",
      ooc: false,
      processed: true,
    });

    const first = initiative[0];
    return {
      ok: true,
      map: preset.key,
      spawned,
      initiative: order,
      firstTurn: `${first.name} (${first.kind})`,
      instruction:
        first.kind === "monster"
          ? "A monster acts first — resolve its turn now (move_token / npc_attack), then advance_turn."
          : "A player acts first. Describe the eruption of combat and STOP — wait for their action.",
    };
  },
});

export const toolNpcAttack = internalMutation({
  args: {
    campaignId: v.id("campaigns"),
    attackerLabel: v.string(),
    targetName: v.string(),
    attackName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const state = await activeCombat(ctx, args.campaignId);
    if (!state) return { ok: false, error: "no active combat" };
    const monsters = await combatMonsters(ctx, state.combat._id);
    const attacker = fuzzyMonster(monsters, args.attackerLabel);
    if (!attacker) {
      return { ok: false, error: `No living monster '${args.attackerLabel}'. Monsters: ${monsters.filter((m) => !m.isDead).map((m) => m.label).join(", ")}` };
    }
    const { character: target, candidates } = await findCharacterByName(ctx, args.campaignId, args.targetName);
    if (!target || !target.position) {
      return { ok: false, error: `No character '${args.targetName}'. Party: ${candidates.join(", ")}` };
    }
    const attack =
      attacker.stats.attacks.find((a) => a.name.toLowerCase() === (args.attackName ?? "").toLowerCase()) ??
      attacker.stats.attacks.find((a) => a.name.toLowerCase().includes((args.attackName ?? "").toLowerCase())) ??
      attacker.stats.attacks[0];

    const dist = chebyshev(attacker.position, target.position) * 5;
    const maxRange = attack.range ?? attack.reach;
    if (dist > maxRange) {
      return {
        ok: false,
        error: `${attacker.label} is ${dist} ft from ${target.name} but ${attack.name} reaches only ${maxRange} ft. move_token closer first.`,
      };
    }

    const advantage = netAdvantage({
      attackerConditions: attacker.conditions.map((c) => c.name),
      targetConditions: target.conditions.map((c) => c.name),
      melee: attack.range === undefined,
    });
    const atk = rollD20(advantage, attack.attackBonus);
    const fumble = atk.d20 === 1;
    const autoCrit =
      attack.range === undefined && dist <= 5 &&
      target.conditions.some((c) => ["paralyzed", "unconscious"].includes(c.name));
    const hit = !fumble && (atk.d20 === 20 || atk.total >= target.ac);
    const crit = hit && (atk.d20 === 20 || autoCrit);

    await publicRoll(ctx, args.campaignId, {
      actorName: attacker.label,
      purpose: "attack",
      context: `${attack.name} vs ${target.name}`,
      outcome: atk,
      dc: target.ac,
      success: hit,
      crit: atk.d20 === 20 ? "hit" : fumble ? "miss" : undefined,
      message: `${attacker.label} attacks ${target.name} with ${attack.name}: ${atk.total} vs AC ${target.ac} — ${hit ? (crit ? "CRITICAL HIT!" : "hit!") : "miss."}`,
      processed: true,
    });

    if (!hit) {
      return { ok: true, hit: false, attackTotal: atk.total, vsAC: target.ac };
    }
    const dmg = rollNotation(attack.damageDice) ?? rollNotation("1d4")!;
    let damage = dmg.total;
    if (crit) damage += rollNotation(diceOnly(attack.damageDice))!.total;
    damage = Math.max(1, damage);
    const result = await applyHpDeltaCore(ctx, target, -damage);
    await publicRoll(ctx, args.campaignId, {
      actorName: attacker.label,
      purpose: "damage",
      context: `${attack.name} damage`,
      outcome: { ...dmg, total: damage },
      message: `${damage} ${attack.damageType.toLowerCase()} damage to ${target.name}${
        result.status === "down" ? ` — ${target.name} DROPS, unconscious and dying!` : result.status === "dead" ? ` — ${target.name} is KILLED outright!` : ` (${result.hpAfter}/${target.maxHp} HP)`
      }`,
      processed: true,
    });
    const hint = await checkEndCore(ctx, (await ctx.db.get(state.combat._id))!);
    return {
      ok: true,
      hit: true,
      crit,
      attackTotal: atk.total,
      damage,
      targetHpAfter: result.hpAfter,
      targetStatus: result.status,
      ...(hint ? { important: hint } : {}),
    };
  },
});

export const toolMoveToken = internalMutation({
  args: {
    campaignId: v.id("campaigns"),
    entityType: v.union(v.literal("monster"), v.literal("character")),
    name: v.string(),
    toX: v.number(),
    toY: v.number(),
    forced: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const state = await activeCombat(ctx, args.campaignId);
    if (!state) return { ok: false, error: "no active combat" };
    const { combat } = state;
    const monsters = await combatMonsters(ctx, combat._id);
    const characters = await ctx.db
      .query("characters")
      .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
      .collect();

    const goal = { x: Math.round(args.toX), y: Math.round(args.toY) };
    if (goal.x < 0 || goal.y < 0 || goal.x >= combat.map.width || goal.y >= combat.map.height) {
      return { ok: false, error: `(${goal.x},${goal.y}) is off the ${combat.map.width}x${combat.map.height} map` };
    }
    if ((combat.map.terrain[goal.y]?.[goal.x] ?? "#") === "#") {
      return { ok: false, error: `(${goal.x},${goal.y}) is a wall` };
    }

    if (args.entityType === "monster") {
      const monster = fuzzyMonster(monsters, args.name);
      if (!monster) return { ok: false, error: `no living monster '${args.name}'` };
      const blockers = new Set<string>([
        ...characters.filter((c) => c.position).map((c) => key(c.position!)),
        ...monsters.filter((m) => !m.isDead && m._id !== monster._id).map((m) => key(m.position)),
      ]);
      if (blockers.has(key(goal))) return { ok: false, error: "destination is occupied" };
      if (!args.forced) {
        const reach = reachableCells({
          terrain: combat.map.terrain,
          width: combat.map.width,
          height: combat.map.height,
          start: monster.position,
          budgetFeet: monster.speed,
          blockers,
          passThrough: new Set(),
        });
        const cost = reach.get(key(goal))?.cost;
        if (cost === undefined) {
          // Offer nearest reachable cell toward the goal as a corrective hint
          let best: { k: string; d: number } | null = null;
          for (const [k] of reach) {
            const [x, y] = k.split(",").map(Number);
            const d = chebyshev({ x, y }, goal);
            if (!best || d < best.d) best = { k, d };
          }
          return {
            ok: false,
            error: `${monster.label} (speed ${monster.speed} ft) can't reach (${goal.x},${goal.y}) this turn.${best ? ` Nearest reachable cell toward it: (${best.k}).` : ""}`,
          };
        }
      }
      await ctx.db.patch(monster._id, { position: goal });
      return { ok: true, moved: monster.label, to: goal };
    }

    const { character } = await findCharacterByName(ctx, args.campaignId, args.name);
    if (!character) return { ok: false, error: `no character '${args.name}'` };
    await ctx.db.patch(character._id, { position: goal }); // GM-forced (shove, teleport)
    return { ok: true, moved: character.name, to: goal, forced: true };
  },
});

export const toolAdvanceTurn = internalMutation({
  args: { campaignId: v.id("campaigns") },
  handler: async (ctx, args) => {
    const state = await activeCombat(ctx, args.campaignId);
    if (!state) return { ok: false, error: "no active combat" };
    // Loop past stable (skipped) bodies
    let next = null;
    for (let hops = 0; hops < state.combat.initiative.length + 1; hops++) {
      const fresh = (await ctx.db.get(state.combat._id))!;
      next = await advanceCore(ctx, fresh);
      if (!next || next.note !== "stable_skip") break;
    }
    if (!next) return { ok: false, error: "initiative is empty" };
    if (next.note === "death_save") {
      return {
        ok: true,
        nextName: next.name,
        nextKind: next.kind,
        round: next.round,
        note: `${next.name} is dying — they must make a death save. STOP and wait.`,
      };
    }
    return {
      ok: true,
      nextName: next.name,
      nextKind: next.kind,
      round: next.round,
      note:
        next.kind === "monster"
          ? `${next.name} acts now — resolve its turn, then advance_turn again.`
          : `${next.name} (a PLAYER) is up. Describe the moment briefly and STOP — do not act for them.`,
    };
  },
});

export const toolEndCombat = internalMutation({
  args: { campaignId: v.id("campaigns"), outcome: v.string(), summary: v.string() },
  handler: async (ctx, args) => {
    const state = await activeCombat(ctx, args.campaignId);
    if (!state) return { ok: false, error: "no active combat" };
    const monsters = await combatMonsters(ctx, state.combat._id);
    const xpPool = monsters.filter((m) => m.isDead).reduce((s, m) => s + m.stats.xp, 0);
    await endCombatCore(ctx, args.campaignId, state.combat, args.outcome);
    await ctx.db.insert("messages", {
      campaignId: args.campaignId,
      kind: "system",
      content: `⚔ Combat ends — ${args.outcome}. ${args.summary}`,
      status: "complete",
      ooc: false,
      processed: true,
    });
    return {
      ok: true,
      defeatedXpTotal: xpPool,
      hint: xpPool > 0 ? `Defeated enemies are worth ${xpPool} XP total — split it with award_xp (amount = per character).` : undefined,
    };
  },
});

export const toolSpawnMonsters = internalMutation({
  args: {
    campaignId: v.id("campaigns"),
    monsters: v.array(v.object({ srdIndex: v.string(), count: v.number() })),
  },
  handler: async (ctx, args) => {
    const state = await activeCombat(ctx, args.campaignId);
    if (!state) return { ok: false, error: "no active combat — use start_combat" };
    const { combat } = state;
    const existing = await combatMonsters(ctx, combat._id);
    const characters = await ctx.db
      .query("characters")
      .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
      .collect();
    const taken = new Set<string>([
      ...existing.filter((m) => !m.isDead).map((m) => key(m.position)),
      ...characters.filter((c) => c.position).map((c) => key(c.position!)),
    ]);
    const preset = presetForScene(combat.map.theme);
    const initiative = [...combat.initiative];
    const spawned: string[] = [];
    for (const group of args.monsters) {
      const doc = await ctx.db
        .query("srd")
        .withIndex("by_category_index", (q) => q.eq("category", "monsters").eq("index", group.srdIndex.toLowerCase()))
        .unique();
      if (!doc) return { ok: false, error: `No monster '${group.srdIndex}'` };
      const data = doc.data as any;
      const stats = condenseMonster(data);
      const baseCount = existing.filter((m) => m.srdIndex === group.srdIndex.toLowerCase()).length;
      const cells = placeTokens(Math.max(1, group.count), preset.enemyArea, combat.map, taken);
      for (let i = 0; i < Math.max(1, group.count); i++) {
        const label = `${doc.name} ${baseCount + i + 1}`;
        const hp = rollNotation(String(data.hit_points_roll ?? "").replace(/\s/g, ""))?.total ?? data.hit_points ?? 7;
        const monsterId = await ctx.db.insert("monsters", {
          campaignId: args.campaignId,
          combatId: combat._id,
          srdIndex: group.srdIndex.toLowerCase(),
          label,
          maxHp: hp,
          currentHp: hp,
          ac: data.armor_class?.[0]?.value ?? 10,
          speed: parseSpeedFeet(data.speed),
          position: cells[i] ?? preset.enemyArea,
          conditions: [],
          isDead: false,
          stats,
        });
        const dexMod = abilityMod(stats.abilities.dex);
        initiative.push({ kind: "monster", refId: String(monsterId), name: label, total: rollDie(20) + dexMod, dexMod });
        spawned.push(label);
      }
    }
    // New arrivals slot into initiative WITHOUT reshuffling already-acted order:
    // simply re-sort entries after the current index... v1: append at end of round.
    await ctx.db.patch(combat._id, { initiative });
    await ctx.db.insert("messages", {
      campaignId: args.campaignId,
      kind: "system",
      content: `Reinforcements: ${spawned.join(", ")} join the fight!`,
      status: "complete",
      ooc: false,
      processed: true,
    });
    return { ok: true, spawned };
  },
});
