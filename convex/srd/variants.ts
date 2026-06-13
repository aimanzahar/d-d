// Curated, non-SRD race/subrace + trait records, seeded via seed:seedVariants
// (see ADR 0002). The single source of every "variant race" (a race/subrace that
// grants a level-1 feat): Drow (Elf subrace), Variant Human, Custom Lineage. Each
// race/subrace blob is shaped exactly like the upstream SRD records the readers
// expect (srdData.ts, srd/choice.ts, characters.ts), plus a synthetic
// `grants_feat: { choose }` marker that buildChoiceNodes turns into a feat node.

import { ABILITY_SCORES, LANGUAGES } from "./static";

type SeedRecord = { category: string; index: string; name: string; data: any };

// Every standard/exotic language except Common, as options_array references.
const bonusLanguageOptions = LANGUAGES.filter((l) => l.index !== "common").map((l) => ({
  option_type: "reference",
  item: { index: l.index, name: l.name, url: (l as any).url },
}));

// +`bonus` to any one ability, as options_array `ability_bonus` options.
const abilityBonusOptions = (bonus: number) =>
  ABILITY_SCORES.map((a) => ({
    option_type: "ability_bonus",
    ability_score: { index: a.index, name: a.name },
    bonus,
  }));

// The 18 SRD skills as proficiency references (indexes match seeded proficiencies).
const SKILLS: [string, string][] = [
  ["acrobatics", "Acrobatics"], ["animal-handling", "Animal Handling"], ["arcana", "Arcana"],
  ["athletics", "Athletics"], ["deception", "Deception"], ["history", "History"],
  ["insight", "Insight"], ["intimidation", "Intimidation"], ["investigation", "Investigation"],
  ["medicine", "Medicine"], ["nature", "Nature"], ["perception", "Perception"],
  ["performance", "Performance"], ["persuasion", "Persuasion"], ["religion", "Religion"],
  ["sleight-of-hand", "Sleight of Hand"], ["stealth", "Stealth"], ["survival", "Survival"],
];
const skillProficiencyOptions = SKILLS.map(([index, label]) => ({
  option_type: "reference",
  item: { index: `skill-${index}`, name: `Skill: ${label}` },
}));

const COMMON = { index: "common", name: "Common", url: "/api/2014/languages/common" };

