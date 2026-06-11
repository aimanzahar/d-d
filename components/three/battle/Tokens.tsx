"use client";

// Player and monster tokens: capsule body, base ring, billboarded HP bar +
// label, invisible click hitbox. Tokens glide between cells with maath
// damping; the active token's ring pulses and casts a soft point light.

import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import type { ThreeEvent } from "@react-three/fiber";
import { Billboard } from "@react-three/drei";
import { damp3 } from "maath/easing";
import { useGameStore, type TokenView } from "@/stores/gameStore";

// Nameplates are canvas-texture sprites rather than troika <Text> — troika
// spins up a hidden WebGL context for SDF generation, which kills software
// renderers (headless/SwiftShader) and costs a context slot everywhere else.
const labelTextureCache = new Map<string, THREE.CanvasTexture>();
function labelTexture(label: string): THREE.CanvasTexture {
  const cached = labelTextureCache.get(label);
  if (cached) return cached;
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, 256, 64);
  ctx.font = "bold 30px Georgia, serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = 6;
  ctx.strokeStyle = "#0c0a14";
  ctx.strokeText(label, 128, 32, 248);
  ctx.fillStyle = "#e8dcc0";
  ctx.fillText(label, 128, 32, 248);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  labelTextureCache.set(label, texture);
  return texture;
}

// --- module-cached geometries -----------------------------------------------
const bodyGeometry = /* @__PURE__ */ new THREE.CapsuleGeometry(0.28, 0.45);
const ringGeometry = /* @__PURE__ */ new THREE.TorusGeometry(0.42, 0.045);
const hitboxGeometry = /* @__PURE__ */ new THREE.CylinderGeometry(0.5, 0.5, 1.6, 12);
const barBgGeometry = /* @__PURE__ */ new THREE.PlaneGeometry(0.84, 0.1);
const barFillGeometry = /* @__PURE__ */ new THREE.PlaneGeometry(0.8, 0.07);

// --- module-cached materials -------------------------------------------------
const mineBodyMaterial = /* @__PURE__ */ new THREE.MeshStandardMaterial({
  color: "#e8c87a",
  emissive: "#c9a45c",
  emissiveIntensity: 0.3,
});
const pcBodyMaterial = /* @__PURE__ */ new THREE.MeshStandardMaterial({
  color: "#9a854f",
});
const monsterBodyMaterial = /* @__PURE__ */ new THREE.MeshStandardMaterial({
  color: "#a32638",
  emissive: "#5a0f1c",
  emissiveIntensity: 0.25,
});
const hitboxMaterial = /* @__PURE__ */ new THREE.MeshBasicMaterial({ visible: false });
const barBgMaterial = /* @__PURE__ */ new THREE.MeshBasicMaterial({ color: "#0c0a14" });
const barFillGreen = /* @__PURE__ */ new THREE.MeshBasicMaterial({ color: "#3f9e63" });
const barFillOrange = /* @__PURE__ */ new THREE.MeshBasicMaterial({ color: "#e8722a" });
const barFillRed = /* @__PURE__ */ new THREE.MeshBasicMaterial({ color: "#a32638" });

const RING_GOLD = "#c9a45c";
const RING_BLOOD = "#a32638";
const RING_BASE_INTENSITY = 0.3;

function Token({
  token,
  width,
  height,
}: {
  token: TokenView;
  width: number;
  height: number;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const target = useRef(new THREE.Vector3());
  // Capture spawn cell once so re-renders never snap the gliding group back.
  const spawn = useRef({ x: token.x, y: token.y });

  // Ring material is per-token (NOT module-cached) because the active pulse
  // mutates emissiveIntensity — sharing it would pulse every token's ring.
  const ringColor = token.kind === "monster" ? RING_BLOOD : RING_GOLD;
  const ringMaterial = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: ringColor,
        emissive: ringColor,
        emissiveIntensity: RING_BASE_INTENSITY,
      }),
    [ringColor],
  );
  useEffect(() => () => ringMaterial.dispose(), [ringMaterial]);
  useEffect(() => {
    if (!token.active) ringMaterial.emissiveIntensity = RING_BASE_INTENSITY;
  }, [token.active, ringMaterial]);

  useFrame((state, delta) => {
    const group = groupRef.current;
    if (!group) return;
    target.current.set(token.x - width / 2 + 0.5, 0, token.y - height / 2 + 0.5);
    damp3(group.position, target.current, 0.18, delta);
    if (token.active) {
      ringMaterial.emissiveIntensity =
        RING_BASE_INTENSITY + 0.5 * Math.abs(Math.sin(state.clock.elapsedTime * 3));
    }
  });

  const handlePointerDown = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    const { targetMode, onMonsterClick } = useGameStore.getState();
    if (
      token.kind === "monster" &&
      (targetMode === "attack" || targetMode === "spell-target")
    ) {
      onMonsterClick?.(token.label);
    }
  };

  const bodyMaterial =
    token.kind === "monster"
      ? monsterBodyMaterial
      : token.mine
        ? mineBodyMaterial
        : pcBodyMaterial;

  const ratio =
    token.maxHp > 0 ? Math.max(0, Math.min(1, token.hp / token.maxHp)) : 0;
  const fillMaterial =
    ratio > 0.5 ? barFillGreen : ratio > 0.25 ? barFillOrange : barFillRed;

  return (
    <group
      ref={groupRef}
      position={[
        spawn.current.x - width / 2 + 0.5,
        0,
        spawn.current.y - height / 2 + 0.5,
      ]}
    >
      <mesh
        geometry={bodyGeometry}
        material={bodyMaterial}
        position={[0, 0.62, 0]}
        castShadow
      />
      <mesh
        geometry={ringGeometry}
        material={ringMaterial}
        rotation-x={-Math.PI / 2}
        position={[0, 0.03, 0]}
      />
      <mesh
        geometry={hitboxGeometry}
        material={hitboxMaterial}
        position={[0, 0.8, 0]}
        onPointerDown={handlePointerDown}
      />
      {token.active && (
        <pointLight
          position={[0, 1.1, 0]}
          color={token.kind === "monster" ? "#ff6a4d" : "#e8c87a"}
          intensity={1.2}
          distance={3}
        />
      )}
      <Billboard position={[0, 1.45, 0]}>
        <mesh geometry={barBgGeometry} material={barBgMaterial} />
        <mesh
          geometry={barFillGeometry}
          material={fillMaterial}
          position={[-0.4 + 0.4 * ratio, 0, 0.001]}
          scale={[ratio, 1, 1]}
        />
        <mesh position={[0, 0.26, 0]}>
          <planeGeometry args={[1.4, 0.35]} />
          <meshBasicMaterial map={labelTexture(token.label)} transparent depthWrite={false} />
        </mesh>
      </Billboard>
    </group>
  );
}

export function Tokens() {
  const combat = useGameStore((s) => s.combat);
  if (!combat) return null;
  return (
    <group>
      {combat.tokens
        .filter((t) => !t.dead)
        .map((t) => (
          <Token key={t.id} token={t} width={combat.width} height={combat.height} />
        ))}
    </group>
  );
}
