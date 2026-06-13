import { ConvexError, v } from "convex/values";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { requirePlayer } from "./lib/auth";
import {
  ABILITY_KEYS,
  abilityMod,
  armorClassFor,
  validateBaseScores,
  type AbilityKey,
} from "./lib/rules5e";
import { buildChoiceNodes, validateNodePicks, type GrantedItem } from "./srd/choice";
import { FEATS } from "./srd/feats";
import { publicStorageUrl } from "./images";
import { getSrd, loadTraits, spellPickPlan } from "./srdData";

const pickValidator = v.object({
  key: v.string(),
  categoryPicks: v.optional(v.array(v.array(v.string()))),
  featChoice: v.optional(v.string()),
});

type InventoryItem = { itemIndex?: string; name: string; quantity: number; equipped: boolean };

// AC from whatever the inventory says is EQUIPPED — flags are player-controlled
// via setEquipped; create() marks its best-armor picks first, then calls this.
export async function deriveArmorAndAc(
  ctx: QueryCtx,
  opts: { classIndex: string; abilities: Record<AbilityKey, number>; inventory: InventoryItem[] },
): Promise<{ ac: number }> {
  let equippedArmor: { base: number; dexBonus: boolean; maxBonus?: number } | null = null;
  let hasShield = false;
  for (const item of opts.inventory) {
    if (!item.equipped || !item.itemIndex) continue;
    const doc = await ctx.db
      .query("srd")
      .withIndex("by_category_index", (q) =>
        q.eq("category", "equipment").eq("index", item.itemIndex!),
      )
      .unique();
    const data = doc?.data as any;
    if (!data?.armor_class) continue;
    if (data.armor_category === "Shield") {
      hasShield = true;
    } else {
      equippedArmor = {
        base: data.armor_class.base,
        dexBonus: !!data.armor_class.dex_bonus,
        maxBonus: data.armor_class.max_bonus ?? undefined,
      };
    }
  }
  return {
    ac: armorClassFor({
      dexMod: abilityMod(opts.abilities.dex),
      conMod: abilityMod(opts.abilities.con),
      wisMod: abilityMod(opts.abilities.wis),
      classIndex: opts.classIndex,
      equippedArmor,
      hasShield,
    }),
  };
}

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
    portraitStorageId: v.optional(v.id("_storage")),
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

    // --- Feats (granted by a variant race) ----------------------------------
    // Validated against the FINAL ability scores computed above. Persistent
    // ability bonuses are applied here — BEFORE the spell/HP/AC math below — so
    // every downstream derivation sees them. Feats are recorded on the sheet;
    // their combat hooks read FEATS at runtime (combat.ts).
    const chosenFeats: { index: string; choices?: any }[] = [];
    let hpPerLevelBonus = 0; // Tough
    let mobileSpeedBonus = 0; // Mobile
    const resilientSaves: string[] = [];
    let hasLucky = false;
    for (const pick of args.submission["race.feat"] ?? []) {
      const feat = FEATS[pick.key];
      if (!feat) throw new ConvexError({ code: "invalid_choice", detail: `unknown feat ${pick.key}` });
      if (feat.prereq) {
        const ability =
          feat.prereq.kind === "spellcasting"
            ? (cls.spellcasting?.spellcasting_ability?.index as AbilityKey | undefined)
            : feat.prereq.ability;
        if (!ability || abilities[ability] < feat.prereq.minScore) {
          throw new ConvexError({ code: "invalid_choice", detail: `${feat.name} prerequisite not met` });
        }
      }
      let choices: { ability: string } | undefined;
      if (feat.effects?.chooseAbility) {
        const ab = pick.featChoice as AbilityKey | undefined;
        if (!ab || !ABILITY_KEYS.includes(ab)) {
          throw new ConvexError({ code: "invalid_choice", detail: `${feat.name} needs an ability choice` });
        }
        abilities[ab] += feat.effects.chooseAbility.amount;
        if (feat.effects.chooseAbility.addSaveProficiency) resilientSaves.push(ab);
        choices = { ability: ab };
      }
      if (feat.effects?.abilityBonus) {
        abilities[feat.effects.abilityBonus.ability] += feat.effects.abilityBonus.amount;
      }
      if (feat.effects?.armorProficiency) buckets.armor.push(feat.effects.armorProficiency);
      if (feat.effects?.hpPerLevel) hpPerLevelBonus += feat.effects.hpPerLevel;
      if (feat.effects?.speedBonus) mobileSpeedBonus += feat.effects.speedBonus;
      if (feat.combat?.luckPerLongRest) hasLucky = true;
      chosenFeats.push({ index: feat.index, ...(choices ? { choices } : {}) });
    }
    const combatResources = chosenFeats.some((f) => FEATS[f.index]?.combat)
      ? { luckPoints: hasLucky ? FEATS.lucky.combat!.luckPerLongRest! : 0 }
      : undefined;

    // Languages: race + subrace auto-grants, plus chosen bonus languages. A
    // player must never pick a language they already know — cross-node dedup is
    // enforced here (validateNodePicks only sees one node at a time). Reject
    // duplicates outright (keyed on language index), then persist unique names.
    const autoLangs = [
      ...(race.languages as any[]),
      ...((subrace?.languages as any[]) ?? []),
    ].map((l: any) => ({ index: l.index, name: l.name }));
    const knownLangIndexes = new Set(autoLangs.map((l) => l.index));
    const seenChosen = new Set<string>();
    for (const g of grantedByKind["language"] ?? []) {
      if (knownLangIndexes.has(g.index) || seenChosen.has(g.index)) {
        throw new ConvexError({ code: "invalid_choice", detail: "duplicate language" });
      }
      seenChosen.add(g.index);
    }
    const languages = [
      ...autoLangs.map((l) => l.name),
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
    let bestArmor: { key: string; ac: number } | null = null;
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
        ac: data.armor_class.base + (data.armor_class.dex_bonus ? Math.min(dexMod, data.armor_class.max_bonus ?? 99) : 0),
      };
      if (!bestArmor || candidate.ac > bestArmor.ac) bestArmor = candidate;
    }
    if (bestArmor) inventory.get(bestArmor.key)!.equipped = true;
    if (shieldKey) inventory.get(shieldKey)!.equipped = true;

    const { ac } = await deriveArmorAndAc(ctx, {
      classIndex: args.classIndex,
      abilities,
      inventory: [...inventory.values()],
    });

    let maxHp = cls.hit_die + conMod;
    // Dwarven Toughness: +1 max HP per level
    if (traits.some((t: any) => t.index === "dwarven-toughness")) maxHp += 1;
    // Tough feat: +2 HP per level (level 1 here; levelUp reapplies the scaling).
    maxHp += hpPerLevelBonus * 1;

    // --- Persist (re-forging in lobby replaces the old hero) -----------------
    if (player.characterId) {
      const prev = await ctx.db.get(player.characterId);
      // Drop the old portrait blob unless the re-forge kept the same one.
      if (prev?.portraitStorageId && prev.portraitStorageId !== args.portraitStorageId) {
        await ctx.storage.delete(prev.portraitStorageId);
      }
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
      speed: race.speed + mobileSpeedBonus,
      proficiencies: {
        skills: buckets.skills,
        savingThrows: [
          ...new Set([...(cls.saving_throws as any[]).map((s) => s.index), ...resilientSaves]),
        ],
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
      feats: chosenFeats,
      combatResources,
      portraitStorageId: args.portraitStorageId,
      notes: args.notes.slice(0, 2000),
    });
    await ctx.db.patch(player._id, { characterId });
    return { characterId };
  },
});

