"use client";

import { createPortal } from "react-dom";
import type { Doc } from "@/convex/_generated/dataModel";
import { Panel } from "@/components/ui/Panel";

const KIND_LABEL: Record<string, string> = {
  settlement: "Settlement",
  dungeon: "Dungeon",
  landmark: "Landmark",
  wilds: "Wilds",
  danger: "Danger",
  quest_site: "Quest Site",
};

// Faction standing → chip colour. Shared by the codex + map detail panels.
export function standingClass(standing: string): string {
  switch (standing) {
    case "allied":
    case "friendly":
      return "border-vitality/50 text-vitality";
    case "hostile":
    case "unfriendly":
      return "border-blood/50 text-blood/90";
    default:
      return "border-gold-dim/40 text-parchment-dim";
  }
}

export function PoiDetail({
  poi,
  faction,
  onClose,
}: {
  poi: Doc<"pois">;
  faction?: Doc<"factions"> | null;
  onClose: () => void;
}) {
  return createPortal(
    <>
      <div className="fixed inset-0 z-40 bg-ink/70" onClick={onClose} aria-hidden />
      <div
        role="dialog"
        aria-label={poi.name}
        className="fixed z-40 left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[min(90vw,460px)] outline-none"
      >
        <Panel innerClassName="flex flex-col max-h-[80vh]">
          <div className="flex items-center justify-between gap-2 border-b border-gold-dim/30 px-3.5 py-2.5">
            <span className="font-display text-[0.7rem] tracking-[0.2em] uppercase text-gold truncate">
              {poi.name}
              {poi.isCurrent && <span className="ml-2 text-[0.55rem] text-ember">● here</span>}
            </span>
            <button
              className="text-parchment-faint hover:text-parchment cursor-pointer shrink-0"
              onClick={onClose}
              aria-label="Close"
            >
              ✕
            </button>
          </div>
          <div className="px-3.5 py-3 space-y-2 overflow-y-auto">
            <div className="flex items-center gap-2">
              <span className="font-display text-[0.5rem] tracking-[0.2em] uppercase border border-gold-dim/40 text-parchment-dim px-1.5 py-0.5">
                {KIND_LABEL[poi.kind] ?? poi.kind}
              </span>
              {!poi.discovered && (
                <span className="font-narrative italic text-[0.7rem] text-parchment-faint">
                  rumored — not yet visited
                </span>
              )}
            </div>
            <p className="font-narrative text-[0.85rem] text-parchment leading-relaxed whitespace-pre-wrap">
              {poi.description}
            </p>
            {faction && (
              <div className="pt-1.5 border-t border-gold-dim/20">
                <span className="font-display text-[0.5rem] tracking-[0.2em] uppercase text-gold-dim block mb-1">
                  Faction
                </span>
                <span
                  className={`inline-block font-display text-[0.55rem] tracking-[0.15em] uppercase px-1.5 py-0.5 border ${standingClass(faction.standing)}`}
                >
                  {faction.symbol ? `${faction.symbol} ` : ""}
                  {faction.name} · {faction.standing}
                </span>
              </div>
            )}
          </div>
        </Panel>
      </div>
    </>,
    document.body,
  );
}
