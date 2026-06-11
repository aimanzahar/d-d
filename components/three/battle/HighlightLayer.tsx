"use client";

// Reachable / targetable cell highlights. A single InstancedMesh of flat
// quads is rebuilt (event-driven, never per-frame) whenever the store's
// targeting state changes. Green for movement, violet for spell modes,
// hidden for attack/no targeting.

import { useLayoutEffect, useRef } from "react";
import * as THREE from "three";
import { useThree } from "@react-three/fiber";
import { useGameStore } from "@/stores/gameStore";

const CAPACITY = 600;

// Module-cached resources — created once per JS module, shared by the single
// HighlightLayer instance.
const highlightGeometry = /* @__PURE__ */ (() => {
  const geo = new THREE.PlaneGeometry(0.92, 0.92);
  geo.rotateX(-Math.PI / 2); // lie flat so instance matrices are pure translations
  return geo;
})();

const highlightMaterial = /* @__PURE__ */ new THREE.MeshBasicMaterial({
  transparent: true,
  opacity: 0.3,
  depthWrite: false,
});

const COLOR_MOVE = /* @__PURE__ */ new THREE.Color("#3f9e63");
const COLOR_SPELL = /* @__PURE__ */ new THREE.Color("#8b5cf6");
const tmpMatrix = /* @__PURE__ */ new THREE.Matrix4();

export function HighlightLayer() {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const invalidate = useThree((s) => s.invalidate);

  const combat = useGameStore((s) => s.combat);
  const targetMode = useGameStore((s) => s.targetMode);
  const reachable = useGameStore((s) => s.reachable);

  useLayoutEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    if (!combat || targetMode === null || targetMode === "attack") {
      mesh.count = 0;
      invalidate();
      return;
    }
    highlightMaterial.color.copy(targetMode === "move" ? COLOR_MOVE : COLOR_SPELL);
    const { width, height } = combat;
    let i = 0;
    for (const key of reachable.keys()) {
      if (i >= CAPACITY) break;
      const comma = key.indexOf(",");
      const x = Number(key.slice(0, comma));
      const y = Number(key.slice(comma + 1));
      tmpMatrix.makeTranslation(x - width / 2 + 0.5, 0, y - height / 2 + 0.5);
      mesh.setMatrixAt(i, tmpMatrix);
      i++;
    }
    mesh.count = i;
    mesh.instanceMatrix.needsUpdate = true;
    invalidate();
  }, [combat, targetMode, reachable, invalidate]);

  if (!combat) return null;

  return (
    <instancedMesh
      ref={meshRef}
      args={[highlightGeometry, highlightMaterial, CAPACITY]}
      position={[0, 0.02, 0]}
      count={0}
      frustumCulled={false}
    />
  );
}
