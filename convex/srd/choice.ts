// The SRD choice DSL, normalized. Every "choose N from …" in race/class/
// background/trait records becomes a ChoiceNode; every selectable option is
// flattened to { grants, categorySlots } so references, counted references,
// bundles ("multiple") and nested equipment-category choices all share one
// shape. The client renders nodes; the server re-resolves and validates the
// submission against the same nodes (no trusting the client).

import { FEAT_LIST } from "./feats";
import { LANGUAGES } from "./static";

export type GrantedItem = { index: string; name: string; count: number };
export type CategorySlot = { category: string; categoryName: string; choose: number };

// An ability-score prerequisite carried to the client for live gating (feats).
export type ChoicePrereq = { ability?: string; minScore: number };

export type ChoiceOption = {
  key: string;
  label: string;
  grants: GrantedItem[];
  categorySlots: CategorySlot[];
  prereq?: ChoicePrereq; // feat options only
  desc?: string; // feat options only (1-line flavor for the card)
};

export type ChoiceKind =
  | "proficiency"
  | "language"
  | "ability_bonus"
  | "equipment"
  | "spell"
  | "subtrait"
  | "feat";

export type ChoiceNode = {
  id: string;
  label: string;
  kind: ChoiceKind;
  choose: number;
  options: ChoiceOption[];
};

// One selected option within a node; categoryPicks[i] holds the equipment
// indexes chosen for option.categorySlots[i] (length must equal slot.choose).
// featChoice carries a feat's internal sub-pick (e.g. Resilient's ability).
export type ChoicePick = { key: string; categoryPicks?: string[][]; featChoice?: string };
export type Submission = Record<string, ChoicePick[]>;

function cleanLabel(name: string): string {
  return name.replace(/^Skill: /, "");
}

function parseOption(opt: any, key: string): ChoiceOption {
  switch (opt.option_type) {
    case "reference":
      return {
        key,
        label: cleanLabel(opt.item.name),
        grants: [{ index: opt.item.index, name: cleanLabel(opt.item.name), count: 1 }],
        categorySlots: [],
      };
    case "counted_reference":
      return {
        key,
        label: opt.count > 1 ? `${opt.of.name} ×${opt.count}` : opt.of.name,
        grants: [{ index: opt.of.index, name: opt.of.name, count: opt.count }],
        categorySlots: [],
      };
    case "ability_bonus":
      return {
        key,
        label: `${opt.ability_score.name} +${opt.bonus}`,
        grants: [
          { index: opt.ability_score.index, name: opt.ability_score.name, count: opt.bonus },
        ],
        categorySlots: [],
      };
    case "choice": {
      const inner = opt.choice;
      if (inner.from.option_set_type !== "equipment_category") {
        throw new Error(`Unsupported nested choice set: ${inner.from.option_set_type}`);
      }
      const cat = inner.from.equipment_category;
      return {
        key,
        label: inner.desc ?? `Choose ${inner.choose} from ${cat.name}`,
        grants: [],
        categorySlots: [
          { category: cat.index, categoryName: cat.name, choose: inner.choose },
        ],
      };
    }
    case "multiple": {
      const parts = (opt.items as any[]).map((item, i) => parseOption(item, `${key}.${i}`));
      return {
        key,
        label: parts.map((p) => p.label).join(" + "),
        grants: parts.flatMap((p) => p.grants),
        categorySlots: parts.flatMap((p) => p.categorySlots),
      };
    }
    default:
      throw new Error(`Unsupported option_type: ${opt.option_type}`);
  }
}

const ALL_LANGUAGE_OPTIONS: ChoiceOption[] = LANGUAGES.map((l) => ({
  key: l.index,
  label: l.name,
  grants: [{ index: l.index, name: l.name, count: 1 }],
  categorySlots: [],
}));

// Normalizes one SRD `{ choose, from }` block into a ChoiceNode.
export function parseChoice(
  id: string,
  kind: ChoiceKind,
  label: string,
  raw: any,
): ChoiceNode {
  const setType = raw.from.option_set_type;
  if (setType === "options_array") {
    return {
      id,
      kind,
      label,
      choose: raw.choose,
      options: (raw.from.options as any[]).map((o, i) => parseOption(o, `o${i}`)),
    };
  }
  if (setType === "equipment_category") {
    const cat = raw.from.equipment_category;
    return {
      id,
      kind,
      label,
      choose: 1, // one option that itself holds the category slot
      options: [
        {
          key: "cat",
          label: `Choose ${raw.choose} from ${cat.name}`,
          grants: [],
          categorySlots: [
            { category: cat.index, categoryName: cat.name, choose: raw.choose },
          ],
        },
      ],
    };
  }
  if (setType === "resource_list") {
    // Only used for "any language" picks in the SRD.
    return { id, kind, label, choose: raw.choose, options: ALL_LANGUAGE_OPTIONS };
  }
  throw new Error(`Unsupported option_set_type: ${setType}`);
}

