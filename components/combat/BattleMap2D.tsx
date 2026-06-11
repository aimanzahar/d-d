"use client";

import { useMemo } from "react";
import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";
import type { Doc } from "@/convex/_generated/dataModel";
import { endableCells, key, reachableCells } from "@/convex/lib/grid";

type CombatState = NonNullable<FunctionReturnType<typeof api.combat.get>>;

export type TargetMode = "move" | "attack" | "spell-target" | "spell-aoe" | null;

const TERRAIN_STYLE: Record<string, string> = {
  "#": "bg-[#2a2438]",
  "^": "bg-[#1d1a14]",
  "~": "bg-[#10202e]",
  ".": "bg-[#171320]",
  " ": "bg-[#171320]",
};

export function BattleMap2D({
  combat,
  party,
  myCharacterId,
  mode,
  onCellClick,
  onMonsterClick,
}: {
  combat: CombatState;
  party: Doc<"characters">[];
  myCharacterId: string | null;
  mode: TargetMode;
  onCellClick: (x: number, y: number) => void;
  onMonsterClick: (label: string) => void;
}) {
  const me = party.find((c) => String(c._id) === myCharacterId);
  const isMyTurn =
    combat.initiative[combat.activeIndex]?.refId === myCharacterId;

  // Movement-range highlight (client mirror of the server validation)
  const reachable = useMemo(() => {
    if (mode !== "move" || !me?.position || !isMyTurn) return new Map<string, number>();
    const blockers = new Set(
      combat.monsters.filter((m) => !m.isDead).map((m) => key(m.position)),
    );
    const passThrough = new Set(
      party
        .filter((c) => String(c._id) !== myCharacterId && c.position)
        .map((c) => key(c.position!)),
    );
    const reach = reachableCells({
      terrain: combat.map.terrain,
      width: combat.map.width,
      height: combat.map.height,
      start: me.position,
      budgetFeet: me.speed - combat.turnState.movementUsed,
      blockers,
      passThrough,
    });
    return endableCells(reach, passThrough);
  }, [mode, me, isMyTurn, combat, party, myCharacterId]);

  const tokensByCell = useMemo(() => {
    const map = new Map<string, { type: "pc" | "monster"; label: string; hpPct: number; mine: boolean; dead?: boolean }>();
    for (const m of combat.monsters) {
      if (m.isDead) continue;
      map.set(key(m.position), {
        type: "monster",
        label: m.label,
        hpPct: m.currentHp / m.maxHp,
        mine: false,
      });
    }
    for (const c of party) {
      if (!c.position || c.conditions.some((x) => x.name === "dead")) continue;
      map.set(key(c.position), {
        type: "pc",
        label: c.name,
        hpPct: c.currentHp / c.maxHp,
        mine: String(c._id) === myCharacterId,
      });
    }
    return map;
  }, [combat.monsters, party, myCharacterId]);

  const active = combat.initiative[combat.activeIndex];

  return (
    <div className="overflow-auto p-2 flex justify-center">
      <div
        className="grid gap-px bg-ink/80 border border-gold-dim/30 select-none"
        style={{
          gridTemplateColumns: `repeat(${combat.map.width}, 26px)`,
          gridTemplateRows: `repeat(${combat.map.height}, 26px)`,
        }}
      >
        {Array.from({ length: combat.map.height }).flatMap((_, y) =>
          Array.from({ length: combat.map.width }).map((_, x) => {
            const k = `${x},${y}`;
            const terrain = combat.map.terrain[y]?.[x] ?? "#";
            const token = tokensByCell.get(k);
            const inReach = reachable.has(k);
            const clickable =
              (mode === "move" && inReach && !token) ||
              (mode === "spell-aoe") ||
              ((mode === "attack" || mode === "spell-target") && token?.type === "monster");
            return (
              <button
                key={k}
                disabled={!clickable}
                onClick={() => {
                  if (token?.type === "monster" && (mode === "attack" || mode === "spell-target")) {
                    onMonsterClick(token.label);
                  } else {
                    onCellClick(x, y);
                  }
                }}
                title={token ? token.label : `(${x},${y})${terrain === "^" || terrain === "~" ? " difficult" : ""}`}
                className={`relative flex items-center justify-center text-[0.6rem] font-dice transition-colors ${TERRAIN_STYLE[terrain] ?? TERRAIN_STYLE["."]} ${
                  inReach && mode === "move" ? "bg-vitality/20 hover:bg-vitality/40 cursor-pointer" : ""
                } ${clickable && mode !== "move" ? "cursor-pointer hover:ring-1 hover:ring-ember" : ""}`}
              >
                {terrain === "^" && !token && <span className="text-parchment-faint/40">▲</span>}
                {terrain === "~" && !token && <span className="text-[#3d6a8a]">≈</span>}
                {token && (
                  <span
                    className={`w-[20px] h-[20px] rounded-full flex items-center justify-center font-bold text-[0.6rem] ${
                      token.type === "pc"
                        ? token.mine
                          ? "bg-gold text-ink ring-2 ring-gold-bright"
                          : "bg-[#7a6a3f] text-ink"
                        : "bg-blood text-parchment"
                    } ${active && token.label === active.name ? "animate-ember-pulse" : ""}`}
                  >
                    {token.label[0]}
                    <span
                      className="absolute -bottom-[2px] left-1/2 -translate-x-1/2 h-[3px] rounded-full bg-vitality"
                      style={{ width: `${Math.max(15, token.hpPct * 100) / 5}px`, backgroundColor: token.hpPct > 0.5 ? "var(--color-vitality)" : token.hpPct > 0.25 ? "var(--color-ember)" : "var(--color-blood)" }}
                    />
                  </span>
                )}
              </button>
            );
          }),
        )}
      </div>
    </div>
  );
}
