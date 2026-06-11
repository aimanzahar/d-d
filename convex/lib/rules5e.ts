// Core 5e math — pure functions, shared by character creation, combat, dice.

export type AbilityKey = "str" | "dex" | "con" | "int" | "wis" | "cha";

export const ABILITY_KEYS: AbilityKey[] = ["str", "dex", "con", "int", "wis", "cha"];

export function abilityMod(score: number): number {
  return Math.floor((score - 10) / 2);
}

export function profBonus(level: number): number {
  return 2 + Math.floor((level - 1) / 4);
}

// XP needed to REACH each level (index = level, 1-based).
export const XP_THRESHOLDS = [
  0, 0, 300, 900, 2700, 6500, 14000, 23000, 34000, 48000, 64000, 85000, 100000,
  120000, 140000, 165000, 195000, 225000, 265000, 305000, 355000,
];

export function levelForXp(xp: number): number {
  let level = 1;
  for (let i = 2; i < XP_THRESHOLDS.length; i++) {
    if (xp >= XP_THRESHOLDS[i]) level = i;
  }
  return level;
}

export const STANDARD_ARRAY = [15, 14, 13, 12, 10, 8];

// Point buy: 27 points, scores 8-15 before racial bonuses.
export const POINT_BUY_BUDGET = 27;
const POINT_BUY_COST: Record<number, number> = {
  8: 0, 9: 1, 10: 2, 11: 3, 12: 4, 13: 5, 14: 7, 15: 9,
};

export function pointBuyCost(scores: number[]): number | null {
  let total = 0;
  for (const s of scores) {
    const cost = POINT_BUY_COST[s];
    if (cost === undefined) return null; // out of 8-15 range
    total += cost;
  }
  return total;
}

export function validateBaseScores(
  method: "standard" | "pointbuy",
  scores: Record<AbilityKey, number>,
): boolean {
  const values = ABILITY_KEYS.map((k) => scores[k]);
  if (values.some((v) => typeof v !== "number" || Number.isNaN(v))) return false;
  if (method === "standard") {
    const sorted = [...values].sort((a, b) => b - a);
    const target = [...STANDARD_ARRAY].sort((a, b) => b - a);
    return sorted.length === 6 && sorted.every((v, i) => v === target[i]);
  }
  const cost = pointBuyCost(values);
  return cost !== null && cost <= POINT_BUY_BUDGET;
}

// AC from SRD armor data. armor_class: { base, dex_bonus: boolean, max_bonus? }
export function armorClassFor(opts: {
  dexMod: number;
  conMod: number;
  wisMod: number;
  classIndex: string;
  equippedArmor?: { base: number; dexBonus: boolean; maxBonus?: number } | null;
  hasShield: boolean;
}): number {
  let ac: number;
  if (opts.equippedArmor) {
    const dexPart = opts.equippedArmor.dexBonus
      ? Math.min(opts.dexMod, opts.equippedArmor.maxBonus ?? Infinity)
      : 0;
    ac = opts.equippedArmor.base + dexPart;
  } else if (opts.classIndex === "barbarian") {
    ac = 10 + opts.dexMod + opts.conMod; // Unarmored Defense
  } else if (opts.classIndex === "monk") {
    ac = 10 + opts.dexMod + opts.wisMod; // Unarmored Defense (no shield benefit)
    return opts.hasShield ? ac : ac; // monk UD technically disallows shield; keep base
  } else {
    ac = 10 + opts.dexMod;
  }
  return ac + (opts.hasShield ? 2 : 0);
}
