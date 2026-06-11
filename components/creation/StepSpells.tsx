"use client";

import { abilityMod, type AbilityKey } from "@/lib/abilities";
import type { CreationData, Draft } from "./types";
import { Panel } from "@/components/ui/Panel";

// How many level-1 spells this draft must pick (mirrors server logic).
export function expectedSpellCount(data: CreationData, draft: Draft): number {
  const plan = data.spellPlan!;
  if (plan.count !== null) return plan.count;
  const ability = data.summary.spellAbility as AbilityKey;
  let score = draft.baseScores[ability];
  for (const b of data.summary.fixedBonuses) if (b.ability === ability) score += b.bonus;
  for (const p of draft.submission["race.abil"] ?? []) if (p.key === ability) score += 1;
  return Math.max(1, abilityMod(score) + 1);
}

function SpellGrid({
  spells,
  chosen,
  max,
  toggle,
}: {
  spells: { index: string; name: string; school: string }[];
  chosen: string[];
  max: number;
  toggle: (index: string) => void;
}) {
  return (
    <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2">
      {spells.map((spell) => {
        const active = chosen.includes(spell.index);
        const full = chosen.length >= max;
        return (
          <button
            key={spell.index}
            disabled={!active && full}
            className={`px-3 py-2 text-left text-sm border cursor-pointer transition-colors disabled:opacity-35 disabled:cursor-default ${
              active
                ? "border-arcane text-arcane-soft bg-arcane/10"
                : "border-gold-dim/30 text-parchment-dim hover:border-arcane/60"
            }`}
            onClick={() => toggle(spell.index)}
          >
            <span className="block">{spell.name}</span>
            <span className="block text-[0.65rem] uppercase tracking-wider text-parchment-faint">
              {spell.school}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function StepSpells({
  data,
  draft,
  update,
}: {
  data: CreationData;
  draft: Draft;
  update: (patch: Partial<Draft>) => void;
}) {
  const plan = data.spellPlan!;
  const lists = data.spellLists!;
  const spellCount = expectedSpellCount(data, draft);

  const modeBlurb =
    plan.mode === "spellbook"
      ? `Your spellbook starts with six spells; the first few are prepared for the road.`
      : plan.mode === "prepared"
        ? `You prepare spells from your god's full list — this many fit in your prayers today.`
        : `These spells are simply known to you, etched into what you are.`;

  return (
    <div className="space-y-8">
      <section>
        <div className="flex items-baseline justify-between mb-3">
          <h3 className="font-display text-sm tracking-wider text-gold">Cantrips</h3>
          <span className={`font-dice text-xs ${draft.cantrips.length === plan.cantrips ? "text-vitality" : "text-parchment-faint"}`}>
            {draft.cantrips.length}/{plan.cantrips}
          </span>
        </div>
        <SpellGrid
          spells={lists[0]}
          chosen={draft.cantrips}
          max={plan.cantrips}
          toggle={(index) =>
            update({
              cantrips: draft.cantrips.includes(index)
                ? draft.cantrips.filter((c) => c !== index)
                : [...draft.cantrips, index],
            })
          }
        />
      </section>

      <section>
        <div className="flex items-baseline justify-between mb-1">
          <h3 className="font-display text-sm tracking-wider text-gold">Level 1 spells</h3>
          <span className={`font-dice text-xs ${draft.spells.length === spellCount ? "text-vitality" : "text-parchment-faint"}`}>
            {draft.spells.length}/{spellCount}
          </span>
        </div>
        <p className="font-narrative italic text-sm text-parchment-faint mb-3">{modeBlurb}</p>
        <SpellGrid
          spells={lists[1]}
          chosen={draft.spells}
          max={spellCount}
          toggle={(index) =>
            update({
              spells: draft.spells.includes(index)
                ? draft.spells.filter((s) => s !== index)
                : [...draft.spells, index],
            })
          }
        />
      </section>

      <Panel innerClassName="px-4 py-3">
        <p className="font-dice text-xs text-parchment-dim">
          Spell slots at level 1: <span className="text-arcane-soft">{plan.slotsL1} × level-1</span>
        </p>
      </Panel>
    </div>
  );
}
