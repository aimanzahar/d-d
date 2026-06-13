import { ConvexError, v } from "convex/values";
import { query, type QueryCtx } from "./_generated/server";
import { buildChoiceNodes, type ChoiceNode } from "./srd/choice";

export async function getSrd(ctx: QueryCtx, category: string, index: string) {
  const doc = await ctx.db
    .query("srd")
    .withIndex("by_category_index", (q) => q.eq("category", category).eq("index", index))
    .unique();
  if (!doc) throw new ConvexError({ code: "srd_missing", category, index });
  return doc;
}

export const listRaces = query({
  args: {},
  handler: async (ctx) => {
    const races = await ctx.db
      .query("srd")
      .withIndex("by_category_index", (q) => q.eq("category", "races"))
      .collect();
    const subraces = await ctx.db
      .query("srd")
      .withIndex("by_category_index", (q) => q.eq("category", "subraces"))
      .collect();
    return races.map((r) => {
      const d = r.data as any;
      return {
        index: r.index,
        name: r.name,
        speed: d.speed,
        size: d.size,
        bonuses: (d.ability_bonuses as any[]).map(
          (b) => `${b.ability_score.index.toUpperCase()} +${b.bonus}`,
        ),
        hasAbilityChoice: !!d.ability_bonus_options,
        traits: (d.traits as any[]).map((t) => t.name),
        subraces: subraces
          .filter((s) => (s.data as any).race.index === r.index)
          .map((s) => ({
            index: s.index,
            name: s.name,
            bonuses: ((s.data as any).ability_bonuses as any[]).map(
              (b) => `${b.ability_score.index.toUpperCase()} +${b.bonus}`,
            ),
          })),
      };
    });
  },
});

export const listClasses = query({
  args: {},
  handler: async (ctx) => {
    const classes = await ctx.db
      .query("srd")
      .withIndex("by_category_index", (q) => q.eq("category", "classes"))
      .collect();
    return classes.map((c) => {
      const d = c.data as any;
      return {
        index: c.index,
        name: c.name,
        hitDie: d.hit_die,
        saves: (d.saving_throws as any[]).map((s) => s.index.toUpperCase()),
        spellAbility: d.spellcasting?.spellcasting_ability.index ?? null,
        armor: (d.proficiencies as any[])
          .filter((p) => /armor|shield/i.test(p.index))
          .map((p) => p.name),
      };
    });
  },
});

// Most weapons/armor carry no `desc` (only ~109/237 equipment records do), so
// synthesize a one-line description from their structured fields when absent.
function synthDescription(d: any): string {
  if (Array.isArray(d.desc) && d.desc.length) return d.desc.join(" ");
  const parts: string[] = [];
  if (d.damage?.damage_dice) {
    parts.push(`${d.damage.damage_dice} ${d.damage.damage_type?.name ?? ""} damage`.trim());
  }
  if (d.weapon_category) parts.push(`${d.weapon_category} weapon`);
  if (d.range && (d.range.normal || d.range.long)) {
    parts.push(`range ${d.range.normal}${d.range.long ? `/${d.range.long}` : ""} ft`);
  }
  if (Array.isArray(d.properties) && d.properties.length) {
    parts.push(d.properties.map((p: any) => p.name).join(", "));
  }
  if (d.armor_class?.base != null) {
    const dex = d.armor_class.dex_bonus
      ? ` + Dex${d.armor_class.max_bonus != null ? ` (max ${d.armor_class.max_bonus})` : ""}`
      : "";
    parts.push(`AC ${d.armor_class.base}${dex}`);
  }
  if (d.armor_category) parts.push(`${d.armor_category} armor`);
  if (d.str_minimum) parts.push(`requires STR ${d.str_minimum}`);
  if (d.stealth_disadvantage) parts.push("disadvantage on Stealth");
  if (d.cost?.quantity != null) parts.push(`${d.cost.quantity} ${d.cost.unit}`);
  if (d.weight) parts.push(`${d.weight} lb`);
  if (!parts.length && d.equipment_category?.name) parts.push(d.equipment_category.name);
  return parts.join(" · ") || "No description available.";
}

// Lazily-fetched detail for a single equipment item, for the creation hover
// popover. Returns null for unknown/custom indexes so the caller shows the name only.
export const itemDetail = query({
  args: { index: v.string() },
  handler: async (ctx, args) => {
    const doc = await ctx.db
      .query("srd")
      .withIndex("by_category_index", (q) =>
        q.eq("category", "equipment").eq("index", args.index),
      )
      .unique();
    if (!doc) return null;
    return { index: doc.index, name: doc.name, description: synthDescription(doc.data as any) };
  },
});

