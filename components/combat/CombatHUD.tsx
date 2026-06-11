"use client";

import { animate } from "animejs";
import { useMutation, useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import { useEffect, useRef, useState } from "react";
import { api } from "@/convex/_generated/api";
import { useSession } from "@/hooks/useSession";
import { Button } from "@/components/ui/Button";
import { BattleMap2D, type TargetMode } from "./BattleMap2D";

export function CombatHUD() {
  const session = useSession();
  const combat = useQuery(api.combat.get, {
    sessionToken: session.sessionToken,
    campaignId: session.campaignId,
  });
  const party = useQuery(api.characters.getParty, {
    sessionToken: session.sessionToken,
    campaignId: session.campaignId,
  });
  const myCharacter = useQuery(api.characters.getMine, { sessionToken: session.sessionToken });

  const move = useMutation(api.combat.move);
  const attack = useMutation(api.combat.attack);
  const castSpell = useMutation(api.combat.castSpell);
  const simpleAction = useMutation(api.combat.useSimpleAction);
  const endTurn = useMutation(api.combat.endTurn);
  const skipTurn = useMutation(api.combat.hostSkipTurn);

  const [mode, setMode] = useState<TargetMode>(null);
  const [spellIndex, setSpellIndex] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const bannerRef = useRef<HTMLDivElement>(null);
  const lastActive = useRef<string>("");

  const active = combat?.initiative[combat.activeIndex];
  const isMyTurn = !!combat && active?.refId === String(session.characterId);

  // Turn banner sweep on every turn change
  useEffect(() => {
    if (!active || active.name === lastActive.current) return;
    lastActive.current = active.name;
    setMode(null);
    if (bannerRef.current) {
      animate(bannerRef.current, {
        opacity: [0, 1, 1, 0],
        translateX: [-40, 0, 0, 40],
        duration: 1800,
        ease: "inOut(2)",
      });
    }
  }, [active]);

  if (!combat || !party) return null;

  const incapacitated = myCharacter?.conditions.some((c) =>
    ["unconscious", "dead", "stable"].includes(c.name),
  );

  async function guard<T>(fn: () => Promise<T>) {
    setError(null);
    try {
      return await fn();
    } catch (e) {
      const data = e instanceof ConvexError ? (e.data as any) : null;
      setError(
        data?.code === "not_your_turn"
          ? `It's ${data.active}'s turn.`
          : data?.code === "action_used"
            ? "Your action is spent this round."
            : data?.code === "unreachable"
              ? "You can't reach that cell this turn."
              : data?.code === "out_of_range"
                ? `Out of range (${data.distance} ft away, max ${data.range} ft).`
                : (data?.code ?? "That didn't work."),
      );
      return null;
    }
  }

  const spells = myCharacter?.spellcasting
    ? [
        ...myCharacter.spellcasting.cantrips.map((s) => ({ index: s, cantrip: true })),
        ...myCharacter.spellcasting.prepared.map((s) => ({ index: s, cantrip: false })),
      ]
    : [];

  return (
    <div className="border-b border-gold-dim/30 bg-ink-soft/60">
      {/* initiative strip */}
      <div className="flex items-center gap-1.5 px-3 py-2 overflow-x-auto">
        <span className="font-display text-[0.6rem] tracking-[0.25em] uppercase text-blood shrink-0 mr-1">
          ⚔ R{combat.round}
        </span>
        {combat.initiative.map((entry, i) => {
          const monster = combat.monsters.find((m) => String(m._id) === entry.refId);
          const dead =
            monster?.isDead ||
            party.find((c) => String(c._id) === entry.refId)?.conditions.some((x) => x.name === "dead");
          return (
            <span
              key={entry.refId}
              className={`shrink-0 px-2 py-1 text-[0.65rem] font-display tracking-wide border ${
                i === combat.activeIndex
                  ? "border-ember text-ember-bright bg-ember/10 animate-ember-pulse"
                  : dead
                    ? "border-gold-dim/20 text-parchment-faint/40 line-through"
                    : entry.kind === "pc"
                      ? "border-gold-dim/40 text-parchment-dim"
                      : "border-blood/40 text-blood/90"
              }`}
            >
              {entry.name} {entry.total}
            </span>
          );
        })}
        {session.isHost && !isMyTurn && (
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto shrink-0"
            onClick={() =>
              guard(() => skipTurn({ sessionToken: session.sessionToken, campaignId: session.campaignId }))
            }
            title="Skip an absent player's turn"
          >
            Skip turn
          </Button>
        )}
      </div>

      {/* turn banner */}
      <div ref={bannerRef} className="text-center font-display text-sm tracking-[0.3em] uppercase text-gold py-0.5 opacity-0 pointer-events-none">
        {active ? `${active.name}'s turn` : ""}
      </div>

      <BattleMap2D
        combat={combat}
        party={party}
        myCharacterId={session.characterId ? String(session.characterId) : null}
        mode={mode}
        onCellClick={(x, y) => {
          if (mode === "move") {
            void guard(() => move({ sessionToken: session.sessionToken, toX: x, toY: y })).then(() =>
              setMode(null),
            );
          } else if (mode === "spell-aoe" && spellIndex) {
            void guard(() =>
              castSpell({ sessionToken: session.sessionToken, spellIndex, originX: x, originY: y }),
            ).then(() => setMode(null));
          }
        }}
        onMonsterClick={(label) => {
          if (mode === "attack") {
            void guard(() => attack({ sessionToken: session.sessionToken, targetLabel: label })).then(() =>
              setMode(null),
            );
          } else if (mode === "spell-target" && spellIndex) {
            void guard(() =>
              castSpell({ sessionToken: session.sessionToken, spellIndex, targetLabel: label }),
            ).then(() => setMode(null));
          }
        }}
      />

      {/* action bar */}
      {isMyTurn && !incapacitated && (
        <div className="flex flex-wrap items-center gap-2 px-3 pb-3">
          <Button
            variant={mode === "move" ? "ember" : "gold"}
            size="sm"
            onClick={() => setMode(mode === "move" ? null : "move")}
          >
            Move ({myCharacter ? myCharacter.speed - combat.turnState.movementUsed : 0} ft)
          </Button>
          <Button
            variant={mode === "attack" ? "ember" : "gold"}
            size="sm"
            disabled={combat.turnState.actionUsed}
            onClick={() => setMode(mode === "attack" ? null : "attack")}
          >
            Attack
          </Button>
          {spells.length > 0 && (
            <span className="flex items-center gap-1">
              <select
                className="field-arcane px-2 py-1.5 text-xs max-w-[150px]"
                value={spellIndex}
                onChange={(e) => setSpellIndex(e.target.value)}
              >
                <option value="">— spell —</option>
                {spells.map((s) => (
                  <option key={s.index} value={s.index}>
                    {s.index.replace(/-/g, " ")}{s.cantrip ? " ◦" : ""}
                  </option>
                ))}
              </select>
              <Button
                variant={mode?.startsWith("spell") ? "ember" : "gold"}
                size="sm"
                disabled={!spellIndex || combat.turnState.actionUsed}
                onClick={() => setMode(mode?.startsWith("spell") ? null : "spell-target")}
                title="Click a monster (or switch to area mode)"
              >
                Cast
              </Button>
              {mode?.startsWith("spell") && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setMode(mode === "spell-aoe" ? "spell-target" : "spell-aoe")}
                >
                  {mode === "spell-aoe" ? "→ target" : "→ area"}
                </Button>
              )}
            </span>
          )}
          {(["dodge", "dash", "disengage"] as const).map((a) => (
            <Button
              key={a}
              variant="ghost"
              size="sm"
              disabled={combat.turnState.actionUsed}
              onClick={() => guard(() => simpleAction({ sessionToken: session.sessionToken, action: a }))}
            >
              {a}
            </Button>
          ))}
          <Button
            variant="ember"
            size="sm"
            className="ml-auto"
            onClick={() => guard(() => endTurn({ sessionToken: session.sessionToken }))}
          >
            End turn
          </Button>
        </div>
      )}
      {isMyTurn && mode && (
        <p className="px-3 pb-2 font-narrative italic text-xs text-arcane-soft">
          {mode === "move" && "Click a highlighted cell to move."}
          {mode === "attack" && "Click an enemy token to strike."}
          {mode === "spell-target" && "Click an enemy token to cast."}
          {mode === "spell-aoe" && "Click the center cell for the area effect."}
        </p>
      )}
      {error && (
        <p className="px-3 pb-2 font-narrative italic text-xs text-blood" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
