"use client";

// Root of the 3D tactical battle map. Composes the ground plane, cell
// highlights, tokens, and an instanced wall layer, and plays an entrance
// animation (rise from y=-1.2) whenever a new combat map appears.

import { useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import { damp } from "maath/easing";
import { useGameStore } from "@/stores/gameStore";
import { GroundPlane } from "./GroundPlane";
import { HighlightLayer } from "./HighlightLayer";
import { Tokens } from "./Tokens";

// Module-cached wall resources: one unit-footprint box, 0.55 tall.
const wallGeometry = /* @__PURE__ */ new THREE.BoxGeometry(1, 0.55, 1);
const wallMaterial = /* @__PURE__ */ new THREE.MeshStandardMaterial({
  color: "#2a2438",
  emissive: "#1a1428",
});
const tmpMatrix = /* @__PURE__ */ new THREE.Matrix4();

export function BattleMap3D() {
  const combat = useGameStore((s) => s.combat);
  const groupRef = useRef<THREE.Group>(null);
  const wallsRef = useRef<THREE.InstancedMesh>(null);
  // CombatView carries no id, so a new encounter is detected by its map
  // signature (dims + terrain). Token movement/HP updates don't retrigger.
  const entranceKey = useRef<string | null>(null);

  const terrain = combat?.terrain;
  const width = combat?.width ?? 0;
  const height = combat?.height ?? 0;
  const mapKey = terrain ? `${width}x${height}|${terrain.join("\n")}` : null;

  const wallCells = useMemo(() => {
    const cells: Array<[number, number]> = [];
    if (!terrain) return cells;
    for (let y = 0; y < height; y++) {
      const row = terrain[y] ?? "";
      for (let x = 0; x < width; x++) {
        if (row[x] === "#") cells.push([x, y]);
      }
    }
    return cells;
  }, [terrain, width, height]);

  // Entrance: drop the whole map group and let useFrame damp it up to 0.
  useLayoutEffect(() => {
    if (!mapKey) {
      entranceKey.current = null;
      return;
    }
    if (entranceKey.current !== mapKey) {
      entranceKey.current = mapKey;
      groupRef.current?.position.setY(-1.2);
    }
  }, [mapKey]);

  // Rebuild wall instance matrices whenever the terrain changes.
  useLayoutEffect(() => {
    const mesh = wallsRef.current;
    if (!mesh) return;
    for (let i = 0; i < wallCells.length; i++) {
      const [x, y] = wallCells[i];
      tmpMatrix.makeTranslation(x - width / 2 + 0.5, 0.275, y - height / 2 + 0.5);
      mesh.setMatrixAt(i, tmpMatrix);
    }
    mesh.count = wallCells.length;
    mesh.instanceMatrix.needsUpdate = true;
  }, [wallCells, width, height]);

  useFrame((_, delta) => {
    const group = groupRef.current;
    if (!group || group.position.y === 0) return;
    damp(group.position, "y", 0, 0.35, delta);
  });

  if (!combat) return null;

  return (
    <group ref={groupRef}>
      {/* The battlefield carries its own light — ambient scenes dim in combat */}
      <ambientLight intensity={0.5} color="#cdc4e8" />
      <directionalLight position={[6, 12, 4]} intensity={1.1} color="#e8dcc0" />
      <pointLight position={[0, 6, 0]} intensity={14} distance={26} color="#c9a45c" />
      <GroundPlane combat={combat} />
      <HighlightLayer />
      <instancedMesh
        key={mapKey ?? "walls"}
        ref={wallsRef}
        args={[wallGeometry, wallMaterial, Math.max(wallCells.length, 1)]}
        frustumCulled={false}
        castShadow
        receiveShadow
      />
      <Tokens />
    </group>
  );
}
