import { ConvexError, v } from "convex/values";
import { mutation, query, type MutationCtx } from "./_generated/server";
import { requirePlayer } from "./lib/auth";
import {
  ABILITY_KEYS,
  abilityMod,
  armorClassFor,
  validateBaseScores,
  type AbilityKey,
} from "./lib/rules5e";
import { buildChoiceNodes, validateNodePicks, type GrantedItem } from "./srd/choice";
import { getSrd, loadTraits, spellPickPlan } from "./srdData";

const pickValidator = v.object({
  key: v.string(),
  categoryPicks: v.optional(v.array(v.array(v.string()))),
});

export const create = mutation({
  args: {
    sessionToken: v.string(),
    name: v.string(),
    raceIndex: v.string(),
    subraceIndex: v.optional(v.string()),
    classIndex: v.string(),
    alignment: v.optional(v.string()),
    notes: v.string(),
    abilityMethod: v.union(v.literal("standard"), v.literal("pointbuy")),
    baseScores: v.object({
      str: v.number(),
      dex: v.number(),
      con: v.number(),
      int: v.number(),
      wis: v.number(),
      cha: v.number(),
    }),
    submission: v.record(v.string(), v.array(pickValidator)),
    cantrips: v.array(v.string()),
    spells: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const player = await requirePlayer(ctx, args.sessionToken);
    const campaign = await ctx.db.get(player.campaignId);
    if (!campaign) throw new ConvexError({ code: "campaign_not_found" });
    if (campaign.status !== "lobby") throw new ConvexError({ code: "campaign_started" });

    const name = args.name.trim().slice(0, 40);
    if (!name) throw new ConvexError({ code: "missing_name" });

    // --- Load SRD records ---------------------------------------------------
    const race = (await getSrd(ctx, "races", args.raceIndex)).data as any;
    const subrace = args.subraceIndex
      ? ((await getSrd(ctx, "subraces", args.subraceIndex)).data as any)
      : null;
    if (subrace && subrace.race.index !== args.raceIndex) {
      throw new ConvexError({ code: "invalid_subrace" });
    }
    const cls = (await getSrd(ctx, "classes", args.classIndex)).data as any;
    const background = (await getSrd(ctx, "backgrounds", "acolyte")).data as any;
    const traits = await loadTraits(ctx, race, subrace);
    const levels = (await getSrd(ctx, "levels", `${args.classIndex}-1`)).data as any;

    // --- Ability scores -----------------------------------------------------
    if (!validateBaseScores(args.abilityMethod, args.baseScores)) {
      throw new ConvexError({ code: "invalid_ability_scores" });
    }

    // --- Choice DSL validation ----------------------------------------------
    const nodes = buildChoiceNodes({ race, subrace, cls, background, traits });
    const categoryItems = new Map<string, Map<string, string>>();
    for (const node of nodes) {
      for (const opt of node.options) {
        for (const slot of opt.categorySlots) {
          if (!categoryItems.has(slot.category)) {
            const doc = await getSrd(ctx, "equipment-categories", slot.category);
            categoryItems.set(
              slot.category,
              new Map(
                ((doc.data as any).equipment as any[]).map((e) => [e.index, e.name]),
              ),
            );
          }
        }
      }
    }

    const grantedByKind: Record<string, GrantedItem[]> = {};
    for (const node of nodes) {
      const result = validateNodePicks(node, args.submission[node.id], categoryItems);
      if (!result.ok) throw new ConvexError({ code: "invalid_choice", detail: result.error });
      (grantedByKind[node.kind] ??= []).push(...result.granted);
    }

    // --- Final ability scores (base + racial + chosen bonuses) --------------
    const abilities = { ...args.baseScores };
    const racialBonuses = [
      ...(race.ability_bonuses as any[]),
      ...((subrace?.ability_bonuses as any[]) ?? []),
    ];
    for (const b of racialBonuses) {
      abilities[b.ability_score.index as AbilityKey] += b.bonus;
    }
    for (const g of grantedByKind["ability_bonus"] ?? []) {
      if (!ABILITY_KEYS.includes(g.index as AbilityKey)) {
        throw new ConvexError({ code: "invalid_choice", detail: `bad ability ${g.index}` });
      }
      abilities[g.index as AbilityKey] += g.count;
    }

    // --- Proficiencies, bucketed by their SRD type ---------------------------
    const profIndexes = new Set<string>([
      ...(cls.proficiencies as any[]).map((p) => p.index),
      ...((race.starting_proficiencies as any[]) ?? []).map((p: any) => p.index),
      ...((background.starting_proficiencies as any[]) ?? []).map((p: any) => p.index),
      ...traits.flatMap((t: any) => ((t.proficiencies as any[]) ?? []).map((p) => p.index)),
      ...(grantedByKind["proficiency"] ?? []).map((g) => g.index),
    ]);
    const buckets = { skills: [] as string[], armor: [] as string[], weapons: [] as string[], tools: [] as string[] };
    for (const index of profIndexes) {
      const doc = await ctx.db
        .query("srd")
        .withIndex("by_category_index", (q) =>
          q.eq("category", "proficiencies").eq("index", index),
        )
        .unique();
      const type = (doc?.data as any)?.type ?? "Other";
      if (type === "Skills") buckets.skills.push(index.replace(/^skill-/, ""));
      else if (type === "Armor") buckets.armor.push((doc!.data as any).name);
      else if (type === "Weapons") buckets.weapons.push((doc!.data as any).name);
      else if (type === "Artisan's Tools" || type === "Other" || /Tools|Kits|Instruments|Gaming/i.test(type))
        buckets.tools.push((doc?.data as any)?.name ?? index);
    }

    const languages = [
      ...(race.languages as any[]).map((l: any) => l.name),
      ...((subrace?.languages as any[]) ?? []).map((l: any) => l.name),
      ...(grantedByKind["language"] ?? []).map((g) => g.name),
    ];

    // --- Spells --------------------------------------------------------------
    const plan = spellPickPlan(args.classIndex, levels.spellcasting);
    let spellcasting: any = undefined;
    if (plan) {
      const ability = cls.spellcasting.spellcasting_ability.index as AbilityKey;
      const mod = abilityMod(abilities[ability]);
      const expected = plan.count ?? Math.max(1, mod + 1);
      if (args.cantrips.length !== plan.cantrips) {
        throw new ConvexError({ code: "invalid_spells", detail: `pick ${plan.cantrips} cantrips` });
      }
      if (args.spells.length !== expected) {
        throw new ConvexError({ code: "invalid_spells", detail: `pick ${expected} spells` });
      }
      for (const [list, level] of [
        [args.cantrips, 0],
        [args.spells, 1],
      ] as const) {
        const seen = new Set<string>();
        for (const index of list) {
          if (seen.has(index)) throw new ConvexError({ code: "invalid_spells", detail: "duplicates" });
          seen.add(index);
          const doc = await getSrd(ctx, "spells", index);
          const data = doc.data as any;
          if (data.level !== level || !(data.classes as any[]).some((c) => c.index === args.classIndex)) {
            throw new ConvexError({ code: "invalid_spells", detail: `${index} is not legal` });
          }
        }
      }
      // Racial cantrip (e.g. high-elf) rides along separately from class picks
      const traitCantrips = (grantedByKind["spell"] ?? []).map((g) => g.index);
      const preparedCap =
        plan.mode === "spellbook" ? Math.max(1, mod + 1) : expected;
      spellcasting = {
        ability,
        cantrips: [...args.cantrips, ...traitCantrips],
        known: args.spells,
        prepared: args.spells.slice(0, preparedCap),
        slots: Array.from({ length: 9 }, (_, i) => ({
          max: i === 0 ? plan.slotsL1 : 0,
          used: 0,
        })),
      };
    } else if (args.cantrips.length || args.spells.length) {
      // Non-casters may still carry a racial cantrip from the trait node
      const traitCantrips = (grantedByKind["spell"] ?? []).map((g) => g.index);
      if (args.cantrips.length || args.spells.length) {
        if (args.spells.length || args.cantrips.some((c) => !traitCantrips.includes(c))) {
          throw new ConvexError({ code: "invalid_spells", detail: "class cannot cast" });
        }
      }
    }

    // --- Inventory -----------------------------------------------------------
    const inventory = new Map<string, { itemIndex?: string; name: string; quantity: number; equipped: boolean }>();
    const addItem = (index: string | undefined, itemName: string, qty: number) => {
      const key = index ?? `custom:${itemName}`;
      const existing = inventory.get(key);
      if (existing) existing.quantity += qty;
      else inventory.set(key, { itemIndex: index, name: itemName, quantity: qty, equipped: false });
    };
    for (const e of (cls.starting_equipment as any[]) ?? []) {
      addItem(e.equipment.index, e.equipment.name, e.quantity);
    }
    for (const e of (background.starting_equipment as any[]) ?? []) {
      addItem(e.equipment.index, e.equipment.name, e.quantity);
    }
    for (const g of grantedByKind["equipment"] ?? []) addItem(g.index, g.name, g.count);

    // --- Auto-equip best armor + shield, derive AC ---------------------------
    const dexMod = abilityMod(abilities.dex);
    const conMod = abilityMod(abilities.con);
    const wisMod = abilityMod(abilities.wis);
    let bestArmor: { key: string; base: number; dexBonus: boolean; maxBonus?: number; ac: number } | null = null;
    let shieldKey: string | null = null;
    for (const [key, item] of inventory) {
      if (!item.itemIndex) continue;
      const doc = await ctx.db
        .query("srd")
        .withIndex("by_category_index", (q) =>
          q.eq("category", "equipment").eq("index", item.itemIndex!),
        )
        .unique();
      const data = doc?.data as any;
      if (!data?.armor_class) continue;
      if (data.armor_category === "Shield") {
        shieldKey = key;
        continue;
      }
      const candidate = {
        key,
        base: data.armor_class.base,
        dexBonus: !!data.armor_class.dex_bonus,
        maxBonus: data.armor_class.max_bonus ?? undefined,
        ac: data.armor_class.base + (data.armor_class.dex_bonus ? Math.min(dexMod, data.armor_class.max_bonus ?? 99) : 0),
      };
      if (!bestArmor || candidate.ac > bestArmor.ac) bestArmor = candidate;
    }
    if (bestArmor) inventory.get(bestArmor.key)!.equipped = true;
    if (shieldKey) inventory.get(shieldKey)!.equipped = true;

    const ac = armorClassFor({
      dexMod,
      conMod,
      wisMod,
      classIndex: args.classIndex,
      equippedArmor: bestArmor,
      hasShield: shieldKey !== null,
    });

    let maxHp = cls.hit_die + conMod;
    // Dwarven Toughness: +1 max HP per level
    if (traits.some((t: any) => t.index === "dwarven-toughness")) maxHp += 1;

    // --- Persist (re-forging in lobby replaces the old hero) -----------------
    if (player.characterId) {
      await ctx.db.delete(player.characterId);
    }
    const characterId = await ctx.db.insert("characters", {
      campaignId: player.campaignId,
      playerId: player._id,
      name,
      raceIndex: args.raceIndex,
      subraceIndex: args.subraceIndex,
      classIndex: args.classIndex,
      backgroundIndex: "acolyte",
      alignment: args.alignment,
      level: 1,
      xp: 0,
      pendingLevelUp: false,
      abilities,
      maxHp,
      currentHp: maxHp,
      tempHp: 0,
      hitDice: { die: cls.hit_die, max: 1, used: 0 },
      ac,
      speed: race.speed,
      proficiencies: {
        skills: buckets.skills,
        savingThrows: (cls.saving_throws as any[]).map((s) => s.index),
        armor: buckets.armor,
        weapons: buckets.weapons,
        tools: buckets.tools,
        languages,
      },
      conditions: [],
      exhaustion: 0,
      deathSaves: { successes: 0, failures: 0 },
      spellcasting,
      inventory: [...inventory.values()],
      currency: { cp: 0, sp: 0, ep: 0, gp: 15, pp: 0 }, // Acolyte background purse
      featureChoices: {
        submission: args.submission,
        abilityMethod: args.abilityMethod,
        baseScores: args.baseScores,
        subtraits: (grantedByKind["subtrait"] ?? []).map((g) => g.index),
      },
      notes: args.notes.slice(0, 2000),
    });
    await ctx.db.patch(player._id, { characterId });
    return { characterId };
  },
});

export const getMine = query({
  args: { sessionToken: v.string() },
  handler: async (ctx, args) => {
    const player = await requirePlayer(ctx, args.sessionToken);
    if (!player.characterId) return null;
    return await ctx.db.get(player.characterId);
  },
});

export const getParty = query({
  args: { sessionToken: v.string(), campaignId: v.id("campaigns") },
  handler: async (ctx, args) => {
    await requirePlayer(ctx, args.sessionToken, args.campaignId);
    const characters = await ctx.db
      .query("characters")
      .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
      .collect();
    return characters;
  },
});