// Loads trait records for a race + subrace (missing trait docs are skipped).
export async function loadTraits(ctx: QueryCtx, race: any, subrace: any | null) {
  const refs: any[] = [...(race.traits ?? []), ...(subrace?.racial_traits ?? [])];
  const traits: any[] = [];
  for (const ref of refs) {
    const doc = await ctx.db
      .query("srd")
      .withIndex("by_category_index", (q) => q.eq("category", "traits").eq("index", ref.index))
      .unique();
    if (doc) traits.push(doc.data);
  }
  return traits;
}

// Maps every equipment-category referenced by the nodes to its legal items.
export async function loadCategories(ctx: QueryCtx, nodes: ChoiceNode[]) {
  const wanted = new Set<string>();
  for (const node of nodes)
    for (const opt of node.options)
      for (const slot of opt.categorySlots) wanted.add(slot.category);
  const out: Record<string, { index: string; name: string }[]> = {};
  for (const cat of wanted) {
    const doc = await getSrd(ctx, "equipment-categories", cat);
    out[cat] = ((doc.data as any).equipment as any[]).map((e) => ({
      index: e.index,
      name: e.name,
    }));
  }
  return out;
}

export async function loadSpellLists(ctx: QueryCtx, classIndex: string) {
  const lists: Record<0 | 1, { index: string; name: string; school: string }[]> = {
    0: [],
    1: [],
  };
  for (const level of [0, 1] as const) {
    const spells = await ctx.db
      .query("srd")
      .withIndex("by_category_level", (q) =>
        q.eq("category", "spells").eq("spellLevel", level),
      )
      .collect();
    lists[level] = spells
      .filter((s) => ((s.data as any).classes as any[]).some((c) => c.index === classIndex))
      .map((s) => ({
        index: s.index,
        name: s.name,
        school: (s.data as any).school.name,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  return lists;
}

// How many spells beyond cantrips a level-1 caster picks, and what they mean.
export function spellPickPlan(classIndex: string, levelsSpellcasting: any) {
  const slotsL1 = levelsSpellcasting?.spell_slots_level_1 ?? 0;
  if (!slotsL1) return null;
  const cantrips = levelsSpellcasting.cantrips_known ?? 0;
  if (typeof levelsSpellcasting.spells_known === "number") {
    return { mode: "known" as const, cantrips, count: levelsSpellcasting.spells_known, slotsL1 };
  }
  if (classIndex === "wizard") {
    return { mode: "spellbook" as const, cantrips, count: 6, slotsL1 };
  }
  // Prepared casters (cleric, druid): count depends on the casting-ability
  // modifier — resolved as max(1, mod + level) by client preview & server check.
  return { mode: "prepared" as const, cantrips, count: null, slotsL1 };
}

// Everything the creation wizard needs once race + class are chosen.
export const creationData = query({
  args: {
    raceIndex: v.string(),
    subraceIndex: v.optional(v.string()),
    classIndex: v.string(),
  },
  handler: async (ctx, args) => {
    const race = (await getSrd(ctx, "races", args.raceIndex)).data as any;
    const subrace = args.subraceIndex
      ? ((await getSrd(ctx, "subraces", args.subraceIndex)).data as any)
      : null;
    const cls = (await getSrd(ctx, "classes", args.classIndex)).data as any;
    const background = (await getSrd(ctx, "backgrounds", "acolyte")).data as any;
    const traits = await loadTraits(ctx, race, subrace);
    const levels = (await getSrd(ctx, "levels", `${args.classIndex}-1`)).data as any;

    const nodes = buildChoiceNodes({ race, subrace, cls, background, traits });
    const categories = await loadCategories(ctx, nodes);

    const plan = spellPickPlan(args.classIndex, levels.spellcasting);
    const spellLists = plan ? await loadSpellLists(ctx, args.classIndex) : null;

    return {
      summary: {
        speed: race.speed,
        hitDie: cls.hit_die,
        saves: (cls.saving_throws as any[]).map((s: any) => s.index),
        fixedBonuses: [
          ...(race.ability_bonuses as any[]),
          ...((subrace?.ability_bonuses as any[]) ?? []),
        ].map((b: any) => ({ ability: b.ability_score.index, bonus: b.bonus })),
        languages: [
          ...(race.languages as any[]),
          ...((subrace?.languages as any[]) ?? []),
        ].map((l: any) => l.name),
        // Language indexes already known from race + subrace, so the language
        // pickers can grey out duplicates (client-side; server re-checks).
        knownLanguageIndexes: [
          ...(race.languages as any[]),
          ...((subrace?.languages as any[]) ?? []),
        ].map((l: any) => l.index),
        classProficiencies: (cls.proficiencies as any[]).map((p: any) => p.name),
        traitNames: traits.map((t: any) => t.name),
        spellAbility: cls.spellcasting?.spellcasting_ability.index ?? null,
      },
      nodes,
      categories,
      spellPlan: plan,
      spellLists,
    };
  },
});
