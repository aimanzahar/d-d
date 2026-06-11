"use client";

import type { ClassList, Draft } from "./types";
import { Panel } from "@/components/ui/Panel";

const FLAVOR: Record<string, string> = {
  barbarian: "Fury given form. Hit things until they stop.",
  bard: "A song for every door, a story for every scar.",
  cleric: "Your god is watching. Make it worth their while.",
  druid: "The wild remembers — and so do you.",
  fighter: "Master of every weapon ever swung.",
  monk: "The body is the only weapon that never dulls.",
  paladin: "An oath heavier than any armor.",
  ranger: "The wilderness keeps no secrets from you.",
  rogue: "Locks, pockets, and necks — all opened the same way.",
  sorcerer: "Magic doesn't obey you. It IS you.",
  warlock: "Power, pre-paid. The invoice comes later.",
  wizard: "Reality is a book, and you've read ahead.",
};

export function StepClass({
  classes,
  draft,
  update,
}: {
  classes: ClassList | undefined;
  draft: Draft;
  update: (patch: Partial<Draft>) => void;
}) {
  if (!classes) {
    return <p className="text-parchment-dim font-narrative italic">Opening the war manuals…</p>;
  }
  return (
    <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
      {classes.map((cls) => {
        const selected = draft.classIndex === cls.index;
        return (
          <button
            key={cls.index}
            className="text-left cursor-pointer group"
            onClick={() =>
              update({ classIndex: cls.index, submission: {}, cantrips: [], spells: [] })
            }
          >
            <Panel
              className={selected ? "ring-1 ring-ember" : "opacity-80 group-hover:opacity-100"}
              innerClassName="p-4 h-full"
            >
              <div className="flex items-baseline justify-between mb-1">
                <h3 className={`font-display text-base tracking-wide ${selected ? "text-ember-bright" : "text-gold"}`}>
                  {cls.name}
                </h3>
                <span className="font-dice text-[0.65rem] text-parchment-faint">d{cls.hitDie}</span>
              </div>
              <p className="font-dice text-xs text-arcane-soft mb-2">
                saves {cls.saves.join("/")}
                {cls.spellAbility ? ` · casts with ${cls.spellAbility.toUpperCase()}` : ""}
              </p>
              <p className="font-narrative text-sm text-parchment-dim leading-snug">
                {FLAVOR[cls.index]}
              </p>
            </Panel>
          </button>
        );
      })}
    </div>
  );
}