export const VARIANT_RECORDS: SeedRecord[] = [
  // --- Drow: an Elf subrace (CHA +1, superior darkvision, drow magic, sunlight
  //     sensitivity) that also grants a feat. --------------------------------
  {
    category: "subraces",
    index: "drow",
    name: "Drow",
    data: {
      index: "drow",
      name: "Drow",
      race: { index: "elf", name: "Elf", url: "/api/2014/races/elf" },
      desc:
        "Descended from an earlier subrace of dark-skinned elves, the drow were banished from the surface world for following the goddess Lolth down the path to evil and corruption. Now they have built their own civilization in the depths of the Underdark.",
      ability_bonuses: [
        { ability_score: { index: "cha", name: "CHA", url: "/api/2014/ability-scores/cha" }, bonus: 1 },
      ],
      racial_traits: [
        { index: "drow-superior-darkvision", name: "Superior Darkvision" },
        { index: "drow-magic", name: "Drow Magic" },
        { index: "drow-sunlight-sensitivity", name: "Sunlight Sensitivity" },
      ],
      languages: [],
      grants_feat: { choose: 1 },
    },
  },
  {
    category: "traits",
    index: "drow-superior-darkvision",
    name: "Superior Darkvision",
    data: {
      index: "drow-superior-darkvision",
      name: "Superior Darkvision",
      desc: ["Your darkvision has a radius of 120 feet."],
      proficiencies: [],
      races: [],
      subraces: [{ index: "drow", name: "Drow" }],
    },
  },
  {
    category: "traits",
    index: "drow-magic",
    name: "Drow Magic",
    data: {
      index: "drow-magic",
      name: "Drow Magic",
      desc: [
        "You know the dancing lights cantrip. When you reach higher levels, you also learn faerie fire and darkness. Charisma is your spellcasting ability for these spells.",
      ],
      proficiencies: [],
      trait_specific: {
        spell_options: {
          choose: 1,
          from: {
            option_set_type: "options_array",
            options: [
              {
                option_type: "reference",
                item: { index: "dancing-lights", name: "Dancing Lights", url: "/api/2014/spells/dancing-lights" },
              },
            ],
          },
        },
        type: "spell",
      },
      races: [],
      subraces: [{ index: "drow", name: "Drow" }],
    },
  },
  {
    category: "traits",
    index: "drow-sunlight-sensitivity",
    name: "Sunlight Sensitivity",
    data: {
      index: "drow-sunlight-sensitivity",
      name: "Sunlight Sensitivity",
      desc: [
        "You have disadvantage on attack rolls and on Wisdom (Perception) checks that rely on sight when you, the target of your attack, or whatever you are trying to perceive is in direct sunlight.",
      ],
      proficiencies: [],
      races: [],
      subraces: [{ index: "drow", name: "Drow" }],
    },
  },

  // --- Variant Human: +1 to two abilities of choice, one skill, one feat. ----
  {
    category: "races",
    index: "variant-human",
    name: "Variant Human",
    data: {
      index: "variant-human",
      name: "Variant Human",
      speed: 30,
      size: "Medium",
      size_description: "Humans vary widely in height and build, from barely 5 feet to well over 6 feet tall.",
      alignment: "Humans tend toward no particular alignment. The best and the worst are found among them.",
      age: "Humans reach adulthood in their late teens and live less than a century.",
      ability_bonuses: [],
      ability_bonus_options: {
        choose: 2,
        type: "ability_bonuses",
        from: { option_set_type: "options_array", options: abilityBonusOptions(1) },
      },
      languages: [COMMON],
      language_options: {
        choose: 1,
        type: "languages",
        from: { option_set_type: "options_array", options: bonusLanguageOptions },
      },
      starting_proficiencies: [],
      starting_proficiency_options: {
        choose: 1,
        type: "proficiencies",
        desc: "Skill proficiency of your choice",
        from: { option_set_type: "options_array", options: skillProficiencyOptions },
      },
      traits: [],
      subraces: [],
      grants_feat: { choose: 1 },
    },
  },

  // --- Custom Lineage: +2 to one ability, a skill, a language, a feat.
  //     (Darkvision and size choice are narrative here — darkvision has no
  //     mechanical effect in this engine — captured in a descriptive trait.) --
  {
    category: "races",
    index: "custom-lineage",
    name: "Custom Lineage",
    data: {
      index: "custom-lineage",
      name: "Custom Lineage",
      speed: 30,
      size: "Medium",
      size_description: "Your size is Small or Medium (your choice).",
      alignment: "Custom lineages span every alignment.",
      age: "As varied as the lineages that inspire them.",
      ability_bonuses: [],
      ability_bonus_options: {
        choose: 1,
        type: "ability_bonuses",
        from: { option_set_type: "options_array", options: abilityBonusOptions(2) },
      },
      languages: [COMMON],
      language_options: {
        choose: 1,
        type: "languages",
        from: { option_set_type: "options_array", options: bonusLanguageOptions },
      },
      starting_proficiencies: [],
      starting_proficiency_options: {
        choose: 1,
        type: "proficiencies",
        desc: "Skill proficiency of your choice",
        from: { option_set_type: "options_array", options: skillProficiencyOptions },
      },
      traits: [{ index: "custom-lineage-traits", name: "Custom Lineage" }],
      subraces: [],
      grants_feat: { choose: 1 },
    },
  },
  {
    category: "traits",
    index: "custom-lineage-traits",
    name: "Custom Lineage",
    data: {
      index: "custom-lineage-traits",
      name: "Custom Lineage",
      desc: [
        "You are Small or Medium (your choice). You have darkvision out to 60 feet. You gain one feat of your choice for which you qualify.",
      ],
      proficiencies: [],
      races: [],
      subraces: [],
    },
  },
];
