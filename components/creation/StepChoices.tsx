"use client";

import type { ChoicePick, CreationData, Draft } from "./types";
import { Panel } from "@/components/ui/Panel";

type Node = CreationData["nodes"][number];

// Whether a node's picks are complete (mirrors server validateNodePicks).
export function nodeSatisfied(node: Node, picks: ChoicePick[] | undefined): boolean {
  if (!picks || picks.length !== node.choose) return false;
  for (const pick of picks) {
    const option = node.options.find((o) => o.key === pick.key);
    if (!option) return false;
    const catPicks = pick.categoryPicks ?? [];
    if (catPicks.length !== option.categorySlots.length) return false;
    for (let i = 0; i < option.categorySlots.length; i++) {
      if (catPicks[i].length !== option.categorySlots[i].choose) return false;
      if (catPicks[i].some((v) => !v)) return false;
    }
  }
  return true;
}

function ChipNode({
  node,
  picks,
  setPicks,
}: {
  node: Node;
  picks: ChoicePick[];
  setPicks: (p: ChoicePick[]) => void;
}) {
  const chosen = new Set(picks.map((p) => p.key));
  return (
    <div className="flex flex-wrap gap-2">
      {node.options.map((opt) => {
        const active = chosen.has(opt.key);
        const full = picks.length >= node.choose;
        return (
          <button
            key={opt.key}
            disabled={!active && full}
            className={`px-3 py-1.5 text-sm cursor-pointer border transition-colors disabled:opacity-35 disabled:cursor-default ${
              active
                ? "border-ember text-ember-bright bg-ember/10"
                : "border-gold-dim/40 text-parchment-dim hover:border-gold hover:text-parchment"
            }`}
            onClick={() =>
              setPicks(
                active
                  ? picks.filter((p) => p.key !== opt.key)
                  : [...picks, { key: opt.key }],
              )
            }
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function EquipmentNode({
  node,
  categories,
  picks,
  setPicks,
}: {
  node: Node;
  categories: CreationData["categories"];
  picks: ChoicePick[];
  setPicks: (p: ChoicePick[]) => void;
}) {
  const current = picks[0];
  return (
    <div className="space-y-2">
      {node.options.map((opt) => {
        const active = current?.key === opt.key;
        return (
          <div
            key={opt.key}
            className={`border px-4 py-3 cursor-pointer transition-colors ${
              active ? "border-ember bg-ember/5" : "border-gold-dim/30 hover:border-gold-dim"
            }`}
            onClick={() => {
              if (!active) {
                setPicks([
                  { key: opt.key, categoryPicks: opt.categorySlots.map((s) => Array(s.choose).fill("")) },
                ]);
              }
            }}
          >
            <div className="flex items-center gap-3">
              <span
                className={`w-3 h-3 rotate-45 border shrink-0 ${active ? "border-ember bg-ember" : "border-gold-dim/50"}`}
              />
              <span className={`text-sm ${active ? "text-parchment" : "text-parchment-dim"}`}>
                {opt.label}
              </span>
            </div>
            {active &&
              opt.categorySlots.map((slot, slotIdx) => (
                <div key={slotIdx} className="mt-2 ml-6 space-y-1.5">
                  {Array.from({ length: slot.choose }).map((_, pickIdx) => (
                    <select
                      key={pickIdx}
                      className="field-arcane w-full max-w-sm px-2 py-1.5 text-sm"
                      value={current.categoryPicks?.[slotIdx]?.[pickIdx] ?? ""}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => {
                        const next = structuredClone(current);
                        next.categoryPicks![slotIdx][pickIdx] = e.target.value;
                        setPicks([next]);
                      }}
                    >
                      <option value="">— choose from {slot.categoryName} —</option>
                      {(categories[slot.category] ?? []).map((item) => (
                        <option key={item.index} value={item.index}>
                          {item.name}
                        </option>
                      ))}
                    </select>
                  ))}
                </div>
              ))}
          </div>
        );
      })}
    </div>
  );
}

export function StepChoices({
  data,
  draft,
  update,
}: {
  data: CreationData | undefined;
  draft: Draft;
  update: (patch: Partial<Draft>) => void;
}) {
  if (!data) {
    return <p className="text-parchment-dim font-narrative italic">Reading the fine print…</p>;
  }
  const setNode = (id: string, picks: ChoicePick[]) =>
    update({ submission: { ...draft.submission, [id]: picks } });

  return (
    <div className="space-y-6">
      {data.nodes.map((node) => {
        const picks = draft.submission[node.id] ?? [];
        const done = nodeSatisfied(node, picks);
        return (
          <Panel key={node.id} innerClassName="p-5">
            <div className="flex items-baseline justify-between mb-3 gap-4">
              <h3 className="font-display text-sm tracking-wider text-gold">{node.label}</h3>
              <span className={`font-dice text-xs shrink-0 ${done ? "text-vitality" : "text-parchment-faint"}`}>
                {done ? "✓" : `${picks.length}/${node.choose}`}
              </span>
            </div>
            {node.kind === "equipment" ? (
              <EquipmentNode
                node={node}
                categories={data.categories}
                picks={picks}
                setPicks={(p) => setNode(node.id, p)}
              />
            ) : (
              <ChipNode node={node} picks={picks} setPicks={(p) => setNode(node.id, p)} />
            )}
          </Panel>
        );
      })}
    </div>
  );
}
