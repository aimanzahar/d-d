"use client";

import { useEffect } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { FEATS } from "@/convex/srd/feats";
import { ABILITY_KEYS, ABILITY_NAMES, type AbilityKey } from "@/lib/abilities";
import type { ChoicePick, CreationData, Draft } from "./types";
import { Panel } from "@/components/ui/Panel";
import { HoverPopover } from "@/components/ui/HoverPopover";
import { FALLBACK_ICON, iconForItem } from "@/lib/itemIcons";

type Node = CreationData["nodes"][number];

// Item icon with the same fallback the inventory uses.
function ItemThumb({ index, name, className }: { index?: string; name: string; className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={iconForItem({ itemIndex: index, name })}
      alt=""
      className={className}
      onError={(e) => {
        const img = e.currentTarget;
        if (!img.src.endsWith(FALLBACK_ICON)) img.src = FALLBACK_ICON;
      }}
    />
  );
}

// Popover body: icon + name + lazily-fetched description. It mounts only while
// the popover is open (HoverPopover renders `content` on demand), so the query
// is effectively open-gated and never fires for items the player doesn't inspect.
function ItemPopoverContent({ index, name }: { index?: string; name: string }) {
  const detail = useQuery(api.srdData.itemDetail, index ? { index } : "skip");
  const description = !index
    ? "No description available."
    : detail === undefined
      ? "…"
      : (detail?.description ?? "No description available.");
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <ItemThumb index={index} name={name} className="w-8 h-8 object-contain shrink-0" />
        <p className="font-display text-xs tracking-wider text-gold">{detail?.name ?? name}</p>
      </div>
      <p>{description}</p>
    </div>
  );
}

// Icon + name chip that reveals the item's picture + description on hover/tap.
function ItemChip({ index, name }: { index?: string; name: string }) {
  return (
    <HoverPopover content={<ItemPopoverContent index={index} name={name} />}>
      <span className="inline-flex items-center gap-1.5 cursor-help text-parchment-dim hover:text-parchment">
        <ItemThumb index={index} name={name} className="w-5 h-5 object-contain shrink-0" />
        <span className="text-xs">{name}</span>
        <span className="text-[0.6rem] text-parchment-faint">ⓘ</span>
      </span>
    </HoverPopover>
  );
}

