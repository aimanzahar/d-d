import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";
import type { AbilityKey } from "@/lib/abilities";

export type CreationData = FunctionReturnType<typeof api.srdData.creationData>;
export type RaceList = FunctionReturnType<typeof api.srdData.listRaces>;
export type ClassList = FunctionReturnType<typeof api.srdData.listClasses>;

export type ChoicePick = { key: string; categoryPicks?: string[][] };

export type Draft = {
  raceIndex: string | null;
  subraceIndex: string | null;
  classIndex: string | null;
  method: "standard" | "pointbuy";
  baseScores: Record<AbilityKey, number>;
  submission: Record<string, ChoicePick[]>;
  cantrips: string[];
  spells: string[];
  name: string;
  alignment: string;
  notes: string;
};

export const EMPTY_DRAFT: Draft = {
  raceIndex: null,
  subraceIndex: null,
  classIndex: null,
  method: "standard",
  baseScores: { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 },
  submission: {},
  cantrips: [],
  spells: [],
  name: "",
  alignment: "",
  notes: "",
};