// Custom (index-less) gear can still be wielded if it sounds like a weapon.
const WEAPON_NAME_RE = /sword|dagger|axe|bow|mace|spear|staff|hammer|blade|knife/;

// Equip slot for an item: SRD data decides when indexed, name keywords cover
// custom gear. null = ordinary gear, not equippable.
async function equipSlotFor(
  ctx: QueryCtx,
  item: { itemIndex?: string; name: string },
): Promise<"armor" | "shield" | "weapon" | null> {
  if (item.itemIndex) {
    const doc = await ctx.db
      .query("srd")
      .withIndex("by_category_index", (q) =>
        q.eq("category", "equipment").eq("index", item.itemIndex!),
      )
      .unique();
    const data = doc?.data as any;
    if (data?.armor_class) return data.armor_category === "Shield" ? "shield" : "armor";
    if (data?.damage) return "weapon";
    return null;
  }
  return WEAPON_NAME_RE.test(item.name.toLowerCase()) ? "weapon" : null;
}

async function requireOwnCharacter(ctx: MutationCtx, sessionToken: string) {
  const player = await requirePlayer(ctx, sessionToken);
  if (!player.characterId) throw new ConvexError({ code: "no_character" });
  const character = await ctx.db.get(player.characterId);
  if (!character) throw new ConvexError({ code: "no_character" });
  return character;
}

