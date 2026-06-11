"use client";

// Picks the ambient backdrop for the current sceneType and dims it during
// combat so the battle map owns the center of the stage.

import { Suspense, type ComponentType } from "react";
import { useGameStore } from "@/stores/gameStore";
import {
  CaveScene,
  DungeonScene,
  ForestScene,
  TavernScene,
  TownScene,
  type AmbientSceneProps,
} from "./scenes";

const SCENE_MAP: Record<string, ComponentType<AmbientSceneProps>> = {
  tavern: TavernScene,
  town: TownScene,
  forest: ForestScene,
  swamp: ForestScene,
  road: ForestScene,
  field: ForestScene,
  camp: ForestScene,
  dungeon: DungeonScene,
  castle: DungeonScene,
  temple: DungeonScene,
  cave: CaveScene,
  mountain: CaveScene,
  ship: CaveScene,
};

export function AmbientStage() {
  const sceneType = useGameStore((s) => s.sceneType);
  const dimmed = useGameStore((s) => s.mode === "combat");
  const Scene = SCENE_MAP[sceneType] ?? ForestScene;

  return (
    <Suspense fallback={null}>
      <Scene dimmed={dimmed} />
    </Suspense>
  );
}
