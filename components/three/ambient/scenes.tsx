"use client";

// The five ambient location backdrops. Each scene owns its fog, lighting,
// particles and silhouette props. `dimmed` (combat mode) cuts light intensity
// ~38%, tightens fog, and pushes silhouettes out past radius ~13 so the battle
// map (18x14 max, centered at origin) is never crowded.

import { useEffect, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { FlickerLight, Ground, ParticleField, SILHOUETTE } from "./kit";

export type AmbientSceneProps = { dimmed?: boolean };

type Vec3Tuple = [number, number, number];

/** Combat-mode light multiplier (~38% dimmer). */
const dimK = (dimmed: boolean) => (dimmed ? 0.62 : 1);

/** In combat, radially push a prop out so it sits beyond the battle map. */
function pushOut(p: Vec3Tuple, dimmed: boolean): Vec3Tuple {
  if (!dimmed) return p;
  const r = Math.hypot(p[0], p[2]);
  if (r >= 12.5) return p;
  const f = r < 0.001 ? 1 : 13 / r;
  return [p[0] * f, p[1], p[2] * f];
}

/* ------------------------------------------------------------------ */
/* Module-cached geometries & materials                                */
/* ------------------------------------------------------------------ */

const BOX = new THREE.BoxGeometry(1, 1, 1);
const CYL = new THREE.CylinderGeometry(1, 1, 1, 12);
const PLANE = new THREE.PlaneGeometry(1, 1);
const TRUNK = new THREE.CylinderGeometry(0.18, 0.5, 1, 8);
const CONE = new THREE.ConeGeometry(1, 1, 8);
const OCTA = new THREE.OctahedronGeometry(1, 0);
const PILLAR = new THREE.CylinderGeometry(0.5, 0.55, 5, 10);
const SKY_SPHERE = new THREE.SphereGeometry(60, 24, 16);

const HEARTH_MAT = new THREE.MeshBasicMaterial({ color: "#ff8c3b", side: THREE.DoubleSide });

const GODRAY_MAT = new THREE.MeshBasicMaterial({
  color: "#b9d2e8",
  transparent: true,
  opacity: 0.05,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  side: THREE.DoubleSide,
});

const SKY_MAT = new THREE.ShaderMaterial({
  side: THREE.BackSide,
  depthWrite: false,
  uniforms: {
    uTop: { value: new THREE.Color("#1a1430") },
    uHorizon: { value: new THREE.Color("#4a2a30") },
  },
  vertexShader: /* glsl */ `
    varying vec3 vPos;
    void main() {
      vPos = position;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform vec3 uTop;
    uniform vec3 uHorizon;
    varying vec3 vPos;
    void main() {
      float h = clamp(normalize(vPos).y, 0.0, 1.0);
      gl_FragColor = vec4(mix(uHorizon, uTop, smoothstep(0.0, 0.55, h)), 1.0);
    }
  `,
});

/* ------------------------------------------------------------------ */
/* TavernScene                                                         */
/* ------------------------------------------------------------------ */

const RAFTER_Z = [-6, -2.5, 1.5, 5.5];
const BARREL_OFFSETS: Vec3Tuple[] = [
  [0, 0.55, 0],
  [1.05, 0.55, 0.35],
  [0.35, 0.55, -1.0],
];

export function TavernScene({ dimmed = false }: AmbientSceneProps) {
  const lk = dimK(dimmed);
  const fogArgs = useMemo<[string, number, number]>(
    () => ["#1a120b", dimmed ? 16 : 8, dimmed ? 64 : 34],
    [dimmed],
  );
  const hearthPos = useMemo(() => pushOut([-7, 0, -4], dimmed), [dimmed]);
  const barrelsPos = useMemo(() => pushOut([8, 0, 4], dimmed), [dimmed]);
  const tablePos = useMemo(() => pushOut([-3, 0.35, 7], dimmed), [dimmed]);

  return (
    <>
      <fog attach="fog" args={fogArgs} />
      <color attach="background" args={["#1a120b"]} />
      <ambientLight color="#2a1c10" intensity={0.25 * lk} />

      {/* Hearth: glowing ember plane + flickering firelight. */}
      <group position={hearthPos}>
        <mesh
          geometry={PLANE}
          material={HEARTH_MAT}
          position={[0, 0.8, 0]}
          rotation-y={Math.PI * 0.25}
          scale={[1.6, 1.1, 1]}
        />
        <FlickerLight color="#ff8c3b" intensity={18 * lk} distance={18} position={[0.6, 1.2, 0.4]} />
      </group>

      {/* Candles. */}
      <FlickerLight color="#ffc066" intensity={2.5 * lk} distance={8} position={[4, 0.9, 2]} />
      <FlickerLight color="#ffc066" intensity={2.5 * lk} distance={8} position={[7, 0.9, -5]} />

      {/* Warm dust motes hanging in the firelight. */}
      <ParticleField count={350} color="#d9b98a" size={0.18} area={[26, 7, 22]} speed={0.25} twinkle opacity={0.55} />

      {/* Rafters overhead — hidden in combat so the top-down camera stays clear. */}
      {!dimmed &&
        RAFTER_Z.map((z) => (
          <mesh key={z} geometry={BOX} material={SILHOUETTE} position={[0, 4.6, z]} scale={[14, 0.32, 0.5]} />
        ))}

      {/* Barrel cluster. */}
      <group position={barrelsPos}>
        {BARREL_OFFSETS.map((o, i) => (
          <mesh key={i} geometry={CYL} material={SILHOUETTE} position={o} scale={[0.55, 1.1, 0.55]} />
        ))}
      </group>

      {/* Table edge at the side of the room. */}
      <mesh geometry={BOX} material={SILHOUETTE} position={tablePos} scale={[2.4, 0.7, 1.1]} />

      <Ground />
    </>
  );
}

/* ------------------------------------------------------------------ */
/* ForestScene                                                         */
/* ------------------------------------------------------------------ */

const TRUNKS: { p: Vec3Tuple; h: number; rz: number }[] = [
  { p: [9.6, 0, 3.4], h: 8.2, rz: 0.05 },
  { p: [12.8, 0, -4.2], h: 9.6, rz: -0.04 },
  { p: [7.1, 0, -8.9], h: 7.4, rz: 0.07 },
  { p: [-9.8, 0, -5.6], h: 10, rz: -0.06 },
  { p: [-13.4, 0, 2.1], h: 8.8, rz: 0.03 },
  { p: [-7.5, 0, 9.3], h: 7.8, rz: -0.08 },
  { p: [2.6, 0, -13.8], h: 9.2, rz: 0.02 },
  { p: [-3.4, 0, -15.9], h: 8.4, rz: -0.03 },
  { p: [15.7, 0, 6.3], h: 9.8, rz: 0.06 },
  { p: [-15.2, 0, -9.4], h: 7.2, rz: -0.05 },
];

export function ForestScene({ dimmed = false }: AmbientSceneProps) {
  const lk = dimK(dimmed);
  const fogArgs = useMemo<[string, number, number]>(
    () => ["#0a1410", dimmed ? 16 : 10, dimmed ? 64 : 38],
    [dimmed],
  );
  const trunks = useMemo(
    () => TRUNKS.map((t) => ({ ...t, p: pushOut(t.p, dimmed) })),
    [dimmed],
  );

  return (
    <>
      <fog attach="fog" args={fogArgs} />
      <color attach="background" args={["#0a1410"]} />
      <directionalLight color="#b9d2e8" intensity={0.35 * lk} position={[6, 10, 2]} />
      <ambientLight color="#122016" intensity={0.18 * lk} />

      {/* Fireflies and slow-falling leaf motes. */}
      <ParticleField count={450} color="#cdee7a" size={0.3} area={[30, 5, 26]} speed={0.18} twinkle additive opacity={0.85} />
      <ParticleField count={220} color="#9fb9a8" size={0.16} area={[28, 9, 24]} speed={0.5} opacity={0.4} />

      {/* Tapered trunks ringing the clearing. */}
      {trunks.map((t, i) => (
        <mesh
          key={i}
          geometry={TRUNK}
          material={SILHOUETTE}
          position={[t.p[0], t.h / 2, t.p[2]]}
          scale={[1, t.h, 1]}
          rotation-z={t.rz}
        />
      ))}

      {/* Moonlight god-rays slanting in from the upper-left. */}
      {!dimmed && (
        <>
          <mesh geometry={PLANE} material={GODRAY_MAT} position={[-5, 5, -4]} rotation={[0.15, 0.5, -0.6]} scale={[3, 12, 1]} />
          <mesh geometry={PLANE} material={GODRAY_MAT} position={[-1.5, 5.5, -7]} rotation={[0.1, 0.3, -0.5]} scale={[3, 12, 1]} />
        </>
      )}

      <Ground />
    </>
  );
}

/* ------------------------------------------------------------------ */
/* DungeonScene                                                        */
/* ------------------------------------------------------------------ */

const PILLARS: Vec3Tuple[] = [
  [-6, 2.5, -2],
  [-6, 2.5, -6],
  [-6, 2.5, -10],
  [6, 2.5, -2],
  [6, 2.5, -6],
  [6, 2.5, -10],
];

export function DungeonScene({ dimmed = false }: AmbientSceneProps) {
  const lk = dimK(dimmed);
  const fogArgs = useMemo<[string, number, number]>(
    () => ["#0b0d14", dimmed ? 16 : 6, dimmed ? 64 : 30],
    [dimmed],
  );
  const pillars = useMemo(() => PILLARS.map((p) => pushOut(p, dimmed)), [dimmed]);
  const archZ = dimmed ? -13 : -9;

  return (
    <>
      <fog attach="fog" args={fogArgs} />
      <color attach="background" args={["#0b0d14"]} />
      <ambientLight color="#0e1018" intensity={0.14 * lk} />

      {/* Wall torches. */}
      <FlickerLight color="#ff7a2a" intensity={10 * lk} distance={14} position={[-8, 2.2, -2]} />
      <FlickerLight color="#ff7a2a" intensity={10 * lk} distance={14} position={[8, 2.2, -2]} />

      {/* Stale dust, barely moving. */}
      <ParticleField count={300} color="#8a8fa8" size={0.15} area={[26, 7, 22]} speed={0.08} opacity={0.45} />

      {/* Stone arch (moved as one unit so it never splits apart when pushed). */}
      <group position-z={archZ}>
        <mesh geometry={BOX} material={SILHOUETTE} position={[-2.2, 2, 0]} scale={[1, 4, 1]} />
        <mesh geometry={BOX} material={SILHOUETTE} position={[2.2, 2, 0]} scale={[1, 4, 1]} />
        <mesh geometry={BOX} material={SILHOUETTE} position={[0, 4.5, 0]} scale={[5.6, 1, 1]} />
      </group>

      {/* Two receding pillar rows. */}
      {pillars.map((p, i) => (
        <mesh key={i} geometry={PILLAR} material={SILHOUETTE} position={p} />
      ))}

      <Ground />
    </>
  );
}

/* ------------------------------------------------------------------ */
/* CaveScene                                                           */
/* ------------------------------------------------------------------ */

type CrystalSpec = { o: Vec3Tuple; s: number; r: Vec3Tuple };

const CRYSTAL_CLUSTERS: { base: Vec3Tuple; color: string; phase: number; crystals: CrystalSpec[] }[] = [
  {
    base: [-7, 0, -5],
    color: "#8b5cf6",
    phase: 0,
    crystals: [
      { o: [0, 0.6, 0], s: 0.7, r: [0.2, 0.4, 0.1] },
      { o: [0.6, 0.35, 0.25], s: 0.45, r: [-0.3, 0.1, 0.35] },
      { o: [-0.45, 0.3, -0.3], s: 0.35, r: [0.25, -0.5, -0.2] },
    ],
  },
  {
    base: [6, 0, -8],
    color: "#4cc9f0",
    phase: 1.7,
    crystals: [
      { o: [0, 0.5, 0], s: 0.6, r: [-0.15, 0.6, 0.2] },
      { o: [0.5, 0.3, -0.25], s: 0.4, r: [0.3, -0.2, -0.3] },
    ],
  },
  {
    base: [-4, 0, 6],
    color: "#8b5cf6",
    phase: 3.1,
    crystals: [
      { o: [0, 0.4, 0], s: 0.5, r: [0.1, 0.3, -0.25] },
      { o: [-0.4, 0.25, 0.3], s: 0.35, r: [-0.2, -0.4, 0.15] },
    ],
  },
  {
    base: [9, 0, 2],
    color: "#8b5cf6",
    phase: 4.6,
    crystals: [
      { o: [0, 0.7, 0], s: 0.7, r: [-0.25, 0.2, 0.3] },
      { o: [0.55, 0.4, 0.2], s: 0.5, r: [0.35, -0.3, -0.1] },
      { o: [-0.5, 0.3, -0.25], s: 0.4, r: [0.15, 0.5, 0.2] },
    ],
  },
];

const STALAGMITES: { p: Vec3Tuple; r: number; h: number }[] = [
  { p: [8.6, 0, -3.2], r: 0.8, h: 2.6 },
  { p: [-9.4, 0, -4.8], r: 1.0, h: 3.1 },
  { p: [11.8, 0, 4.6], r: 0.7, h: 2.2 },
  { p: [-12.6, 0, 5.4], r: 0.9, h: 2.8 },
  { p: [4.2, 0, 11.8], r: 0.6, h: 1.8 },
  { p: [-5.8, 0, -13.2], r: 0.85, h: 2.4 },
  { p: [14.2, 0, -7.4], r: 1.1, h: 3.4 },
];

const STALACTITES: { p: Vec3Tuple; r: number; h: number }[] = [
  { p: [6.8, 6, -9.5], r: 0.5, h: 2.2 },
  { p: [-8.2, 6.2, -7.8], r: 0.6, h: 2.6 },
  { p: [10.4, 5.8, 6.2], r: 0.45, h: 1.8 },
  { p: [-11.6, 6.4, 3.8], r: 0.55, h: 2.0 },
];

function CrystalCluster({
  position,
  color,
  phase,
  lightIntensity,
  crystals,
}: {
  position: Vec3Tuple;
  color: string;
  phase: number;
  lightIntensity: number;
  crystals: CrystalSpec[];
}) {
  const material = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: "#0e0a18",
        emissive: color,
        emissiveIntensity: 1,
        roughness: 0.35,
        metalness: 0.1,
      }),
    [color],
  );
  useEffect(() => () => material.dispose(), [material]);

  useFrame((state) => {
    // Pulse 0.7 .. 1.3
    material.emissiveIntensity = 1 + 0.3 * Math.sin(state.clock.elapsedTime * 1.7 + phase);
  });

  return (
    <group position={position}>
      {crystals.map((c, i) => (
        <mesh key={i} geometry={OCTA} material={material} position={c.o} scale={c.s} rotation={c.r} />
      ))}
      <pointLight color={color} intensity={lightIntensity} distance={7} decay={2} position={[0, 0.8, 0]} />
    </group>
  );
}

