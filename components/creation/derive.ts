import type { AbilityKey } from "@/lib/abilities";
import type { ChoicePick, CreationData } from "./types";

// Ability bonuses chosen via the race.abil node, by ability index and their TRUE
// amount — read from the node's option grants, not assumed to be +1. Custom
// Lineage grants +2; half-elf grants +1 each. (The option key is "o0"/"o1", not
// the ability index, so the grant's index/count is the only correct source.)
export function raceAbilBonuses(
  data: CreationData | undefined,
  submission: Record<string, ChoicePick[]>,
): Map<AbilityKey, number> {
  const out = new Map<AbilityKey, number>();
  const node = data?.nodes.find((n) => n.id === "race.abil");
  if (!node) return out;
  for (const pick of submission["race.abil"] ?? []) {
    const grant = node.options.find((o) => o.key === pick.key)?.grants[0];
    if (grant) {
      out.set(grant.index as AbilityKey, (out.get(grant.index as AbilityKey) ?? 0) + grant.count);
    }
  }
  return out;
}

// Final ability scores: base + fixed racial + chosen race.abil bonuses.
export function finalAbilityScores(
  data: CreationData | undefined,
  baseScores: Record<AbilityKey, number>,
  submission: Record<string, ChoicePick[]>,
): Record<AbilityKey, number> {
  const scores = { ...baseScores };
  for (const b of data?.summary.fixedBonuses ?? []) {
    scores[b.ability as AbilityKey] += b.bonus;
  }
  for (const [ability, amount] of raceAbilBonuses(data, submission)) {
    scores[ability] += amount;
  }
  return scores;
}
