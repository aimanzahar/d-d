"use client";

// Drains the gameStore dice queue one DiceEvent at a time. The head of the
// queue is the live event: it gets a 3D DiceOverlay plus a DOM banner with the
// actor, purpose, and — only once every die has physically settled — the
// animated total. The event is dequeued only once its fade-out completes,
// which promotes the next one.

import { animate } from "animejs";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import { useGameStore } from "@/stores/gameStore";

const DiceOverlay = dynamic(() => import("../three/dice/DiceOverlay"), { ssr: false });

const FADE_MS = 900;

export function DiceRollerHost() {
  const current = useGameStore((s) => (s.diceQueue.length > 0 ? s.diceQueue[0] : null));
  const dequeueDice = useGameStore((s) => s.dequeueDice);

  const [revealed, setRevealed] = useState(false);

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const totalRef = useRef<HTMLDivElement | null>(null);
  const finishing = useRef(false);

  // Reveal the total only when the dice have physically stopped (onDone's
  // own setRevealed covers the SAFETY_MS ceiling and empty-dice events).
  const handleSettled = useCallback(() => setRevealed(true), []);

  // Pop the total in when it appears.
  useEffect(() => {
    if (revealed && totalRef.current) {
      animate(totalRef.current, { scale: [0, 1.18, 1], duration: 500, ease: "out(3)" });
    }
  }, [revealed]);

  const handleDone = useCallback(() => {
    if (finishing.current) return;
    finishing.current = true;
    setRevealed(true);
    const finish = () => {
      finishing.current = false;
      setRevealed(false);
      dequeueDice(); // promotes the next queued event (if any)
    };
    const el = wrapRef.current;
    if (el) {
      animate(el, { opacity: [1, 0], duration: FADE_MS, ease: "inOut(2)", onComplete: finish });
    } else {
      finish();
    }
  }, [dequeueDice]);

  if (!current) return null;

  const totalColor =
    current.crit === "hit"
      ? "text-gold-bright"
      : current.crit === "miss"
        ? "text-blood"
        : "text-parchment";
  const totalGlow =
    current.crit === "hit"
      ? { textShadow: "0 0 18px rgba(232, 200, 122, 0.85), 0 0 42px rgba(232, 114, 42, 0.45)" }
      : undefined;

  return (
    // Keyed by rollId so back-to-back events remount with fresh opacity.
    <div ref={wrapRef} key={current.rollId}>
      <DiceOverlay event={current} onSettled={handleSettled} onDone={handleDone} />
      <div className="fixed bottom-24 inset-x-0 z-50 pointer-events-none flex justify-center">
        <div className="flex flex-col items-center gap-1 rounded border border-gold/30 bg-ink/85 px-8 py-4 backdrop-blur-sm">
          <p className="font-display text-xs uppercase tracking-[0.2em] text-gold">
            {current.actorName} — {current.purpose}
          </p>
          {revealed && (
            <div
              ref={totalRef}
              className={`font-dice text-4xl ${totalColor}`}
              style={{ transform: "scale(0)", ...totalGlow }}
            >
              {current.total}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