export function CaveScene({ dimmed = false }: AmbientSceneProps) {
  const lk = dimK(dimmed);
  const fogArgs = useMemo<[string, number, number]>(
    () => ["#06090c", dimmed ? 16 : 5, dimmed ? 64 : 26],
    [dimmed],
  );
  const clusters = useMemo(
    () => CRYSTAL_CLUSTERS.map((c) => ({ ...c, base: pushOut(c.base, dimmed) })),
    [dimmed],
  );
  const stalagmites = useMemo(
    () => STALAGMITES.map((s) => ({ ...s, p: pushOut(s.p, dimmed) })),
    [dimmed],
  );
  const stalactites = useMemo(
    () => STALACTITES.map((s) => ({ ...s, p: pushOut(s.p, dimmed) })),
    [dimmed],
  );

  return (
    <>
      <fog attach="fog" args={fogArgs} />
      <color attach="background" args={["#06090c"]} />
      <ambientLight color="#0a1018" intensity={0.12 * lk} />

      {/* Glowing crystal clusters with matching faint lights. */}
      {clusters.map((c, i) => (
        <CrystalCluster
          key={i}
          position={c.base}
          color={c.color}
          phase={c.phase}
          lightIntensity={3 * lk}
          crystals={c.crystals}
        />
      ))}

      {/* Drifting spores. */}
      <ParticleField count={250} color="#7aa9c9" size={0.2} area={[26, 8, 22]} speed={0.25} rise additive opacity={0.5} />

      {/* Stalagmites and hanging stalactites. */}
      {stalagmites.map((s, i) => (
        <mesh
          key={`up-${i}`}
          geometry={CONE}
          material={SILHOUETTE}
          position={[s.p[0], s.h / 2, s.p[2]]}
          scale={[s.r, s.h, s.r]}
        />
      ))}
      {stalactites.map((s, i) => (
        <mesh
          key={`down-${i}`}
          geometry={CONE}
          material={SILHOUETTE}
          position={[s.p[0], s.p[1] - s.h / 2, s.p[2]]}
          rotation-x={Math.PI}
          scale={[s.r, s.h, s.r]}
        />
      ))}

      <Ground />
    </>
  );
}

