"use client";

import { useQuery } from "convex/react";
import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { api } from "@/convex/_generated/api";
import type { Doc } from "@/convex/_generated/dataModel";
import { useSession } from "@/hooks/useSession";
import { Panel } from "@/components/ui/Panel";
import { PoiDetail, standingClass } from "./PoiDetail";

const KIND_ICON: Record<string, string> = {
  settlement: "🏘",
  dungeon: "🏰",
  landmark: "🗿",
  wilds: "🌲",
  danger: "☠",
  quest_site: "✦",
};

function Heading({ children }: { children: ReactNode }) {
  return (
    <p className="font-display text-[0.55rem] tracking-[0.3em] uppercase text-gold-dim mb-1.5">
      {children}
    </p>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="font-narrative italic text-[0.75rem] text-parchment-faint">{children}</p>;
}

function QuestRow({ quest, tone }: { quest: Doc<"quests">; tone: "active" | "done" | "failed" }) {
  const toneClass =
    tone === "active"
      ? "text-gold"
      : tone === "done"
        ? "text-parchment-faint line-through"
        : "text-blood/80 line-through";
  return (
    <li>
      <p className={`font-display text-[0.72rem] ${toneClass}`}>{quest.title}</p>
      <p className="font-narrative italic text-[0.72rem] text-parchment-dim leading-snug">
        {quest.description}
      </p>
    </li>
  );
}

export function CodexWindow({ onClose }: { onClose: () => void }) {
  const session = useSession();
  const codex = useQuery(api.codex.getCodex, {
    sessionToken: session.sessionToken,
    campaignId: session.campaignId,
  });
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") (selected ? setSelected(null) : onClose());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, selected]);

  const factions = codex?.factions ?? [];
  const pois = codex?.pois ?? [];
  const quests = codex?.quests ?? { active: [], completed: [], failed: [] };
  const questCount = quests.active.length + quests.completed.length + quests.failed.length;
  const selectedPoi = selected ? (pois.find((p) => p.slug === selected) ?? null) : null;
  const selectedFaction = selectedPoi?.factionSlug
    ? (factions.find((f) => f.slug === selectedPoi.factionSlug) ?? null)
    : null;

  return createPortal(
    <>
      <div className="fixed inset-0 z-30 bg-ink/70" onClick={onClose} aria-hidden />
      <div
        role="dialog"
        aria-label="World codex"
        className="fixed z-30 left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[min(92vw,560px)] outline-none"
      >
        <Panel innerClassName="flex flex-col max-h-[86vh]">
          <div className="flex items-center justify-between gap-2 border-b border-gold-dim/30 px-3.5 py-2.5">
            <span className="font-display text-[0.6rem] tracking-[0.25em] uppercase text-gold">
              The Chronicle
            </span>
            <button
              className="text-parchment-faint hover:text-parchment cursor-pointer shrink-0"
              onClick={onClose}
              aria-label="Close codex"
            >
              ✕
            </button>
          </div>
          <div className="overflow-y-auto px-3.5 py-3 space-y-5">
            {codex?.currentLocation && (
              <section>
                <Heading>Here</Heading>
                <p className="font-display text-[0.8rem] text-parchment">
                  {codex.currentLocation.name}
                </p>
                <p className="font-narrative italic text-[0.78rem] text-parchment-dim leading-relaxed mt-0.5">
                  {codex.currentLocation.description}
                </p>
              </section>
            )}

            <section>
              <Heading>Quests</Heading>
              {questCount === 0 ? (
                <Empty>No quests yet.</Empty>
              ) : (
                <ul className="space-y-1.5">
                  {quests.active.map((q) => (
                    <QuestRow key={q._id} quest={q} tone="active" />
                  ))}
                  {quests.completed.map((q) => (
                    <QuestRow key={q._id} quest={q} tone="done" />
                  ))}
                  {quests.failed.map((q) => (
                    <QuestRow key={q._id} quest={q} tone="failed" />
                  ))}
                </ul>
              )}
            </section>

            <section>
              <Heading>Factions</Heading>
              {factions.length === 0 ? (
                <Empty>No factions known.</Empty>
              ) : (
                <ul className="space-y-2">
                  {factions.map((f) => (
                    <li key={f._id} className="flex items-start gap-2">
                      <span
                        className={`font-display text-[0.5rem] tracking-[0.15em] uppercase px-1.5 py-0.5 border shrink-0 ${standingClass(f.standing)}`}
                      >
                        {f.standing}
                      </span>
                      <div className="min-w-0">
                        <p className="font-display text-[0.75rem] text-parchment">
                          {f.symbol ? `${f.symbol} ` : ""}
                          {f.name}
                        </p>
                        <p className="font-narrative italic text-[0.72rem] text-parchment-dim leading-snug">
                          {f.description}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section>
              <Heading>Places</Heading>
              {pois.length === 0 ? (
                <Empty>No places charted.</Empty>
              ) : (
                <ul className="space-y-1">
                  {pois.map((p) => (
                    <li key={p._id}>
                      <button
                        onClick={() => setSelected(p.slug)}
                        className="w-full text-left flex items-center gap-2 px-2 py-1.5 border border-gold-dim/20 hover:border-gold-dim/50 hover:bg-gold/5 cursor-pointer"
                      >
                        <span className="text-sm shrink-0">{KIND_ICON[p.kind] ?? "•"}</span>
                        <span
                          className={`font-display text-[0.72rem] truncate ${p.discovered ? "text-parchment" : "text-parchment-faint"}`}
                        >
                          {p.name}
                        </span>
                        {p.isCurrent ? (
                          <span className="ml-auto text-[0.55rem] text-ember shrink-0">● here</span>
                        ) : !p.discovered ? (
                          <span className="ml-auto font-narrative italic text-[0.62rem] text-parchment-faint shrink-0">
                            rumored
                          </span>
                        ) : null}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </Panel>
      </div>
      {selectedPoi && (
        <PoiDetail poi={selectedPoi} faction={selectedFaction} onClose={() => setSelected(null)} />
      )}
    </>,
    document.body,
  );
}
