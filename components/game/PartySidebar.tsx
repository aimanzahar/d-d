"use client";

import { animate } from "animejs";
import { useMutation, useQuery } from "convex/react";
import { useEffect, useRef } from "react";
import { api } from "@/convex/_generated/api";
import type { Doc } from "@/convex/_generated/dataModel";
import { useSession } from "@/hooks/useSession";
import { Panel } from "@/components/ui/Panel";

function HpBar({ current, max, temp }: { current: number; max: number; temp: number }) {
  const ghostRef = useRef<HTMLDivElement>(null);
  const prev = useRef(current);

  useEffect(() => {
    if (!ghostRef.current) return;
    if (current < prev.current) {
      // ghost bar lingers at the old value, then drains down
      ghostRef.current.style.width = `${(prev.current / max) * 100}%`;
      animate(ghostRef.current, {
        width: `${(current / max) * 100}%`,
        duration: 650,
        delay: 260,
        ease: "inOut(3)",
      });
    } else {
      ghostRef.current.style.width = `${(current / max) * 100}%`;
    }
    prev.current = current;
  }, [current, max]);

  const pct = Math.max(0, (current / max) * 100);
  return (
    <div className="relative h-2 bg-ink rounded-sm overflow-hidden border border-gold-dim/20">
      <div ref={ghostRef} className="absolute inset-y-0 left-0 bg-[#d4a017]/50" />
      <div
        className={`absolute inset-y-0 left-0 transition-[width] duration-150 ${
          pct > 50 ? "bg-vitality" : pct > 25 ? "bg-ember" : "bg-blood"
        }`}
        style={{ width: `${pct}%` }}
      />
      {temp > 0 && (
        <div className="absolute inset-y-0 right-0 w-1.5 bg-arcane/70" title={`+${temp} temp HP`} />
      )}
    </div>
  );
}

function MemberCard({ character, isMe }: { character: Doc<"characters">; isMe: boolean }) {
  const session = useSession();
  const levelUp = useMutation(api.characters.levelUp);
  const dead = character.conditions.some((c) => c.name === "dead");
  const down = character.currentHp === 0 && !dead;
  return (
    <Panel
      className={dead ? "grayscale opacity-60" : ""}
      innerClassName="px-3.5 py-3 space-y-1.5"
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-display text-[0.8rem] tracking-wide text-parchment truncate">
          {character.name}
          {isMe && <span className="ml-1.5 text-[0.55rem] text-parchment-faint uppercase">you</span>}
        </span>
        <span
          className="font-dice text-[0.65rem] text-gold shrink-0 border border-gold-dim/40 px-1.5 py-0.5"
          title="Armor class"
        >
          {character.ac}
        </span>
      </div>
      <p className="font-narrative italic text-[0.7rem] text-parchment-faint -mt-1">
        {character.raceIndex} {character.classIndex} {character.level}
      </p>
      <HpBar current={character.currentHp} max={character.maxHp} temp={character.tempHp} />
      <div className="flex items-center justify-between">
        <span className="font-dice text-[0.65rem] text-parchment-dim">
          {character.currentHp}/{character.maxHp} HP
        </span>
        {down && (
          <span className="font-dice text-[0.6rem] text-blood" title="Death saves: successes / failures">
            ☠ {character.deathSaves.successes}✓ {character.deathSaves.failures}✗
          </span>
        )}
      </div>
      {character.conditions.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {character.conditions.map((c) => (
            <span
              key={c.name}
              className="font-display text-[0.55rem] tracking-[0.15em] uppercase px-1.5 py-0.5 border border-blood/50 text-blood/90"
            >
              {c.name}
            </span>
          ))}
        </div>
      )}
      {isMe && character.pendingLevelUp && (
        <button
          className="w-full mt-1 font-display text-[0.6rem] tracking-[0.25em] uppercase px-2 py-1.5 border border-gold text-gold-bright bg-gold/10 cursor-pointer animate-ember-pulse hover:bg-gold/20"
          onClick={() => void levelUp({ sessionToken: session.sessionToken })}
        >
          ✦ Level up!
        </button>
      )}
    </Panel>
  );
}

export function PartySidebar() {
  const session = useSession();
  const party = useQuery(api.characters.getParty, {
    sessionToken: session.sessionToken,
    campaignId: session.campaignId,
  });
  return (
    <aside className="w-[260px] shrink-0 overflow-y-auto p-3 space-y-3 hidden md:block">
      <p className="font-display text-[0.6rem] tracking-[0.35em] uppercase text-gold-dim px-1">
        The Party
      </p>
      {(party ?? []).map((c) => (
        <MemberCard key={c._id} character={c} isMe={c._id === session.characterId} />
      ))}
    </aside>
  );
}