// Equip/unequip one of your own items. One occupant per slot (armor, shield,
// main-hand weapon) — equipping evicts the current holder. AC follows.
export const setEquipped = mutation({
  args: { sessionToken: v.string(), itemName: v.string(), equipped: v.boolean() },
  handler: async (ctx, args) => {
    const character = await requireOwnCharacter(ctx, args.sessionToken);
    const inventory = character.inventory.map((i) => ({ ...i }));
    const needle = args.itemName.trim().toLowerCase();
    const target = inventory.find((i) => i.name.toLowerCase() === needle);
    if (!target) throw new ConvexError({ code: "item_not_found" });

    const slot = await equipSlotFor(ctx, target);
    if (!slot) throw new ConvexError({ code: "not_equippable" });

    if (args.equipped) {
      for (const other of inventory) {
        if (other === target || !other.equipped) continue;
        if ((await equipSlotFor(ctx, other)) === slot) other.equipped = false;
      }
    }
    target.equipped = args.equipped;

    const { ac } = await deriveArmorAndAc(ctx, {
      classIndex: character.classIndex,
      abilities: character.abilities,
      inventory,
    });
    await ctx.db.patch(character._id, { inventory, ac });
    return { ac };
  },
});

// Splice-move an item within your own pack (drag-to-reorder in the bag grid).
// Name-addressed, not index-addressed: client snapshots go stale between
// optimistic drags, and stale indexes would move the wrong item.
export const reorderInventory = mutation({
  args: { sessionToken: v.string(), movedName: v.string(), targetName: v.string() },
  handler: async (ctx, args) => {
    const character = await requireOwnCharacter(ctx, args.sessionToken);
    const inventory = [...character.inventory];
    const from = inventory.findIndex(
      (i) => i.name.toLowerCase() === args.movedName.toLowerCase(),
    );
    const to = inventory.findIndex(
      (i) => i.name.toLowerCase() === args.targetName.toLowerCase(),
    );
    if (from === -1 || to === -1) throw new ConvexError({ code: "item_not_found" });
    const [moved] = inventory.splice(from, 1);
    inventory.splice(to, 0, moved);
    await ctx.db.patch(character._id, { inventory });
    return null;
  },
});

// Pragmatic level-up: average HP, slots/prof from the SRD levels table,
// new features announced in the feed (subclass/spell picks land in the
// sheet UI later — the mechanical core is correct now).
export const levelUp = mutation({
  args: { sessionToken: v.string() },
  handler: async (ctx, args) => {
    const player = await requirePlayer(ctx, args.sessionToken);
    if (!player.characterId) throw new ConvexError({ code: "no_character" });
    const character = await ctx.db.get(player.characterId);
    if (!character || !character.pendingLevelUp) {
      throw new ConvexError({ code: "no_level_pending" });
    }
    const newLevel = character.level + 1;
    const levels = (await getSrd(ctx, "levels", `${character.classIndex}-${newLevel}`))
      .data as any;
    const conMod = abilityMod(character.abilities.con);
    let hpGain = Math.max(1, Math.ceil((character.hitDice.die + 1) / 2) + conMod);
    // Tough (and any +HP-per-level feat) keeps scaling on level up.
    hpGain += (character.feats ?? []).reduce(
      (sum, f) => sum + (FEATS[f.index]?.effects?.hpPerLevel ?? 0),
      0,
    );

    let spellcasting = character.spellcasting;
    if (spellcasting && levels.spellcasting) {
      const slots = spellcasting.slots.map((s, i) => {
        const max = Number(levels.spellcasting[`spell_slots_level_${i + 1}`] ?? 0);
        return { max, used: Math.min(s.used, max) };
      });
      spellcasting = { ...spellcasting, slots };
    }

    await ctx.db.patch(character._id, {
      level: newLevel,
      pendingLevelUp: false,
      maxHp: character.maxHp + hpGain,
      currentHp: character.currentHp + hpGain,
      hitDice: { ...character.hitDice, max: newLevel },
      ...(spellcasting ? { spellcasting } : {}),
    });

    const features = ((levels.features as any[]) ?? []).map((f) => f.name).join(", ");
    await ctx.db.insert("messages", {
      campaignId: character.campaignId,
      kind: "system",
      content: `✦ ${character.name} reaches level ${newLevel}! +${hpGain} HP${features ? ` — new: ${features}` : ""}`,
      status: "complete",
      ooc: false,
      processed: true,
    });
    return { level: newLevel, hpGain };
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

// Upload URL for a character portrait (free path). The self-hosted upload URL
// is LAN-bound, so the client rewrites it via lib/storageUrl before POSTing.
export const generatePortraitUploadUrl = mutation({
  args: { sessionToken: v.string() },
  handler: async (ctx, args) => {
    await requirePlayer(ctx, args.sessionToken);
    return await ctx.storage.generateUploadUrl();
  },
});

// Resolve a portrait storage id to a public URL (rewritten off the LAN origin).
export const portraitUrl = query({
  args: { storageId: v.optional(v.id("_storage")) },
  handler: async (ctx, args) => {
    if (!args.storageId) return null;
    return publicStorageUrl(await ctx.storage.getUrl(args.storageId));
  },
});
