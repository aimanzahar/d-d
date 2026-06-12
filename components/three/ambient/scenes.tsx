"use client";

// The five ambient location backdrops. Each scene owns its fog, lighting,
// particles and silhouette props. `dimmed` (combat mode) cuts light intensity
// ~38%, tightens fog, and pushes silhouettes out past radius ~13 so the battle
// map (18x14 max, centered at origin) is never crowded.

import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import {
  FlickerLight,
  GlowQuad,
  GradientDome,
  Ground,
  ParticleField,
  SILHOUETTE,
  Silhouettes,
  type SilhouetteTransform,
} from "./kit";

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
const MOON_GEO = new THREE.SphereGeometry(1, 16, 12);
const TAVERN_FLOOR_GEO = new THREE.CircleGeometry(16, 40);
const POOL_GEO = new THREE.CircleGeometry(3.5, 36);

const HEARTH_MAT = new THREE.MeshBasicMaterial({ color: "#ff8c3b", side: THREE.DoubleSide });

// Lit (standard) materials so tavern structure picks up warm firelight instead
// of rendering as flat black slabs from the elevated orbit camera.
const WOOD_MAT = new THREE.MeshStandardMaterial({ color: "#4a3520", roughness: 0.95, metalness: 0 });
const STONE_MAT = new THREE.MeshStandardMaterial({ color: "#2e2118", roughness: 1, metalness: 0 });
const TAVERN_WINDOW_MAT = new THREE.MeshStandardMaterial({
  color: "#000000",
  emissive: "#ffb066",
  emissiveIntensity: 1.2,
});

// Tavern floor: a warm wood disc layered just above the generic Ground.
const TAVERN_FLOOR_MAT = new THREE.MeshStandardMaterial({ color: "#2a1a0e", roughness: 0.9, metalness: 0 });

// Furniture wood: silhouette-dark but lit, so firelight still grazes the edges.
const DARK_WOOD_MAT = new THREE.MeshStandardMaterial({ color: "#1a100a", roughness: 0.95, metalness: 0 });

// Shared lantern head (tavern hanging lanterns, town lamp posts).
const LANTERN_MAT = new THREE.MeshStandardMaterial({
  color: "#000000",
  emissive: "#ffb066",
  emissiveIntensity: 1.5,
});

// Bottle flecks on the tavern back shelf — tiny emissive glints.
const BOTTLE_TEAL = new THREE.MeshStandardMaterial({ color: "#02110f", emissive: "#2dd4bf", emissiveIntensity: 1.2 });
const BOTTLE_AMBER = new THREE.MeshStandardMaterial({ color: "#140c02", emissive: "#fbbf24", emissiveIntensity: 1.2 });
const BOTTLE_VIOLET = new THREE.MeshStandardMaterial({ color: "#0d0714", emissive: "#a78bfa", emissiveIntensity: 1.2 });

// Forest undergrowth: near-black green so moonlight barely models the clumps.
const FERN_MAT = new THREE.MeshStandardMaterial({ color: "#0d2014", roughness: 1, metalness: 0 });

// Brazier embers (dungeon).
const EMBER_MAT = new THREE.MeshStandardMaterial({
  color: "#1a0a04",
  emissive: "#ff7a2a",
  emissiveIntensity: 1.6,
});

// Still cave pool: low roughness + metalness so crystal light skates across it.
const POOL_MAT = new THREE.MeshStandardMaterial({ color: "#0a1420", roughness: 0.15, metalness: 0.6 });

// Moon disc: unlit and fog-free so it punches through the haze at distance.
const MOON_MAT = new THREE.MeshBasicMaterial({ color: "#e8f1ff", fog: false });

const GODRAY_MAT = new THREE.MeshBasicMaterial({
  color: "#b9d2e8",
  transparent: true,
  opacity: 0.05,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  side: THREE.DoubleSide,
});

/* ------------------------------------------------------------------ */
/* TavernScene                                                         */
/* ------------------------------------------------------------------ */

