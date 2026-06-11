"use client";

// Flat terrain colormap + picking surface for the tactical battle map.
// One plane mesh textured with a per-cell DataTexture, plus a drei Grid
// overlay for cell lines. Pointer-down resolves the clicked cell and routes
// it to the store's onCellClick for move / spell-aoe targeting.

import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { Grid } from "@react-three/drei";
import type { ThreeEvent } from "@react-three/fiber";
import { useGameStore, type CombatView } from "@/stores/gameStore";

// Per-terrain-char RGB values (0-255).
const CELL_COLORS: Record<string, readonly [number, number, number]> = {
  ".": [0x17, 0x13, 0x20], // open floor
  "#": [0x2a, 0x24, 0x38], // wall (matches wall block color)
  "^": [0x24, 0x1d, 0x12], // difficult terrain
  "~": [0x10, 0x20, 0x2e], // water
};
const OPEN_COLOR = CELL_COLORS["."];

export function GroundPlane({ combat }: { combat: CombatView }) {
  const { width, height, terrain } = combat;

  const texture = useMemo(() => {
    const data = new Uint8Array(width * height * 4);
    // Orientation: the plane is rotated -PI/2 about X, so UV v=0 (texel row 0
    // when flipY=false) lands on the +Z edge of the map — the BOTTOM row of
    // cells (y = height-1). Cell (0,0) must sit at world (-w/2+0.5, 0,
    // -h/2+0.5), i.e. terrain row 0 belongs at v=1. Rather than relying on
    // flipY (whose upload behavior is inconsistent for DataTexture on some
    // WebGL2 texStorage paths), we write the rows in reverse order, which is
    // deterministic: terrain row y -> texel row (height-1-y).
    for (let y = 0; y < height; y++) {
      const row = terrain[y] ?? "";
      const texelRow = height - 1 - y;
      for (let x = 0; x < width; x++) {
        const rgb = CELL_COLORS[row[x] ?? "."] ?? OPEN_COLOR;
        const i = (texelRow * width + x) * 4;
        data[i] = rgb[0];
        data[i + 1] = rgb[1];
        data[i + 2] = rgb[2];
        data[i + 3] = 255;
      }
    }
    const tex = new THREE.DataTexture(data, width, height, THREE.RGBAFormat);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.flipY = false; // rows are pre-flipped in the data above
    tex.needsUpdate = true;
    return tex;
  }, [width, height, terrain]);

  useEffect(() => () => texture.dispose(), [texture]);

  const handlePointerDown = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    const x = Math.floor(e.point.x + width / 2);
    const y = Math.floor(e.point.z + height / 2);
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    const { targetMode, onCellClick } = useGameStore.getState();
    if (targetMode === "move" || targetMode === "spell-aoe") {
      onCellClick?.(x, y);
    }
  };

  return (
    <group>
      <mesh
        rotation-x={-Math.PI / 2}
        position={[0, 0.001, 0]}
        onPointerDown={handlePointerDown}
        receiveShadow
      >
        <planeGeometry args={[width, height]} />
        <meshStandardMaterial map={texture} roughness={0.95} />
      </mesh>
      <Grid
        position={[0, 0.012, 0]}
        args={[width, height]}
        cellSize={1}
        cellThickness={0.6}
        cellColor="#3a3450"
        sectionSize={5}
        sectionThickness={1}
        sectionColor="#6a5a35"
        fadeDistance={48}
        infiniteGrid={false}
      />
    </group>
  );
}
