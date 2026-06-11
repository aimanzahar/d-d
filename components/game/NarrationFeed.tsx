"use client";

import { usePaginatedQuery } from "convex/react";
import { useEffect, useRef } from "react";
import { api } from "@/convex/_generated/api";
import { useSession } from "@/hooks/useSession";
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
  }, [lastContent, count]);

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
        switch (m.kind) {
          case "gm":
            return (
              <div key={m._id} className="max-w-prose">
                <GMMessage content={m.content} status={m.status} />
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