// Builds every choice node for a race/subrace/class/background combination.
// `traits` are the full SRD trait records for race + subrace.
export function buildChoiceNodes(opts: {
  race: any;
  subrace: any | null;
  cls: any;
  background: any;
  traits: any[];
}): ChoiceNode[] {
  const nodes: ChoiceNode[] = [];
  const { race, subrace, cls, background, traits } = opts;

  (cls.proficiency_choices as any[]).forEach((pc, i) => {
    nodes.push(parseChoice(`class.prof.${i}`, "proficiency", pc.desc ?? "Choose proficiencies", pc));
  });

  if (race.language_options) {
    nodes.push(parseChoice("race.lang", "language", "Bonus language", race.language_options));
  }
  if (race.ability_bonus_options) {
    nodes.push(
      parseChoice("race.abil", "ability_bonus", "Ability score increases", race.ability_bonus_options),
    );
  }
  // Racial proficiency choices (variant human skill, dwarf/half-elf/half-orc) —
  // previously dropped; emitting them here makes those picks selectable.
  if (race.starting_proficiency_options) {
    nodes.push(
      parseChoice(
        "race.prof",
        "proficiency",
        race.starting_proficiency_options.desc ?? "Skill proficiency",
        race.starting_proficiency_options,
      ),
    );
  }
  if (subrace?.language_options) {
    nodes.push(parseChoice("subrace.lang", "language", "Bonus language", subrace.language_options));
  }

  // Feat node: emitted when the race or subrace grants a level-1 feat (variant
  // races). Each FEATS entry becomes a choose-1 option carrying its prereq, so
  // the client can grey out feats the final ability scores don't meet.
  if (race.grants_feat || subrace?.grants_feat) {
    const castingAbility = cls.spellcasting?.spellcasting_ability?.index as string | undefined;
    nodes.push({
      id: "race.feat",
      kind: "feat",
      label: "Feat",
      choose: 1,
      options: FEAT_LIST.map((f) => ({
        key: f.index,
        label: f.name,
        desc: f.desc,
        grants: [],
        categorySlots: [],
        prereq: f.prereq
          ? {
              ability: f.prereq.kind === "spellcasting" ? castingAbility : f.prereq.ability,
              minScore: f.prereq.minScore,
            }
          : undefined,
      })),
    });
  }

  for (const trait of traits) {
    if (trait.language_options) {
      nodes.push(
        parseChoice(`trait.${trait.index}.lang`, "language", trait.name, trait.language_options),
      );
    }
    if (trait.trait_specific?.spell_options) {
      nodes.push(
        parseChoice(`trait.${trait.index}.spell`, "spell", trait.name, trait.trait_specific.spell_options),
      );
    }
    if (trait.trait_specific?.subtrait_options) {
      nodes.push(
        parseChoice(`trait.${trait.index}.sub`, "subtrait", trait.name, trait.trait_specific.subtrait_options),
      );
    }
  }

  (cls.starting_equipment_options as any[]).forEach((eq, i) => {
    nodes.push(parseChoice(`class.equip.${i}`, "equipment", eq.desc ?? "Choose equipment", eq));
  });
  (background.starting_equipment_options as any[] | undefined)?.forEach((eq, i) => {
    nodes.push(parseChoice(`bg.equip.${i}`, "equipment", eq.desc ?? "Choose equipment", eq));
  });
  if (background.language_options) {
    nodes.push(parseChoice("bg.lang", "language", "Two languages of your choice", background.language_options));
  }

  return nodes;
}

export type ValidationResult =
  | { ok: true; granted: GrantedItem[] }
  | { ok: false; error: string };

// Validates one node's picks and returns everything they grant.
// `categoryItems` maps equipment-category index -> Set of legal equipment indexes.
export function validateNodePicks(
  node: ChoiceNode,
  picks: ChoicePick[] | undefined,
  categoryItems: Map<string, Map<string, string>>,
): ValidationResult {
  if (!picks || picks.length !== node.choose) {
    return { ok: false, error: `${node.id}: expected ${node.choose} pick(s)` };
  }
  // Distinct selections for pick-N-of lists (equipment nodes are choose:1 anyway)
  if (new Set(picks.map((p) => p.key)).size !== picks.length) {
    return { ok: false, error: `${node.id}: duplicate picks` };
  }
  const granted: GrantedItem[] = [];
  for (const pick of picks) {
    const option = node.options.find((o) => o.key === pick.key);
    if (!option) return { ok: false, error: `${node.id}: unknown option '${pick.key}'` };
    granted.push(...option.grants);
    const slots = option.categorySlots;
    const catPicks = pick.categoryPicks ?? [];
    if (catPicks.length !== slots.length) {
      return { ok: false, error: `${node.id}/${pick.key}: expected ${slots.length} category slot(s)` };
    }
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      const chosen = catPicks[i];
      if (!chosen || chosen.length !== slot.choose) {
        return {
          ok: false,
          error: `${node.id}/${pick.key}: pick ${slot.choose} from ${slot.categoryName}`,
        };
      }
      const legal = categoryItems.get(slot.category);
      for (const idx of chosen) {
        const name = legal?.get(idx);
        if (!name) {
          return { ok: false, error: `${node.id}/${pick.key}: '${idx}' is not in ${slot.categoryName}` };
        }
        granted.push({ index: idx, name, count: 1 });
      }
    }
  }
  return { ok: true, granted };
}
