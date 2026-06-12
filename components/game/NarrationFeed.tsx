"use client";

import { usePaginatedQuery, useQuery } from "convex/react";
import { useEffect, useMemo, useRef } from "react";
import { api } from "@/convex/_generated/api";
import { useSession } from "@/hooks/useSession";
import { useGameStore } from "@/stores/gameStore";
import { GMMessage } from "./GMMessage";
import { RollChip } from "./RollCard";

export function NarrationFeed() {
  const session = useSession();
  const { results, status, loadMore } = usePaginatedQuery(
    api.messages.list,
    { sessionToken: session.sessionToken, campaignId: session.campaignId },
    { initialNumItems: 30 },
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  // While dice are tumbling, everything written after the currently-animating
  // roll stays hidden — chips, damage lines, follow-up narration — so a burst
  // of rolls (a monster's full round) reveals beat by beat as each animation
  // lands. Historical rolls are never enqueued (ConvexBridge only animates
  // rolls landing after mount), so old messages render immediately.
  const diceHead = useGameStore((s) => (s.diceQueue.length > 0 ? s.diceQueue[0] : null));
  // 250ms of slack: the roll row and its message are written in one mutation,
  // but rolledAt (Date.now in the handler) and _creationTime can differ a hair.
  const gateTime = diceHead ? diceHead.at - 250 : Infinity;

  // Dictionary for GM name highlighting: party names, the current location,
  // and anything the GM has ever **bolded**. Both queries are already live
  // elsewhere (PartySidebar, GameScreen) — Convex dedupes subscriptions.
  const party = useQuery(api.characters.getParty, {
    sessionToken: session.sessionToken,
    campaignId: session.campaignId,
  });
  const campaign = useQuery(api.campaigns.get, {
    sessionToken: session.sessionToken,
    inviteCode: session.inviteCode,
  });
  const knownNames = useMemo(() => {
    const names = new Set<string>();
    for (const c of party ?? []) names.add(c.name);
    if (campaign) names.add(campaign.location.name);
    for (const m of results) {
      if (m.kind !== "gm") continue;
      for (const match of m.content.matchAll(/\*\*([^*\n]+)\*\*/g)) {
        const name = match[1].trim();
        // names are short, capitalized, few words — skip bold emphasis
        // like "**cannot**" so it doesn't gold-light everywhere forever
        if (name && name.length <= 40 && /^\p{Lu}/u.test(name) && name.split(/\s+/).length <= 4) {
          names.add(name);
        }
      }
    }
    return [...names].sort();
  }, [party, campaign, results]);

  // Track whether the reader is near the bottom
  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (el.scrollTop < 80 && status === "CanLoadMore") loadMore(20);
  }

  const lastContent = results[0]?.content;
  const count = results.length;
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [lastContent, count, gateTime]); // gateTime: re-pin as held-back messages pop in

  // Stay pinned to the newest line when the panel is drag-resized smaller
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (stickToBottom.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const chronological = [...results].reverse();

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className="flex-1 overflow-y-auto px-5 py-4 space-y-4 min-h-0"
    >
      {status === "CanLoadMore" && (
        <p className="text-center font-display text-[0.6rem] tracking-[0.3em] uppercase text-parchment-faint">
          scroll up for earlier pages of the tale
        </p>
      )}
      {chronological.map((m) => {
        // Held back until the dice animation playback catches up to it
        if (m._creationTime >= gateTime) return null;
        switch (m.kind) {
          case "gm":
            // Ghost rows: a completed message with no real content would
            // render as a blank line — drop it (a few exist in prod)
            if (m.content.trim() === "" && m.status === "complete") return null;
            return (
              <div key={m._id}>
                <GMMessage content={m.content} status={m.status} knownNames={knownNames} />
              </div>
            );
          case "player":
            return (
              <div key={m._id} className={`flex ${m.ooc ? "opacity-60" : ""}`}>
                <div className="ml-auto max-w-[80%] border border-gold-dim/30 bg-ink-raise/60 px-3.5 py-2">
                  <span className="block font-display text-[0.6rem] tracking-[0.25em] uppercase text-gold-dim">
                    {m.characterName}
                    {m.ooc ? " · table talk" : ""}
                  </span>
                  <span className="font-ui text-sm text-parchment-dim">{m.content}</span>
                </div>
              </div>
            );
          case "roll":
            return (
              <div key={m._id} className="flex justify-center">
                {m.roll ? (
                  <RollChip roll={m.roll} label={m.content.split(":")[0]} />
                ) : (
                  <span className="font-dice text-xs text-parchment-faint">{m.content}</span>
                )}
              </div>
            );
          case "image":
            return (
              <figure key={m._id} className="flex flex-col items-center gap-1.5 py-2">
                {m.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={m.imageUrl}
                    alt={m.content}
                    className="max-w-[480px] w-full border border-gold-dim/40 shadow-[0_0_40px_rgba(201,164,92,0.12)]"
                  />
                ) : (
                  <div className="w-full max-w-[480px] h-40 border border-gold-dim/30 bg-ink-raise/40 animate-flicker" />
                )}
                <figcaption className="font-narrative italic text-xs text-parchment-faint">
                  {m.content}
                </figcaption>
              </figure>
            );
          case "system":
            if (m.ooc) return null; // GM-directive system messages are not for players
            return (
              <p
                key={m._id}
                className="text-center font-narrative italic text-sm text-arcane-soft/80"
              >
                {m.content}
              </p>
            );
          default:
            return null;
        }
      })}
    </div>
  );
}
