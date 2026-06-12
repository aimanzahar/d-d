"use client";

import { useMutation, useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "@/convex/_generated/api";
import { useSession } from "@/hooks/useSession";
import { Panel } from "@/components/ui/Panel";
import { PoiDetail } from "./PoiDetail";

const KIND_ICON: Record<string, string> = {
  settlement: "🏘",
  dungeon: "🏰",
  landmark: "🗿",
  wilds: "🌲",
  danger: "☠",
  quest_site: "✦",
};

function markerTint(standing: string | null | undefined): string {
  switch (standing) {
    case "allied":
    case "friendly":
      return "border-vitality bg-vitality/20 text-parchment";
    case "hostile":
    case "unfriendly":
      return "border-blood bg-blood/30 text-parchment";
    default:
      return "border-gold bg-ink/80 text-parchment";
  }
}

export function RegionMapWindow({ onClose }: { onClose: () => void }) {
  const session = useSession();
  const map = useQuery(api.regionMap.getRegionMap, {
    sessionToken: session.sessionToken,
    campaignId: session.campaignId,
  });
  const codex = useQuery(api.codex.getCodex, {
    sessionToken: session.sessionToken,
    campaignId: session.campaignId,
  });
  const generate = useMutation(api.regionMap.generateRegionMap);
  const [selected, setSelected] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") (selected ? setSelected(null) : onClose());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, selected]);

  const factions = codex?.factions ?? [];
  const pois = codex?.pois ?? [];
  const markers = pois.filter((p) => p.x != null && p.y != null);
  const selectedPoi = selected ? (pois.find((p) => p.slug === selected) ?? null) : null;
  const selectedFaction = selectedPoi?.factionSlug
    ? (factions.find((f) => f.slug === selectedPoi.factionSlug) ?? null)
    : null;
  const standingFor = (slug?: string) =>
    slug ? (factions.find((f) => f.slug === slug)?.standing ?? null) : null;

  async function handleGenerate() {
    setNote(null);
    setBusy(true);
    try {
      await generate({ sessionToken: session.sessionToken, campaignId: session.campaignId });
    } catch (e) {
      const code = e instanceof ConvexError ? (e.data as { code?: string })?.code : null;
      setNote(
        code === "map_in_flight"
          ? "The cartographer is already at work…"
          : code === "not_host" || code === "forbidden"
            ? "Only the host can chart the map."
            : "The map could not be drawn.",
      );
    } finally {
      setBusy(false);
    }
  }

  return createPortal(
    <>
      <div className="fixed inset-0 z-30 bg-ink/70" onClick={onClose} aria-hidden />
      <div
        role="dialog"
        aria-label="Region map"
        className="fixed z-30 left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[min(94vw,900px)] outline-none"
      >
        <Panel innerClassName="flex flex-col max-h-[90vh]">
          <div className="flex items-center justify-between gap-2 border-b border-gold-dim/30 px-3.5 py-2.5">
            <span className="font-display text-[0.6rem] tracking-[0.25em] uppercase text-gold">
              Region Map
            </span>
            <button
              className="text-parchment-faint hover:text-parchment cursor-pointer shrink-0"
              onClick={onClose}
              aria-label="Close map"
            >
              ✕
            </button>
          </div>
          <div className="p-3 overflow-y-auto">
            {map?.status === "done" && map.url ? (
              <div className="relative w-full aspect-[3/2] border border-gold-dim/40 overflow-hidden">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={map.url} alt="Region map" className="w-full h-full object-cover" />
                {markers.map((m) => (
                  <button
                    key={m.slug}
                    onClick={() => setSelected(m.slug)}
                    title={m.name}
                    style={{ left: `${m.x! * 100}%`, top: `${m.y! * 100}%` }}
                    className={`absolute -translate-x-1/2 -translate-y-1/2 flex items-center justify-center w-7 h-7 rounded-full border text-[0.7rem] cursor-pointer hover:scale-110 transition-transform ${markerTint(
                      standingFor(m.factionSlug),
                    )} ${m.isCurrent ? "ring-2 ring-gold animate-ember-pulse" : ""} ${
                      m.discovered ? "" : "opacity-60"
                    }`}
                  >
                    {KIND_ICON[m.kind] ?? "•"}
                  </button>
                ))}
              </div>
            ) : map?.status === "generating" ? (
              <p className="font-narrative italic text-sm text-arcane-soft text-center py-16 animate-flicker">
                The cartographer&apos;s ink is still drying…
              </p>
            ) : (
              <div className="text-center py-12 space-y-3">
                <p className="font-narrative italic text-sm text-parchment-dim">
                  {map?.status === "failed"
                    ? "The map was lost to a smudge of ink."
                    : "This realm has not yet been charted."}
                </p>
                {session.isHost ? (
                  <button
                    disabled={busy}
                    onClick={handleGenerate}
                    className="font-display text-[0.6rem] tracking-[0.25em] uppercase px-4 py-2 border border-gold text-gold-bright bg-gold/10 hover:bg-gold/20 cursor-pointer disabled:opacity-50"
                  >
                    {map?.status === "failed" ? "✦ Redraw the map" : "✦ Chart this region"}
                  </button>
                ) : (
                  <p className="font-narrative italic text-xs text-parchment-faint">
                    Only the host can chart the region.
                  </p>
                )}
                {note && <p className="font-narrative italic text-xs text-blood/90">{note}</p>}
              </div>
            )}
            {map?.status === "done" && markers.length === 0 && (
              <p className="font-narrative italic text-[0.72rem] text-parchment-faint mt-2 text-center">
                No places are placed on the map yet — they&apos;ll appear as the tale charts them.
              </p>
            )}
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