const POST_X = [-9, -3, 3, 9];
const BARREL_OFFSETS: Vec3Tuple[] = [
  [0, 0.55, 0],
  [1.05, 0.55, 0.35],
  [0.35, 0.55, -1.0],
];

// Table+stool clusters around the common room (pushed out during combat).
const TABLE_SPOTS: Vec3Tuple[] = [
  [-4, 0, 5.5],
  [5, 0, 7],
  [-8.5, 0, 2],
];
const STOOL_OFFSETS: [number, number][] = [
  [1.25, 0.15],
  [-0.75, 1.05],
  [-0.6, -1.1],
];

// Hanging lanterns over the room (hidden in combat — they sit inside the map).
const LANTERN_POSITIONS: Vec3Tuple[] = [
  [-5, 3.1, -1.6],
  [0, 3.1, 0.6],
  [5, 3.1, -2],
];

// Back-shelf bottles: offsets within the bar group, paired with glint materials.
const BAR_BOTTLES: { o: Vec3Tuple; s: Vec3Tuple; m: THREE.MeshStandardMaterial }[] = [
  { o: [1.2, 1.63, -1.9], s: [0.08, 0.18, 0.08], m: BOTTLE_TEAL },
  { o: [1.2, 1.65, -0.9], s: [0.07, 0.22, 0.07], m: BOTTLE_AMBER },
  { o: [1.2, 1.62, 0.1], s: [0.1, 0.16, 0.1], m: BOTTLE_VIOLET },
  { o: [1.2, 1.64, 1.0], s: [0.08, 0.2, 0.08], m: BOTTLE_AMBER },
  { o: [1.2, 1.63, 1.9], s: [0.07, 0.17, 0.07], m: BOTTLE_TEAL },
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
  const barPos = useMemo(() => pushOut([9, 0, -1], dimmed), [dimmed]);

  // Instanced furniture: table tops/posts share one cylinder batch, stools one box batch.
  const furniture = useMemo(() => {
    const tables: SilhouetteTransform[] = [];
    const stools: SilhouetteTransform[] = [];
    TABLE_SPOTS.forEach((spot, i) => {
      const p = pushOut(spot, dimmed);
      tables.push({ p: [p[0], 0.78, p[2]], s: [0.9, 0.12, 0.9] });
      tables.push({ p: [p[0], 0.36, p[2]], s: [0.12, 0.72, 0.12] });
      STOOL_OFFSETS.forEach(([ox, oz], j) => {
        stools.push({ p: [p[0] + ox, 0.175, p[2] + oz], s: 0.35, ry: (i * 3 + j) * 0.9 });
      });
    });
    return { tables, stools };
  }, [dimmed]);

  return (
    <>
      <fog attach="fog" args={fogArgs} />
      <color attach="background" args={["#1a120b"]} />
      <GradientDome top="#1d1208" horizon="#3a2415" />
      <ambientLight color="#2a1c10" intensity={0.25 * lk} />

      {/* Hearth: stone fireplace surround framing a glowing ember plane + flickering firelight. */}
      <group position={hearthPos}>
        <group rotation-y={Math.PI * 0.25}>
          <mesh geometry={PLANE} material={HEARTH_MAT} position={[0, 0.8, 0]} scale={[1.6, 1.1, 1]} />
          <mesh geometry={BOX} material={STONE_MAT} position={[-1.05, 0.75, -0.2]} scale={[0.5, 1.5, 0.8]} />
          <mesh geometry={BOX} material={STONE_MAT} position={[1.05, 0.75, -0.2]} scale={[0.5, 1.5, 0.8]} />
          <mesh geometry={BOX} material={STONE_MAT} position={[0, 1.62, -0.2]} scale={[2.6, 0.45, 0.8]} />
          <mesh geometry={BOX} material={STONE_MAT} position={[0, 2.4, -0.25]} scale={[1.4, 1.2, 0.6]} />
        </group>
        {/* Ember sparks drifting up out of the firebox. */}
        <group position={[0, 0.5, 0]}>
          <ParticleField count={70} color="#ff9a4d" size={0.12} area={[3, 4, 3]} speed={0.6} rise additive opacity={0.8} />
        </group>
        <FlickerLight color="#ff8c3b" intensity={18 * lk} distance={18} position={[0.6, 1.2, 0.4]} />
      </group>

      {/* Candles. */}
      <FlickerLight color="#ffc066" intensity={2.5 * lk} distance={8} position={[4, 0.9, 2]} />
      <FlickerLight color="#ffc066" intensity={2.5 * lk} distance={8} position={[7, 0.9, -5]} />

      {/* Warm dust motes hanging in the firelight. */}
      <ParticleField count={350} color="#d9b98a" size={0.18} area={[26, 7, 22]} speed={0.25} twinkle opacity={0.55} />

      {/* Back wall: timber posts, beam and warm window glow softened by the fog —
          hidden in combat so the top-down camera stays clear. */}
      {!dimmed && (
        <>
          {POST_X.map((x) => (
            <mesh key={x} geometry={BOX} material={WOOD_MAT} position={[x, 2.1, -10]} scale={[0.45, 4.2, 0.45]} />
          ))}
          <mesh geometry={BOX} material={WOOD_MAT} position={[0, 4.3, -10]} scale={[18.9, 0.4, 0.45]} />
          <mesh geometry={PLANE} material={TAVERN_WINDOW_MAT} position={[-6, 1.7, -9.95]} scale={[0.8, 0.95, 1]} />
          <mesh geometry={PLANE} material={TAVERN_WINDOW_MAT} position={[5.2, 1.5, -9.95]} scale={[0.8, 0.95, 1]} />
        </>
      )}

      {/* Hanging lanterns over the common room: emissive heads + sprite halos,
          one shared flicker light on the middle lantern (light budget). */}
      {!dimmed && (
        <>
          {LANTERN_POSITIONS.map((p, i) => (
            <group key={i} position={p}>
              <mesh geometry={BOX} material={LANTERN_MAT} scale={[0.22, 0.3, 0.22]} />
              <GlowQuad color="#ffb066" size={1.5} position={[0, 0, 0]} opacity={0.55} />
            </group>
          ))}
          <FlickerLight color="#ffb066" intensity={4} distance={10} position={LANTERN_POSITIONS[1]} />
        </>
      )}

      {/* Bar counter along the east wall: counter run, back panel, bottle shelf. */}
      <group position={barPos}>
        <mesh geometry={BOX} material={WOOD_MAT} position={[0, 0.45, 0]} scale={[1.0, 0.9, 6]} />
        <mesh geometry={BOX} material={DARK_WOOD_MAT} position={[0, 0.93, 0]} scale={[1.2, 0.06, 6.2]} />
        <mesh geometry={BOX} material={WOOD_MAT} position={[1.35, 1.0, 0]} scale={[0.25, 2.0, 6]} />
        <mesh geometry={BOX} material={DARK_WOOD_MAT} position={[1.2, 1.5, 0]} scale={[0.45, 0.07, 5.4]} />
        {BAR_BOTTLES.map((b, i) => (
          <mesh key={i} geometry={BOX} material={b.m} position={b.o} scale={b.s} />
        ))}
      </group>

      {/* Tables and stools scattered through the room. */}
      <Silhouettes geometry={CYL} material={DARK_WOOD_MAT} transforms={furniture.tables} />
      <Silhouettes geometry={BOX} material={DARK_WOOD_MAT} transforms={furniture.stools} />

      {/* Barrel cluster. */}
      <group position={barrelsPos}>
        {BARREL_OFFSETS.map((o, i) => (
          <mesh key={i} geometry={CYL} material={SILHOUETTE} position={o} scale={[0.55, 1.1, 0.55]} />
        ))}
      </group>

      {/* Table edge at the side of the room. */}
      <mesh geometry={BOX} material={SILHOUETTE} position={tablePos} scale={[2.4, 0.7, 1.1]} />

      {/* Wood floor disc layered over the generic ground. */}
      <mesh geometry={TAVERN_FLOOR_GEO} material={TAVERN_FLOOR_MAT} rotation-x={-Math.PI / 2} position-y={-0.01} />
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

// Distant second ring of thinner trunks (radius 18-24, always beyond the map).
const OUTER_TRUNKS: SilhouetteTransform[] = [
  { p: [18.7, 5.25, 3.3], s: [0.7, 10.5, 0.7], rz: 0.04 },
  { p: [17.3, 6, 13.5], s: [0.75, 12, 0.75], rz: -0.03 },
  { p: [7.8, 4.75, 18.4], s: [0.62, 9.5, 0.62], rz: 0.06 },
  { p: [-2.0, 5.5, 22.9], s: [0.7, 11, 0.7], rz: -0.05 },
  { p: [-11.2, 5, 16.0], s: [0.66, 10, 0.66], rz: 0.03 },
  { p: [-19.9, 6.25, 10.6], s: [0.78, 12.5, 0.78], rz: -0.06 },
  { p: [-20, 5.25, 0], s: [0.7, 10.5, 0.7], rz: 0.05 },
  { p: [-20.9, 5.75, -10.7], s: [0.74, 11.5, 0.74], rz: -0.04 },
  { p: [-11.4, 4.9, -15.2], s: [0.6, 9.8, 0.6], rz: 0.07 },
  { p: [-3.7, 6, -21.2], s: [0.76, 12, 0.76], rz: -0.02 },
  { p: [6.6, 5.5, -23.1], s: [0.68, 11, 0.68], rz: 0.04 },
  { p: [13.4, 5.1, -15.5], s: [0.64, 10.2, 0.64], rz: -0.07 },
  { p: [21.0, 6.4, -9.4], s: [0.8, 12.8, 0.8], rz: 0.03 },
  { p: [18.3, 4.7, -2.6], s: [0.6, 9.4, 0.6], rz: -0.05 },
];

// Fern clumps hugging the clearing floor (radius 8-14; pushed out in combat).
const FERNS: Vec3Tuple[] = [
  [7.6, 0, 4.4],
  [-8.8, 0, 3.6],
  [11.2, 0, -1.8],
  [-11.8, 0, -2.4],
  [6.8, 0, 10.4],
  [-6.2, 0, 11.6],
  [13.4, 0, 4.2],
  [-13.0, 0, 5.2],
  [9.8, 0, -11.0],
  [-8.8, 0, -10.2],
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
  const ferns = useMemo<SilhouetteTransform[]>(
    () =>
      FERNS.map((f, i) => {
        const p = pushOut(f, dimmed);
        const k = 0.8 + (i % 4) * 0.08;
        return { p: [p[0], 0.25 * k, p[2]], s: [0.9 * k, 0.5 * k, 0.9 * k], ry: i * 1.7 };
      }),
    [dimmed],
  );

  return (
    <>
      <fog attach="fog" args={fogArgs} />
      <color attach="background" args={["#0a1410"]} />
      <GradientDome top="#050d12" horizon="#14302a" />
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

      {/* Distant second trunk ring and undergrowth, both instanced. */}
      <Silhouettes geometry={TRUNK} material={SILHOUETTE} transforms={OUTER_TRUNKS} />
      <Silhouettes geometry={CONE} material={FERN_MAT} transforms={ferns} />

      {/* Moon low over the treeline: sprite halo + tiny solid disc. */}
      <GlowQuad color="#cfe6ff" size={6} position={[-18, 16, -20]} opacity={0.85} />
      <mesh geometry={MOON_GEO} material={MOON_MAT} position={[-18, 16, -20]} scale={0.85} />

      {/* Moonlight god-rays slanting in from the upper-left. */}
      {!dimmed && (
        <>
          <mesh geometry={PLANE} material={GODRAY_MAT} position={[-5, 5, -4]} rotation={[0.15, 0.5, -0.6]} scale={[3, 12, 1]} />
          <mesh geometry={PLANE} material={GODRAY_MAT} position={[-1.5, 5.5, -7]} rotation={[0.1, 0.3, -0.5]} scale={[3, 12, 1]} />
          <mesh geometry={PLANE} material={GODRAY_MAT} position={[-8.5, 4.5, -1]} rotation={[0.2, 0.7, -0.7]} scale={[2.4, 11, 1]} />
          <mesh geometry={PLANE} material={GODRAY_MAT} position={[2.5, 6, -9]} rotation={[0.05, 0.15, -0.45]} scale={[3.5, 13, 1]} />
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

// Second pillar row receding past the arch (radius > 13; never pushed).
const FAR_PILLARS: SilhouetteTransform[] = [
  { p: [-5.6, 2.2, -14], s: 0.88 },
  { p: [5.6, 2.2, -14], s: 0.88 },
  { p: [-5.2, 1.95, -18], s: 0.78 },
  { p: [5.2, 1.95, -18], s: 0.78 },
];

// Rubble scattered around the hall floor (radius 7-13; pushed out in combat).
const RUBBLE: { p: Vec3Tuple; s: number; ry: number }[] = [
  { p: [7.4, 0, 2.8], s: 0.55, ry: 0.7 },
  { p: [-8.2, 0, 3.4], s: 0.4, ry: 2.1 },
  { p: [9.6, 0, -4.6], s: 0.65, ry: 3.9 },
  { p: [-10.4, 0, -5.8], s: 0.5, ry: 1.3 },
  { p: [6.2, 0, -8.4], s: 0.35, ry: 5.1 },
  { p: [-7.0, 0, -9.6], s: 0.6, ry: 2.8 },
  { p: [11.8, 0, 5.4], s: 0.45, ry: 0.3 },
  { p: [-12.4, 0, 6.0], s: 0.7, ry: 4.4 },
];

const BRAZIERS: Vec3Tuple[] = [
  [-3, 0, -12],
  [3, 0, -12],
];

export function DungeonScene({ dimmed = false }: AmbientSceneProps) {
  const lk = dimK(dimmed);
  const fogArgs = useMemo<[string, number, number]>(
    () => ["#0b0d14", dimmed ? 16 : 6, dimmed ? 64 : 30],
    [dimmed],
  );
  const pillars = useMemo(() => PILLARS.map((p) => pushOut(p, dimmed)), [dimmed]);
  const archZ = dimmed ? -13 : -9;
  const rubble = useMemo<SilhouetteTransform[]>(
    () =>
      RUBBLE.map((r) => {
        const p = pushOut(r.p, dimmed);
        return { p: [p[0], r.s / 2, p[2]], s: r.s, ry: r.ry };
      }),
    [dimmed],
  );
  const braziers = useMemo(() => BRAZIERS.map((b) => pushOut(b, dimmed)), [dimmed]);
  // One shared flicker light sits midway between the two brazier bowls.
  const brazierLightPos = useMemo<Vec3Tuple>(
    () => [(braziers[0][0] + braziers[1][0]) / 2, 1.4, (braziers[0][2] + braziers[1][2]) / 2],
    [braziers],
  );

  return (
    <>
      <fog attach="fog" args={fogArgs} />
      <color attach="background" args={["#0b0d14"]} />
      <GradientDome top="#05070c" horizon="#0d1410" />
      <ambientLight color="#0e1018" intensity={0.14 * lk} />

      {/* Wall torches. */}
      <FlickerLight color="#ff7a2a" intensity={10 * lk} distance={14} position={[-8, 2.2, -2]} />
      <FlickerLight color="#ff7a2a" intensity={10 * lk} distance={14} position={[8, 2.2, -2]} />

      {/* Stale dust, barely moving. */}
      <ParticleField count={300} color="#8a8fa8" size={0.15} area={[26, 7, 22]} speed={0.08} opacity={0.45} />

      {/* Thin dust columns sifting down beneath each torch. */}
      {!dimmed && (
        <>
          <group position={[-8, 0, -2]}>
            <ParticleField count={40} color="#8a8fa8" size={0.1} area={[1.5, 4, 1.5]} speed={0.05} opacity={0.25} />
          </group>
          <group position={[8, 0, -2]}>
            <ParticleField count={36} color="#8a8fa8" size={0.1} area={[1.5, 4, 1.5]} speed={0.05} opacity={0.25} />
          </group>
        </>
      )}

      {/* Stone arch (moved as one unit so it never splits apart when pushed). */}
      <group position-z={archZ}>
        <mesh geometry={BOX} material={SILHOUETTE} position={[-2.2, 2, 0]} scale={[1, 4, 1]} />
        <mesh geometry={BOX} material={SILHOUETTE} position={[2.2, 2, 0]} scale={[1, 4, 1]} />
        <mesh geometry={BOX} material={SILHOUETTE} position={[0, 4.5, 0]} scale={[5.6, 1, 1]} />
      </group>

      {/* Braziers glowing beyond the arch: bowl on a stem, ember core, sprite
          halo — one shared flicker light between them (light budget). */}
      {braziers.map((p, i) => (
        <group key={i} position={p}>
          <mesh geometry={CYL} material={SILHOUETTE} position={[0, 0.3, 0]} scale={[0.14, 0.6, 0.14]} />
          <mesh geometry={CYL} material={SILHOUETTE} position={[0, 0.66, 0]} scale={[0.5, 0.22, 0.5]} />
          <mesh geometry={BOX} material={EMBER_MAT} position={[0, 0.8, 0]} scale={0.32} />
          <GlowQuad color="#ff7a2a" size={1.8} position={[0, 0.85, 0]} opacity={0.5} />
        </group>
      ))}
      <FlickerLight color="#ff7a2a" intensity={6 * lk} distance={12} position={brazierLightPos} />

      {/* Two receding pillar rows. */}
      {pillars.map((p, i) => (
        <mesh key={i} geometry={PILLAR} material={SILHOUETTE} position={p} />
      ))}

      {/* Farther pillar row and rubble, both instanced. */}
      <Silhouettes geometry={PILLAR} material={SILHOUETTE} transforms={FAR_PILLARS} />
      <Silhouettes geometry={BOX} material={STONE_MAT} transforms={rubble} />

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
  {
    base: [0, 0, -11],
    color: "#4cc9f0",
    phase: 5.8,
    crystals: [
      { o: [0, 0.65, 0], s: 0.65, r: [0.15, -0.3, 0.25] },
      { o: [0.55, 0.35, -0.2], s: 0.45, r: [-0.25, 0.4, -0.15] },
      { o: [-0.5, 0.28, 0.3], s: 0.38, r: [0.3, 0.2, 0.35] },
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

// Denser ceiling growth (instanced; clear of the camera-to-stage corridor).
const STALACTITES_FAR: { p: Vec3Tuple; r: number; h: number }[] = [
  { p: [4.8, 6.4, -7.2], r: 0.35, h: 1.6 },
  { p: [-5.4, 6.0, -9.8], r: 0.5, h: 2.4 },
  { p: [9.2, 5.6, -3.4], r: 0.4, h: 1.9 },
  { p: [-10.8, 6.3, -1.6], r: 0.6, h: 2.8 },
  { p: [13.6, 6.1, -6.8], r: 0.45, h: 2.2 },
  { p: [-14.2, 5.9, -4.4], r: 0.55, h: 2.5 },
  { p: [7.6, 6.5, 8.8], r: 0.4, h: 1.7 },
  { p: [-8.4, 6.2, 7.6], r: 0.5, h: 2.1 },
  { p: [12.4, 5.8, 9.4], r: 0.35, h: 1.5 },
  { p: [-15.6, 6.4, 6.6], r: 0.65, h: 3.0 },
];

function CrystalCluster({
  position,
  color,
  phase,
  lightIntensity,
  crystals,
  scale = 1,
}: {
  position: Vec3Tuple;
  color: string;
  phase: number;
  lightIntensity: number;
  crystals: CrystalSpec[];
  scale?: number;
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

  // Mutate per-frame through a ref so render-created values stay untouched.
  const materialRef = useRef<THREE.MeshStandardMaterial | null>(null);
  useEffect(() => {
    materialRef.current = material;
  }, [material]);

  useFrame((state) => {
    const mat = materialRef.current;
    if (!mat) return;
    // Pulse 0.28 .. 0.62 — kept WELL below 1 so the point lights still shade
    // the facets; full emissive turns every crystal into a flat color blob.
    mat.emissiveIntensity = 0.45 + 0.17 * Math.sin(state.clock.elapsedTime * 1.7 + phase);
  });

  return (
    <group position={position} scale={scale}>
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
  const farStalactites = useMemo<SilhouetteTransform[]>(
    () =>
      STALACTITES_FAR.map((s) => {
        const p = pushOut(s.p, dimmed);
        return { p: [p[0], p[1] - s.h / 2, p[2]], s: [s.r, s.h, s.r], rz: Math.PI };
      }),
    [dimmed],
  );
  const poolPos = useMemo(() => pushOut([-3, 0.005, 8], dimmed), [dimmed]);

  return (
    <>
      <fog attach="fog" args={fogArgs} />
      <color attach="background" args={["#06090c"]} />
      <GradientDome top="#04030a" horizon="#120a24" />
      <ambientLight color="#0a1018" intensity={0.12 * lk} />

      {/* Glowing crystal clusters with matching faint lights. */}
      {clusters.map((c, i) => (
        <CrystalCluster
          key={i}
          position={c.base}
          color={c.color}
          phase={c.phase}
          lightIntensity={4.5 * lk}
          crystals={c.crystals}
          scale={1.15}
        />
      ))}

      {/* Still pool catching the crystal light. */}
      <mesh geometry={POOL_GEO} material={POOL_MAT} rotation-x={-Math.PI / 2} position={poolPos} />

      {/* Drifting spores. */}
      <ParticleField count={250} color="#7aa9c9" size={0.2} area={[26, 8, 22]} speed={0.25} rise additive opacity={0.5} />

      {/* Ground mist pooling over the cavern floor. */}
      <ParticleField count={60} color="#2a3a55" size={1.6} area={[26, 1.2, 22]} speed={0.06} opacity={0.18} />

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

      {/* Extra ceiling growth, instanced. */}
      <Silhouettes geometry={CONE} material={SILHOUETTE} transforms={farStalactites} />

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

// Farther rooftop arc (radius 22-26): smaller silhouette houses, instanced as
// one batch of bodies + one batch of 45° gable boxes.
const FAR_HOUSES: { p: Vec3Tuple; w: number; h: number; d: number; ry: number }[] = [
  { p: [-20.5, 0, -13.5], w: 2.8, h: 2.2, d: 2.4, ry: 0.6 },
  { p: [-11.5, 0, -20.8], w: 3.2, h: 2.6, d: 2.6, ry: 0.3 },
  { p: [-2.5, 0, -23.6], w: 2.4, h: 2.0, d: 2.0, ry: 0.1 },
  { p: [6.5, 0, -22.8], w: 3.0, h: 2.4, d: 2.5, ry: -0.25 },
  { p: [14.8, 0, -19.4], w: 2.6, h: 2.1, d: 2.2, ry: -0.5 },
  { p: [21.6, 0, -12.6], w: 3.4, h: 2.7, d: 2.8, ry: -0.85 },
];
const FAR_HOUSE_BODIES: SilhouetteTransform[] = FAR_HOUSES.map((h) => ({
  p: [h.p[0], h.h / 2, h.p[2]],
  s: [h.w, h.h, h.d],
  ry: h.ry,
}));
const FAR_HOUSE_GABLES: SilhouetteTransform[] = FAR_HOUSES.map((h) => ({
  p: [h.p[0], h.h, h.p[2]],
  s: [h.w * 0.72, h.w * 0.72, h.d * 1.02],
  ry: h.ry,
  rz: Math.PI / 4,
}));

const LAMP_POSTS: Vec3Tuple[] = [
  [-10, 0, 6],
  [10, 0, 5],
];

export function TownScene({ dimmed = false }: AmbientSceneProps) {
  const lk = dimK(dimmed);
  const fogArgs = useMemo<[string, number, number]>(
    () => ["#241726", dimmed ? 16 : 14, dimmed ? 64 : 50],
    [dimmed],
  );
  const lampPosts = useMemo(() => LAMP_POSTS.map((p) => pushOut(p, dimmed)), [dimmed]);

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

  // Mutate per-frame through a ref so render-created values stay untouched.
  const windowMaterialRef = useRef<THREE.MeshStandardMaterial | null>(null);
  useEffect(() => {
    windowMaterialRef.current = windowMaterial;
  }, [windowMaterial]);

  useFrame((state) => {
    const mat = windowMaterialRef.current;
    if (!mat) return;
    // Window glow flickers between ~0.6 and ~1.0.
    const t = state.clock.elapsedTime;
    mat.emissiveIntensity = 0.8 + 0.13 * Math.sin(t * 8.3) + 0.07 * Math.sin(t * 15.1);
  });

  return (
    <>
      <fog attach="fog" args={fogArgs} />
      <color attach="background" args={["#1a1430"]} />

      {/* Dusk sky dome. */}
      <GradientDome top="#1a1430" horizon="#4a2a30" />

      <directionalLight color="#e8a06a" intensity={0.5 * lk} position={[-8, 6, -4]} />
      <ambientLight color="#39304a" intensity={0.2 * lk} />

      {/* Stars pricking through the dusk, high above the fog. */}
      <group position-y={14}>
        <ParticleField count={220} color="#cfe0ff" size={0.08} area={[60, 18, 60]} speed={0.02} twinkle additive opacity={0.5} />
      </group>

      {/* Moon over the rooftops: sprite halo + small solid disc. */}
      <GlowQuad color="#cfe6ff" size={7} position={[14, 18, -24]} opacity={0.85} />
      <mesh geometry={MOON_GEO} material={MOON_MAT} position={[14, 18, -24]} scale={1.0} />

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

      {/* Second rooftop arc fading into the haze. */}
      <Silhouettes geometry={BOX} material={SILHOUETTE} transforms={FAR_HOUSE_BODIES} />
      <Silhouettes geometry={BOX} material={SILHOUETTE} transforms={FAR_HOUSE_GABLES} />

      {/* Lantern posts flanking the square: emissive heads + sprite halos,
          one shared flicker light between them (light budget). */}
      {lampPosts.map((p, i) => (
        <group key={i} position={p}>
          <mesh geometry={CYL} material={SILHOUETTE} position={[0, 1.3, 0]} scale={[0.06, 2.6, 0.06]} />
          <mesh geometry={BOX} material={LANTERN_MAT} position={[0, 2.72, 0]} scale={[0.24, 0.28, 0.24]} />
          <GlowQuad color="#ffc066" size={1.6} position={[0, 2.72, 0]} opacity={0.5} />
        </group>
      ))}
      {/* Shared light tracks the pushed-out posts so combat never has a
          sourceless glow hovering over the battle map. */}
      <FlickerLight
        color="#ffc066"
        intensity={3 * lk}
        distance={9}
        position={[
          (lampPosts[0][0] + lampPosts[1][0]) / 2,
          2.6,
          (lampPosts[0][2] + lampPosts[1][2]) / 2,
        ]}
      />

      <Ground />
    </>
  );
}
