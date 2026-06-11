"use client";

import { animate } from "animejs";
import { useMutation, useQuery } from "convex/react";
import { useEffect, useRef, useState } from "react";
import { api } from "@/convex/_generated/api";
import { useSession } from "@/hooks/useSession";
import { Button } from "@/components/ui/Button";

export function RollPrompt() {
  const session = useSession();
  const pending = useQuery(api.dice.pendingRolls, {
    sessionToken: session.sessionToken,
    campaignId: session.campaignId,
  });
  const fulfill = useMutation(api.dice.fulfillRequest);
  const [busy, setBusy] = useState(false);
  const bannerRef = useRef<HTMLDivElement>(null);

  const mine = (pending ?? []).filter((r) => r.mine);
  const others = (pending ?? []).filter((r) => !r.mine);

  useEffect(() => {
    if (mine.length > 0 && bannerRef.current) {
      const anim = animate(bannerRef.current, {
        translateY: [-16, 0],
        opacity: [0, 1],
        duration: 450,
        ease: "out(3)",
      });
      return () => {
        anim.revert();
      };
    }
  }, [mine.length]);

  if (mine.length === 0 && others.length === 0) return null;

  return (
    <div className="px-4 pt-3 space-y-2">
      {mine.map((roll) => (
        <div
          key={roll._id}
          ref={bannerRef}
          className="flex items-center gap-4 border border-ember bg-ember/10 px-4 py-3 animate-ember-pulse"
        >
          <span className="font-dice text-xl" aria-hidden>
            ⟁
          </span>
          <div className="flex-1">
            <p className="font-display text-xs tracking-[0.2em] uppercase text-ember-bright">
              The GM calls for a roll
            </p>
            <p className="font-narrative italic text-sm text-parchment-dim">
              {roll.context ?? roll.purpose}
              {roll.skill ? ` — ${roll.skill}` : roll.ability ? ` — ${roll.ability.toUpperCase()}` : ""}
              {roll.advantage !== "normal" ? ` (${roll.advantage})` : ""}
            </p>
          </div>
          <Button
            variant="ember"
            size="md"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await fulfill({ sessionToken: session.sessionToken, rollId: roll._id });
              } finally {
                setBusy(false);
              }
            }}
          >
            Roll!
          </Button>
        </div>
      ))}
      {others.map((roll) => (
        <p key={roll._id} className="font-narrative italic text-xs text-parchment-faint text-center">
          Waiting on <span className="text-parchment-dim">{roll.actorName}</span> to roll…
        </p>
      ))}
    </div>
  );
}