/* ------------------------------------------------------------------ */
/* TownScene                                                           */
/* ------------------------------------------------------------------ */

const HOUSES: { p: Vec3Tuple; w: number; h: number; d: number; ry: number; windows: [number, number][] }[] = [
  { p: [-13.5, 0, -7.5], w: 3.4, h: 2.6, d: 2.8, ry: 0.5, windows: [[-0.7, 1.2], [0.6, 1.0]] },
  { p: [-7.8, 0, -12.4], w: 2.6, h: 2.1, d: 2.2, ry: 0.25, windows: [[0.4, 1.1]] },
  { p: [-1.5, 0, -14.6], w: 4.0, h: 3.0, d: 3.0, ry: 0.05, windows: [[-0.9, 1.4]] },
  { p: [4.8, 0, -13.8], w: 3.0, h: 2.3, d: 2.4, ry: -0.2, windows: [] },
  { p: [10.6, 0, -11.2], w: 2.4, h: 2.0, d: 2.0, ry: -0.45, windows: [] },
  { p: [15.0, 0, -6.8], w: 3.6, h: 2.7, d: 2.9, ry: -0.7, windows: [] },
  { p: [-16.4, 0, -2.2], w: 2.8, h: 2.2, d: 2.3, ry: 0.9, windows: [] },
];

