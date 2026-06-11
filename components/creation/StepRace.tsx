"use client";

import type { Draft, RaceList } from "./types";
import { Panel } from "@/components/ui/Panel";

export function StepRace({
  races,
  draft,
  update,
}: {
  races: RaceList | undefined;
  draft: Draft;
  update: (patch: Partial<Draft>) => void;
}) {
  if (!races) {
    return <p className="text-parchment-dim font-narrative italic">Unfurling the lineages…</p>;
  }
  return (
    <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
      {races.map((race) => {
        const selected = draft.raceIndex === race.index;
        return (
          <button
            key={race.index}
            className="text-left cursor-pointer group"
            onClick={() =>
              update({
                raceIndex: race.index,
                subraceIndex: race.subraces[0]?.index ?? null,
                // race change invalidates downstream picks
                submission: {},
                cantrips: [],
                spells: [],
              })
            }
          >
            <Panel
              className={selected ? "ring-1 ring-ember" : "opacity-80 group-hover:opacity-100"}
              innerClassName="p-4 h-full"
            >
              <div className="flex items-baseline justify-between mb-1">
                <h3 className={`font-display text-base tracking-wide ${selected ? "text-ember-bright" : "text-gold"}`}>
                  {race.name}
                </h3>
                <span className="font-dice text-[0.65rem] text-parchment-faint">{race.speed} ft</span>
              </div>
              <p className="font-dice text-xs text-arcane-soft mb-2">
                {race.bonuses.join("  ")}
                {race.hasAbilityChoice && "  +1 ×2 (choose)"}
              </p>
              <p className="font-narrative text-sm text-parchment-dim leading-snug">
                {race.traits.slice(0, 4).join(" · ") || "Adaptable and ambitious."}
              </p>
              {selected && race.subraces.length > 0 && (
                <div className="mt-3 pt-3 border-t border-gold-dim/30 flex flex-wrap gap-2">
                  {race.subraces.map((sub) => (
                    <span
                      key={sub.index}
                      role="button"
                      className={`px-2.5 py-1 text-xs font-display tracking-wider cursor-pointer border ${
                        draft.subraceIndex === sub.index
                          ? "border-ember text-ember-bright"
                          : "border-gold-dim/40 text-parchment-dim hover:border-gold"
                      }`}
                      onClick={(e) => {
                        e.stopPropagation();
                        update({ subraceIndex: sub.index, submission: {}, cantrips: [] });
                      }}
                    >
                      {sub.name} ({sub.bonuses.join(", ")})
                    </span>
                  ))}
                </div>
              )}
            </Panel>
          </button>
        );
      })}
    </div>
  );
}
