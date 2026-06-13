// Curated feat catalog (see ADR 0002) — the SRD ships only one feat, so these
// are authored in code. This is the SINGLE source of truth, imported by the
// choice DSL (srd/choice.ts), creation (characters.ts), the combat engine
// (combat.ts), and the GM context (gm/context.ts). Keep it DEPENDENCY-LIGHT
// (types only) so it never forms an import cycle across those modules.

import type { AbilityKey } from "../lib/rules5e";

// An ability-score minimum. `kind: "spellcasting"` means "your class's
// spellcasting ability" (resolved per-class when the feat node is built).
export type FeatPrereq = { ability?: AbilityKey; kind?: "spellcasting"; minScore: number };

// Persistent effects folded into the sheet at create() (and re-applied on level up where noted).
export type FeatEffects = {
  hpPerLevel?: number; // Tough: +2 HP per level
  speedBonus?: number; // Mobile: +10 ft
  initiativeBonus?: number; // Alert: +5 initiative
  abilityBonus?: { ability: AbilityKey; amount: number }; // Heavily Armored: +1 STR
  armorProficiency?: string; // Heavily Armored: "Heavy Armor"
  // Resilient: player picks an ability (via featChoice) — +amount and a save proficiency.
  chooseAbility?: { amount: number; addSaveProficiency?: boolean };
};

// Hooks read by the combat engine. Reaction/grapple/concentration feats are
// approximations (ADR 0004) until those systems exist.
export type FeatCombat = {
  powerToggle?: "gwm" | "sharpshooter"; // optional -5 attack / +10 damage
  bonusAttackOnCritOrKill?: boolean; // GWM: extra attack flagged on crit/kill
  rerollDamagePerTurn?: boolean; // Savage Attacker
  luckPerLongRest?: number; // Lucky: luck points
  grappleAdvantage?: boolean; // Grappler (approx: vs grappled/restrained)
  defensiveDuelist?: boolean; // Defensive Duelist (approx: pre-declared brace)
  concentrationAdvantage?: boolean; // War Caster (narrative, GM-honored)
  noOpportunityFromAttackedTarget?: boolean; // Mobile
  cannotBeSurprised?: boolean; // Alert (narrative)
};

export type FeatDef = {
  index: string;
  name: string;
  prereq: FeatPrereq | null;
  desc: string;
  effects?: FeatEffects;
  combat?: FeatCombat;
};

export const FEATS: Record<string, FeatDef> = {
  grappler: {
    index: "grappler",
    name: "Grappler",
    prereq: { ability: "str", minScore: 13 },
    desc: "You have advantage on attack rolls against a creature you are grappling, and can attempt to pin a creature you have grappled.",
    combat: { grappleAdvantage: true },
  },
  "defensive-duelist": {
    index: "defensive-duelist",
    name: "Defensive Duelist",
    prereq: { ability: "dex", minScore: 13 },
    desc: "When wielding a finesse weapon and another creature hits you with a melee attack, you can brace to add your proficiency bonus to your AC against it.",
    combat: { defensiveDuelist: true },
  },
  "great-weapon-master": {
    index: "great-weapon-master",
    name: "Great Weapon Master",
    prereq: { ability: "str", minScore: 13 },
    desc: "Before a melee attack with a heavy weapon you can take -5 to hit for +10 damage. On a crit or a kill, you get a bonus melee attack.",
    combat: { powerToggle: "gwm", bonusAttackOnCritOrKill: true },
  },
  sharpshooter: {
    index: "sharpshooter",
    name: "Sharpshooter",
    prereq: { ability: "dex", minScore: 13 },
    desc: "Before a ranged weapon attack you can take -5 to hit for +10 damage. Long range and cover trouble you less.",
    combat: { powerToggle: "sharpshooter" },
  },
  "war-caster": {
    index: "war-caster",
    name: "War Caster",
    prereq: { kind: "spellcasting", minScore: 13 },
    desc: "You have advantage on Constitution saves to maintain concentration, and can cast spells as opportunity attacks.",
    combat: { concentrationAdvantage: true },
  },
  "heavily-armored": {
    index: "heavily-armored",
    name: "Heavily Armored",
    prereq: { ability: "str", minScore: 13 },
    desc: "You gain proficiency with heavy armor and increase your Strength by 1.",
    effects: { abilityBonus: { ability: "str", amount: 1 }, armorProficiency: "Heavy Armor" },
  },
  tough: {
    index: "tough",
    name: "Tough",
    prereq: { ability: "con", minScore: 13 },
    desc: "Your hit point maximum increases by 2 for every level you have.",
    effects: { hpPerLevel: 2 },
  },
  "savage-attacker": {
    index: "savage-attacker",
    name: "Savage Attacker",
    prereq: { ability: "str", minScore: 13 },
    desc: "Once per turn when you roll damage for a melee weapon attack, you can reroll the dice and use either total.",
    combat: { rerollDamagePerTurn: true },
  },
  alert: {
    index: "alert",
    name: "Alert",
    prereq: { ability: "dex", minScore: 13 },
    desc: "You gain a +5 bonus to initiative and can't be surprised while conscious.",
    effects: { initiativeBonus: 5 },
    combat: { cannotBeSurprised: true },
  },
  mobile: {
    index: "mobile",
    name: "Mobile",
    prereq: { ability: "dex", minScore: 13 },
    desc: "Your speed increases by 10 feet, and a creature you make a melee attack against can't make opportunity attacks against you this turn.",
    effects: { speedBonus: 10 },
    combat: { noOpportunityFromAttackedTarget: true },
  },
  lucky: {
    index: "lucky",
    name: "Lucky",
    prereq: { ability: "con", minScore: 13 },
    desc: "You have 3 luck points (regained on a long rest). Spend one to reroll an attack roll, ability check, or saving throw.",
    combat: { luckPerLongRest: 3 },
  },
  resilient: {
    index: "resilient",
    name: "Resilient",
    // The flexible feat: no fixed ability gate — you choose which ability gains +1 and a save proficiency.
    prereq: null,
    desc: "Choose one ability score: it increases by 1, and you gain proficiency in saving throws using it.",
    effects: { chooseAbility: { amount: 1, addSaveProficiency: true } },
  },
};

export const FEAT_LIST: FeatDef[] = Object.values(FEATS);
