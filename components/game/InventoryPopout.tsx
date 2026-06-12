"use client";

// Flyout pack viewer anchored to a party card; clicking an item prefills the composer.

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { Doc } from "@/convex/_generated/dataModel";
import { Panel } from "@/components/ui/Panel";
import { useComposerStore } from "@/stores/composerStore";

export function InventoryPopout({
  character,
  isMe,
  anchorTop,
  onClose,
}: {
  character: Doc<"characters">;
  isMe: boolean;
  anchorTop: number;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const dead = character.conditions.some((c) => c.name === "dead");
  const top = Math.max(56, Math.min(anchorTop, window.innerHeight - 420));

  // Focus once on mount — onClose is recreated per parent render, so keeping
  // it out of this effect stops live party updates from yanking focus back.
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const { cp, sp, ep, gp, pp } = character.currency;
  // Portal: the sidebar wrapper's backdrop-blur makes it a containing block
  // for fixed descendants — escape to <body> so viewport coords hold and the
  // click-away scrim actually covers the whole screen.
  return createPortal(
    <>
      <div className="fixed inset-0 z-30" onClick={onClose} aria-hidden />
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-label={`${character.name}'s inventory`}
        className="fixed z-30 left-[268px] w-72 outline-none"
        style={{ top }}
      >
        <Panel>
          <div className="flex items-center justify-between gap-2 border-b border-gold-dim/30 px-3.5 py-2.5">
            <span className="font-display text-[0.6rem] tracking-[0.25em] uppercase text-gold truncate">
              {character.name}&apos;s pack
            </span>
            <button
              className="text-parchment-faint hover:text-parchment cursor-pointer shrink-0"
              onClick={onClose}
              aria-label="Close inventory"
            >
              ✕
            </button>
          </div>
          {character.inventory.length === 0 ? (
            <p className="font-narrative italic text-[0.78rem] text-parchment-faint px-3.5 py-3">
              {isMe ? "Your pack is empty." : "Their pack is empty."}
            </p>
          ) : (
            <ul className="max-h-[19rem] overflow-y-auto py-1">
              {character.inventory.map((item, i) => (
                <li key={`${i}-${item.name}`}>
                  <button
                    className="w-full flex items-center gap-2 px-3.5 py-2 text-left hover:bg-gold/10 cursor-pointer disabled:opacity-50 disabled:cursor-default disabled:hover:bg-transparent"
                    disabled={!isMe || dead}
                    title={isMe ? `Use ${item.name}` : "Only your own gear can be used"}
                    onClick={() => {
                      useComposerStore.getState().setSeed(`I use my ${item.name}`);
                      onClose();
                    }}
                  >
                    <span className="text-[0.78rem] text-parchment truncate flex-1">
                      {item.name}
                    </span>
                    {item.quantity > 1 && (
                      <span className="font-dice text-[0.6rem] text-parchment-dim">
                        x{item.quantity}
                      </span>
                    )}
                    {item.equipped && (
                      <span className="font-display text-[0.5rem] tracking-[0.15em] uppercase border border-gold-dim/40 text-gold px-1.5 py-0.5">
                        equipped
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="border-t border-gold-dim/30 px-3.5 py-2 flex gap-3 font-dice text-[0.65rem]">
            <span className="text-gold">{gp} gp</span>
            {pp > 0 && <span className="text-parchment-dim">{pp} pp</span>}
            {sp > 0 && <span className="text-parchment-dim">{sp} sp</span>}
            {cp > 0 && <span className="text-parchment-dim">{cp} cp</span>}
            {ep > 0 && <span className="text-parchment-dim">{ep} ep</span>}
          </div>
        </Panel>
      </div>
    </>,
    document.body,
  );
}
