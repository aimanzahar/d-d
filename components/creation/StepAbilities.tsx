"use client";

import {
  ABILITY_KEYS,
  ABILITY_NAMES,
  POINT_BUY_BUDGET,
  POINT_BUY_COST,
  STANDARD_ARRAY,
  abilityMod,
  fmtMod,
  type AbilityKey,
} from "@/lib/abilities";
import type { CreationData, Draft } from "./types";
import { Panel } from "@/components/ui/Panel";

export function pointsSpent(scores: Record<AbilityKey, number>): number {
  return ABILITY_KEYS.reduce((sum, k) => sum + (POINT_BUY_COST[scores[k]] ?? 99), 0);
}

export function StepAbilities({
  draft,
  update,
  data,
}: {
  draft: Draft;
  update: (patch: Partial<Draft>) => void;
  data: CreationData | undefined;
}) {
  const bonuses = new Map<AbilityKey, number>();
  for (const b of data?.summary.fixedBonuses ?? []) {
    bonuses.set(b.ability as AbilityKey, (bonuses.get(b.ability as AbilityKey) ?? 0) + b.bonus);
  }
  // chosen +1s (half-elf) granted via the race.abil node
  for (const pick of draft.submission["race.abil"] ?? []) {
    bonuses.set(pick.key as AbilityKey, (bonuses.get(pick.key as AbilityKey) ?? 0) + 1);
  }

  const spent = pointsSpent(draft.baseScores);

  function setScore(key: AbilityKey, value: number) {
    update({ baseScores: { ...draft.baseScores, [key]: value } });
  }

  function swapStandard(key: AbilityKey, value: number) {
    // Standard array: assigning a value steals it from whoever held it (swap).
    const holder = ABILITY_KEYS.find((k) => draft.baseScores[k] === value);
    const next = { ...draft.baseScores };
    if (holder) next[holder] = draft.baseScores[key];
    next[key] = value;
    update({ baseScores: next });
  }

  return (
    <div className="space-y-6">
      <div className="flex gap-2">
        {(["standard", "pointbuy"] as const).map((m) => (
          <button
            key={m}
            className={`px-4 py-2 font-display text-xs tracking-[0.2em] uppercase cursor-pointer border ${
              draft.method === m
                ? "border-ember text-ember-bright"
                : "border-gold-dim/40 text-parchment-dim hover:border-gold"
            }`}
            onClick={() => {
              update({
                method: m,
                baseScores:
                  m === "standard"
                    ? { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 }
                    : { str: 8, dex: 8, con: 8, int: 8, wis: 8, cha: 8 },
              });
            }}
          >
            {m === "standard" ? "Standard array" : "Point buy"}
          </button>
        ))}
        {draft.method === "pointbuy" && (
          <span className={`ml-auto font-dice text-sm self-center ${spent > POINT_BUY_BUDGET ? "text-blood" : "text-vitality"}`}>
            {POINT_BUY_BUDGET - spent} points left
          </span>
        )}
      </div>

      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {ABILITY_KEYS.map((key) => {
          const base = draft.baseScores[key];
          const bonus = bonuses.get(key) ?? 0;
          const final = base + bonus;
          return (
            <Panel key={key} innerClassName="p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="font-display text-xs tracking-[0.2em] uppercase text-gold">
                  {ABILITY_NAMES[key]}
                </span>
                <span className="font-dice text-lg text-parchment">
                  {final}
                  <span className="text-arcane-soft text-sm ml-1.5">{fmtMod(abilityMod(final))}</span>
                </span>
              </div>
              {draft.method === "standard" ? (
                <div className="flex flex-wrap gap-1.5">
                  {STANDARD_ARRAY.map((value) => (
                    <button
                      key={value}
                      className={`w-9 h-8 font-dice text-sm cursor-pointer border ${
                        base === value
                          ? "border-ember text-ember-bright"
                          : "border-gold-dim/30 text-parchment-dim hover:border-gold"
                      }`}
                      onClick={() => swapStandard(key, value)}
                    >
                      {value}
                    </button>
                  ))}
                </div>
              ) : (
                <div className="flex items-center gap-3">
                  <button
                    className="w-8 h-8 border border-gold-dim/40 text-parchment-dim hover:border-gold cursor-pointer disabled:opacity-30"
                    disabled={base <= 8}
                    onClick={() => setScore(key, base - 1)}
                  >
                    −
                  </button>
                  <span className="font-dice text-base w-6 text-center">{base}</span>
                  <button
                    className="w-8 h-8 border border-gold-dim/40 text-parchment-dim hover:border-gold cursor-pointer disabled:opacity-30"
                    disabled={base >= 15 || spent + (POINT_BUY_COST[base + 1] - POINT_BUY_COST[base]) > POINT_BUY_BUDGET}
                    onClick={() => setScore(key, base + 1)}
                  >
                    +
                  </button>
                  {bonus > 0 && (
                    <span className="ml-auto font-dice text-xs text-arcane-soft">racial +{bonus}</span>
                  )}
                </div>
              )}
              {draft.method === "standard" && bonus > 0 && (
                <p className="mt-1.5 font-dice text-xs text-arcane-soft">racial +{bonus}</p>
              )}
            </Panel>
          );
        })}
      </div>
      <p className="font-narrative italic text-sm text-parchment-faint">
        {draft.method === "standard"
          ? "Click a number to assign it — values swap between abilities."
          : "Spend 27 points. Scores cost more the higher they climb (15 costs 9)."}
      </p>
    </div>
  );
}