export function TownScene({ dimmed = false }: AmbientSceneProps) {
  const lk = dimK(dimmed);
  const fogArgs = useMemo<[string, number, number]>(
    () => ["#241726", dimmed ? 16 : 14, dimmed ? 64 : 50],
    [dimmed],
  );

  const windowMaterial = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: "#000000",
        emissive: "#ffb066",
        emissiveIntensity: 0.8,
      }),
    [],
  );
  useEffect(() => () => windowMaterial.dispose(), [windowMaterial]);

  useFrame((state) => {
    // Window glow flickers between ~0.6 and ~1.0.
    const t = state.clock.elapsedTime;
    windowMaterial.emissiveIntensity = 0.8 + 0.13 * Math.sin(t * 8.3) + 0.07 * Math.sin(t * 15.1);
  });

  return (
    <>
      <fog attach="fog" args={fogArgs} />
      <color attach="background" args={["#1a1430"]} />

      {/* Dusk sky dome. */}
      <mesh geometry={SKY_SPHERE} material={SKY_MAT} />

      <directionalLight color="#e8a06a" intensity={0.5 * lk} position={[-8, 6, -4]} />
      <ambientLight color="#39304a" intensity={0.2 * lk} />

      {/* Chimney smoke drifting up over the rooftops. */}
      <ParticleField count={200} color="#9a8f9a" size={0.5} area={[24, 8, 20]} speed={0.3} rise opacity={0.35} />

      {/* Rooftop silhouettes along an arc behind the stage (radius 12-18). */}
      {HOUSES.map((house, i) => (
        <group key={i} position={house.p} rotation-y={house.ry}>
          <mesh geometry={BOX} material={SILHOUETTE} position={[0, house.h / 2, 0]} scale={[house.w, house.h, house.d]} />
          {/* Gable: a diamond-section box sunk into the roofline. */}
          <mesh
            geometry={BOX}
            material={SILHOUETTE}
            position={[0, house.h, 0]}
            rotation-z={Math.PI / 4}
            scale={[house.w * 0.72, house.w * 0.72, house.d * 1.02]}
          />
          {house.windows.map(([wx, wy], j) => (
            <mesh
              key={j}
              geometry={PLANE}
              material={windowMaterial}
              position={[wx, wy, house.d / 2 + 0.02]}
              scale={[0.3, 0.4, 1]}
            />
          ))}
        </group>
      ))}

      <Ground />
    </>
  );
}