// Whether a node's picks are complete (mirrors server validateNodePicks).
export function nodeSatisfied(node: Node, picks: ChoicePick[] | undefined): boolean {
  if (!picks || picks.length !== node.choose) return false;
  for (const pick of picks) {
    const option = node.options.find((o) => o.key === pick.key);
    if (!option) return false;
    // Feats with an internal sub-choice (Resilient) need their ability chosen.
    if (node.kind === "feat" && FEATS[pick.key]?.effects?.chooseAbility && !pick.featChoice) {
      return false;
    }
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
  disabledKeys,
}: {
  node: Node;
  picks: ChoicePick[];
  setPicks: (p: ChoicePick[]) => void;
  // Option keys to grey out as "already known" (used for language dedup).
  disabledKeys?: Set<string>;
}) {
  const chosen = new Set(picks.map((p) => p.key));
  return (
    <div className="flex flex-wrap gap-2">
      {node.options.map((opt) => {
        const active = chosen.has(opt.key);
        const full = picks.length >= node.choose;
        const known = disabledKeys?.has(opt.key) ?? false;
        return (
          <button
            key={opt.key}
            disabled={known || (!active && full)}
            title={known ? "Already known" : undefined}
            className={`px-3 py-1.5 text-sm cursor-pointer border transition-colors disabled:opacity-35 disabled:cursor-default ${
              active
                ? "border-ember text-ember-bright bg-ember/10"
                : "border-gold-dim/40 text-parchment-dim hover:border-gold hover:text-parchment"
            }`}
            onClick={() => {
              if (known) return;
              setPicks(
                active
                  ? picks.filter((p) => p.key !== opt.key)
                  : [...picks, { key: opt.key }],
              );
            }}
          >
            {opt.label}
            {known && (
              <span className="ml-1.5 text-[0.6rem] text-parchment-faint">already known</span>
            )}
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
            {active && opt.grants.length > 0 && (
              <div className="mt-2 ml-6 flex flex-wrap gap-x-4 gap-y-1.5">
                {opt.grants.map((g, i) => (
                  <ItemChip
                    key={i}
                    index={g.index}
                    name={g.count > 1 ? `${g.name} ×${g.count}` : g.name}
                  />
                ))}
              </div>
            )}
            {active &&
              opt.categorySlots.map((slot, slotIdx) => (
                <div key={slotIdx} className="mt-2 ml-6 space-y-2">
                  {Array.from({ length: slot.choose }).map((_, pickIdx) => {
                    const val = current.categoryPicks?.[slotIdx]?.[pickIdx] ?? "";
                    const chosen = val
                      ? (categories[slot.category] ?? []).find((it) => it.index === val)
                      : undefined;
                    return (
                      <div key={pickIdx} className="space-y-1">
                        <select
                          className="field-arcane w-full max-w-sm px-2 py-1.5 text-sm"
                          value={val}
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
                        {val && (
                          <div className="ml-1" onClick={(e) => e.stopPropagation()}>
                            <ItemChip index={val} name={chosen?.name ?? val} />
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
          </div>
        );
      })}
    </div>
  );
}

// Feat picker: a card per feat with its prereq pill; options the final ability
// scores don't meet are greyed and unselectable. Feats with a sub-choice
// (Resilient) reveal an ability select.
function FeatNode({
  node,
  picks,
  setPicks,
  finalScores,
}: {
  node: Node;
  picks: ChoicePick[];
  setPicks: (p: ChoicePick[]) => void;
  finalScores: Record<AbilityKey, number>;
}) {
  const current = picks[0];
  const prereqMet = (opt: Node["options"][number]) =>
    !opt.prereq?.ability ||
    (finalScores[opt.prereq.ability as AbilityKey] ?? 0) >= opt.prereq.minScore;

  // If an ability change made the chosen feat illegal, clear it so Continue
  // never sticks on an unmeetable feat (the server would reject it too).
  const currentOpt = current ? node.options.find((o) => o.key === current.key) : undefined;
  const currentIllegal = !!currentOpt && !prereqMet(currentOpt);
  useEffect(() => {
    if (currentIllegal) setPicks([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentIllegal]);

  return (
    <div className="space-y-2">
      {node.options.map((opt) => {
        const active = current?.key === opt.key;
        const met = prereqMet(opt);
        const needsAbility = !!FEATS[opt.key]?.effects?.chooseAbility;
        return (
          <div
            key={opt.key}
            title={met ? undefined : "Ability score prerequisite not met"}
            className={`border px-4 py-3 transition-colors ${
              !met
                ? "border-gold-dim/20 opacity-40 cursor-default"
                : active
                  ? "border-ember bg-ember/5 cursor-pointer"
                  : "border-gold-dim/30 hover:border-gold-dim cursor-pointer"
            }`}
            onClick={() => {
              if (!met || active) return;
              setPicks([{ key: opt.key, ...(needsAbility ? { featChoice: "" } : {}) }]);
            }}
          >
            <div className="flex items-center gap-3">
              <span
                className={`w-3 h-3 rotate-45 border shrink-0 ${active ? "border-ember bg-ember" : "border-gold-dim/50"}`}
              />
              <span className={`text-sm ${active ? "text-parchment" : "text-parchment-dim"}`}>
                {opt.label}
              </span>
              {opt.prereq?.ability && (
                <span
                  className={`ml-auto font-display text-[0.55rem] tracking-[0.15em] uppercase px-1.5 py-0.5 border shrink-0 ${
                    met ? "border-gold-dim/40 text-parchment-faint" : "border-blood/50 text-blood/80"
                  }`}
                >
                  {String(opt.prereq.ability).toUpperCase()} {opt.prereq.minScore}+
                </span>
              )}
            </div>
            {opt.desc && (
              <p className="mt-1.5 ml-6 text-xs text-parchment-faint leading-snug">{opt.desc}</p>
            )}
            {active && needsAbility && (
              <div className="mt-2 ml-6" onClick={(e) => e.stopPropagation()}>
                <select
                  className="field-arcane w-full max-w-xs px-2 py-1.5 text-sm"
                  value={current?.featChoice ?? ""}
                  onChange={(e) => setPicks([{ key: opt.key, featChoice: e.target.value }])}
                >
                  <option value="">— choose an ability —</option>
                  {ABILITY_KEYS.map((k) => (
                    <option key={k} value={k}>
                      {ABILITY_NAMES[k]}
                    </option>
                  ))}
                </select>
              </div>
            )}
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
  finalScores,
}: {
  data: CreationData | undefined;
  draft: Draft;
  update: (patch: Partial<Draft>) => void;
  finalScores: Record<AbilityKey, number>;
}) {
  if (!data) {
    return <p className="text-parchment-dim font-narrative italic">Reading the fine print…</p>;
  }
  const setNode = (id: string, picks: ChoicePick[]) =>
    update({ submission: { ...draft.submission, [id]: picks } });

  // Languages already known for a given language node: race/subrace auto-grants
  // plus picks in every OTHER language node. Recomputed per render, so deselecting
  // a language elsewhere re-enables it here reactively. Dedup is on language INDEX
  // (option keys differ between options_array and resource_list nodes).
  const knownLangIndexesExcept = (nodeId: string): Set<string> => {
    const known = new Set<string>(data.summary.knownLanguageIndexes ?? []);
    for (const n of data.nodes) {
      if (n.kind !== "language" || n.id === nodeId) continue;
      for (const pick of draft.submission[n.id] ?? []) {
        const idx = n.options.find((o) => o.key === pick.key)?.grants[0]?.index;
        if (idx) known.add(idx);
      }
    }
    return known;
  };

  return (
    <div className="space-y-6">
      {data.nodes.map((node) => {
        const picks = draft.submission[node.id] ?? [];
        const done = nodeSatisfied(node, picks);
        let disabledKeys: Set<string> | undefined;
        if (node.kind === "language") {
          const known = knownLangIndexesExcept(node.id);
          const selected = new Set(picks.map((p) => p.key));
          disabledKeys = new Set(
            node.options
              .filter((o) => {
                const idx = o.grants[0]?.index;
                return !!idx && known.has(idx) && !selected.has(o.key);
              })
              .map((o) => o.key),
          );
        }
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
            ) : node.kind === "feat" ? (
              <FeatNode
                node={node}
                picks={picks}
                setPicks={(p) => setNode(node.id, p)}
                finalScores={finalScores}
              />
            ) : (
              <ChipNode
                node={node}
                picks={picks}
                setPicks={(p) => setNode(node.id, p)}
                disabledKeys={disabledKeys}
              />
            )}
          </Panel>
        );
      })}
    </div>
  );
}
