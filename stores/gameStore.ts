"use client";

// The Convex ↔ three.js bridge. ConvexBridge (a renderless component) is the
// only writer of game state; 3D components read from here so live queries
// never re-render the canvas tree wholesale.

import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";

export type DiceEvent = {
  rollId: string;
  actorName: string;
  purpose: string;
  dice: { sides: number; count: number; results: number[]; dropped: number[] }[];
  total: number;
  crit?: "hit" | "miss";
  at: number; // server rolledAt — the feed hides anything written after this until the dice land
};

export type TokenView = {
  id: string;
  kind: "pc" | "monster";
  label: string;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  mine: boolean;
  active: boolean;
  dead: boolean;
};

export type CombatView = {
  width: number;
  height: number;
  terrain: string[];
  theme: string;
  round: number;
  tokens: TokenView[];
};

// Targeting state set by CombatHUD; consumed by the 3D battle map.
export type TargetMode = "move" | "attack" | "spell-target" | "spell-aoe" | null;

type GameStore = {
  sceneType: string;
  mode: "exploration" | "combat";
  combat: CombatView | null;
  diceQueue: DiceEvent[];
  animatedRollIds: Set<string>;

  targetMode: TargetMode;
  reachable: Map<string, number>;
  onCellClick: ((x: number, y: number) => void) | null;
  onMonsterClick: ((label: string) => void) | null;

  setScene: (sceneType: string, mode: "exploration" | "combat") => void;
  setCombat: (combat: CombatView | null) => void;
  enqueueDice: (events: DiceEvent[]) => void;
  dequeueDice: () => DiceEvent | undefined;
  setTargeting: (
    mode: TargetMode,
    reachable: Map<string, number>,
    onCellClick: ((x: number, y: number) => void) | null,
    onMonsterClick: ((label: string) => void) | null,
  ) => void;
};

export const useGameStore = create<GameStore>()(
  subscribeWithSelector((set, get) => ({
    sceneType: "tavern",
    mode: "exploration",
    combat: null,
    diceQueue: [],
    animatedRollIds: new Set<string>(),

    targetMode: null,
    reachable: new Map(),
    onCellClick: null,
    onMonsterClick: null,

    setScene: (sceneType, mode) => {
      const s = get();
      if (s.sceneType !== sceneType || s.mode !== mode) set({ sceneType, mode });
    },
    setCombat: (combat) => set({ combat }),
    enqueueDice: (events) => {
      const seen = get().animatedRollIds;
      const fresh = events.filter((e) => !seen.has(e.rollId));
      if (fresh.length === 0) return;
      for (const e of fresh) seen.add(e.rollId);
      set({ diceQueue: [...get().diceQueue, ...fresh] });
    },
    dequeueDice: () => {
      const [head, ...rest] = get().diceQueue;
      if (head) set({ diceQueue: rest });
      return head;
    },
    setTargeting: (targetMode, reachable, onCellClick, onMonsterClick) =>
      set({ targetMode, reachable, onCellClick, onMonsterClick }),
  })),
);

// Debug handle (used by E2E checks)
if (typeof window !== "undefined") {
  (window as unknown as { __gameStore?: unknown }).__gameStore = useGameStore;
}
