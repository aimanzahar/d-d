"use client";

// Shared ambient-scene building blocks: GPU particle fields, flickering point
// lights, gradient sky domes, instanced silhouette props, sprite glows and
// ground primitives. Everything heavy (geometry, shaders, textures) is
// memoized or module-cached; useFrame bodies allocate nothing.

import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

/* ------------------------------------------------------------------ */
/* ParticleField                                                       */
/* ------------------------------------------------------------------ */

export type ParticleFieldProps = {
  count: number;
  color: string;
  size: number;
  /** Box extents [width, height, depth]; centered on origin in XZ, y in [0, height]. */
  area: [number, number, number];
  speed: number;
  /** true → particles climb and wrap within area height; false → gentle 3-axis drift with a slight downward settle. */
  rise?: boolean;
  twinkle?: boolean;
  opacity?: number;
  /** Additive blending for glowy particles (fireflies, spores). */
  additive?: boolean;
};

const PARTICLE_VERT = /* glsl */ `
  uniform float uTime;
  uniform float uSize;
  uniform float uSpeed;
  uniform vec3 uArea;
  uniform float uRise;
  attribute float aSeed;
  varying float vSeed;

  void main() {
    vSeed = aSeed;
    vec3 p = position;
    float h = max(uArea.y, 0.001);

    if (uRise > 0.5) {
      // Climb and wrap within the area height, with a lazy XZ sway.
      p.y = mod(position.y + uTime * uSpeed * (0.55 + 0.45 * aSeed), h);
      p.x += sin(aSeed * 12.9 + uTime * uSpeed * 0.8) * 0.5;
      p.z += cos(aSeed * 7.7 + uTime * uSpeed * 0.7) * 0.5;
    } else {
      // Gentle 3-axis drift plus a very slight wrapped downward settle.
      float fall = mod(uTime * uSpeed * 0.22 + aSeed * h, h);
      p.y = mod(position.y - fall + h, h);
      p.x += sin(aSeed * 6.2831 + uTime * uSpeed) * 0.45;
      p.y += sin(aSeed * 9.1 + uTime * uSpeed * 0.8) * 0.18;
      p.z += sin(aSeed * 3.3 + uTime * uSpeed * 1.2) * 0.45;
    }

    vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
    gl_PointSize = uSize * (300.0 / -mvPosition.z);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const PARTICLE_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uTwinkle;
  uniform float uTime;
  varying float vSeed;

  void main() {
    float d = length(gl_PointCoord - vec2(0.5));
    float alpha = smoothstep(0.5, 0.08, d) * uOpacity;
    alpha *= mix(1.0, 0.5 + 0.5 * sin(uTime * 3.0 + vSeed * 40.0), uTwinkle);
    if (alpha < 0.004) discard;
    gl_FragColor = vec4(uColor, alpha);
  }
`;

/** Tiny deterministic PRNG so particle layouts are stable across mounts. */
function makeRng(seed: number) {
  let s = (seed * 2654435761) >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export function ParticleField({
  count,
  color,
  size,
  area,
  speed,
  rise = false,
  twinkle = false,
  opacity = 1,
  additive = false,
}: ParticleFieldProps) {
  const [aw, ah, ad] = area;

  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const rng = makeRng(count * 31 + Math.floor(aw * 7 + ah * 11 + ad * 13));
    const positions = new Float32Array(count * 3);
    const seeds = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      positions[i * 3] = (rng() - 0.5) * aw;
      positions[i * 3 + 1] = rng() * ah;
      positions[i * 3 + 2] = (rng() - 0.5) * ad;
      seeds[i] = rng();
    }
    g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    g.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 1));
    g.computeBoundingSphere();
    return g;
  }, [count, aw, ah, ad]);

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
        uniforms: {
          uTime: { value: 0 },
          uColor: { value: new THREE.Color(color) },
          uSize: { value: size },
          uOpacity: { value: opacity },
          uSpeed: { value: speed },
          uArea: { value: new THREE.Vector3(aw, ah, ad) },
          uRise: { value: rise ? 1 : 0 },
          uTwinkle: { value: twinkle ? 1 : 0 },
        },
        vertexShader: PARTICLE_VERT,
        fragmentShader: PARTICLE_FRAG,
      }),
    [color, size, opacity, speed, aw, ah, ad, rise, twinkle, additive],
  );

  useEffect(() => () => geometry.dispose(), [geometry]);
  useEffect(() => () => material.dispose(), [material]);

  // Drive the time uniform through the scene-graph ref so render values stay frozen.
  const pointsRef = useRef<THREE.Points>(null);
  useFrame((state) => {
    const points = pointsRef.current;
    if (!points) return;
    (points.material as THREE.ShaderMaterial).uniforms.uTime.value = state.clock.elapsedTime;
  });

  return <points ref={pointsRef} geometry={geometry} material={material} frustumCulled={false} />;
}

/* ------------------------------------------------------------------ */
/* FlickerLight                                                        */
/* ------------------------------------------------------------------ */

export type FlickerLightProps = {
  color: string;
  intensity: number;
  position: [number, number, number];
  distance?: number;
};

export function FlickerLight({ color, intensity, position, distance = 14 }: FlickerLightProps) {
  const ref = useRef<THREE.PointLight>(null);
  // Per-instance phase (hashed from position) so multiple torches never flicker in lockstep.
  const phase = position[0] * 7.31 + position[1] * 3.79 + position[2] * 13.17;

  useFrame((state) => {
    const light = ref.current;
    if (!light) return;
    const t = state.clock.elapsedTime + phase;
    light.intensity = intensity * (0.82 + 0.13 * Math.sin(t * 7.3) + 0.05 * Math.sin(t * 13.7));
  });

  return <pointLight ref={ref} color={color} intensity={intensity} position={position} distance={distance} decay={2} />;
}

/* ------------------------------------------------------------------ */
/* GradientDome                                                        */
/* ------------------------------------------------------------------ */

export type GradientDomeProps = {
  /** Zenith color. */
  top: string;
  /** Color at and below the horizon. */
  horizon: string;
  radius?: number;
};

const DOME_GEOMETRY = new THREE.SphereGeometry(1, 24, 16);

const DOME_VERT = /* glsl */ `
  varying vec3 vPos;
  void main() {
    vPos = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const DOME_FRAG = /* glsl */ `
  uniform vec3 uTop;
  uniform vec3 uHorizon;
  varying vec3 vPos;
  void main() {
    float h = clamp(normalize(vPos).y, 0.0, 1.0);
    gl_FragColor = vec4(mix(uHorizon, uTop, smoothstep(0.0, 0.55, h)), 1.0);
  }
`;

// One BackSide gradient material per color pair, cached for the app's lifetime
// (a handful of scene palettes at most — never disposed).
const domeMaterialCache = new Map<string, THREE.ShaderMaterial>();

function getDomeMaterial(top: string, horizon: string) {
  const key = `${top}|${horizon}`;
  let mat = domeMaterialCache.get(key);
  if (!mat) {
    mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        uTop: { value: new THREE.Color(top) },
        uHorizon: { value: new THREE.Color(horizon) },
      },
      vertexShader: DOME_VERT,
      fragmentShader: DOME_FRAG,
    });
    domeMaterialCache.set(key, mat);
  }
  return mat;
}

/** Colored-void sky sphere: a vertical gradient rendered behind everything (ShaderMaterial ignores fog). */
export function GradientDome({ top, horizon, radius = 60 }: GradientDomeProps) {
  const material = useMemo(() => getDomeMaterial(top, horizon), [top, horizon]);
  return <mesh geometry={DOME_GEOMETRY} material={material} scale={radius} />;
}

/* ------------------------------------------------------------------ */
/* Silhouettes (instanced props)                                       */
/* ------------------------------------------------------------------ */

export type SilhouetteTransform = {
  p: [number, number, number];
  /** Uniform or per-axis scale (default 1). */
  s?: [number, number, number] | number;
  ry?: number;
  rz?: number;
};

export type SilhouettesProps = {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  transforms: SilhouetteTransform[];
};

// Module-level scratch object for composing instance matrices (never rendered).
const SCRATCH = new THREE.Object3D();

/**
 * One InstancedMesh for a batch of identical props. Matrices are composed once
 * per `transforms` identity change (Euler XYZ: rz tilts the prop, then ry yaws
 * it). Culling is off because batches routinely straddle the fog boundary.
 */
export function Silhouettes({ geometry, material, transforms }: SilhouettesProps) {
  const ref = useRef<THREE.InstancedMesh>(null);

  // Layout effect: a fresh InstancedMesh is ZERO-filled (not identity), and
  // the demand-loop ticker can squeeze a frame in between commit and a
  // passive effect — which would flash every instance collapsed for a frame.
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    for (let i = 0; i < transforms.length; i++) {
      const t = transforms[i];
      SCRATCH.position.set(t.p[0], t.p[1], t.p[2]);
      const s = t.s ?? 1;
      if (Array.isArray(s)) SCRATCH.scale.set(s[0], s[1], s[2]);
      else SCRATCH.scale.setScalar(s);
      SCRATCH.rotation.set(0, t.ry ?? 0, t.rz ?? 0);
      SCRATCH.updateMatrix();
      mesh.setMatrixAt(i, SCRATCH.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }, [transforms]);

  return (
    <instancedMesh
      ref={ref}
      args={[geometry, material, transforms.length]}
      frustumCulled={false}
    />
  );
}

/* ------------------------------------------------------------------ */
/* GlowQuad                                                            */
/* ------------------------------------------------------------------ */

export type GlowQuadProps = {
  color: string;
  /** World-space diameter of the glow sprite. */
  size: number;
  position: [number, number, number];
  opacity?: number;
};

// Lazily built (document is unavailable during SSR) and shared by every glow.
let glowTexture: THREE.CanvasTexture | null = null;

function getGlowTexture() {
  if (glowTexture) return glowTexture;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext("2d")!;
  const grad = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.35, "rgba(255,255,255,0.4)");
  grad.addColorStop(0.7, "rgba(255,255,255,0.08)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 128, 128);
  glowTexture = new THREE.CanvasTexture(canvas);
  return glowTexture;
}

/**
 * Soft additive radial glow as a camera-facing sprite (lantern halos, moons).
 * The radial falloff texture is module-cached; only the tinted SpriteMaterial
 * is per-instance. fog is off so distant glows still punch through.
 */
export function GlowQuad({ color, size, position, opacity = 1 }: GlowQuadProps) {
  const material = useMemo(
    () =>
      new THREE.SpriteMaterial({
        map: getGlowTexture(),
        color,
        transparent: true,
        opacity,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
      }),
    [color, opacity],
  );
  useEffect(() => () => material.dispose(), [material]);

  return <sprite material={material} position={position} scale={[size, size, 1]} />;
}

/* ------------------------------------------------------------------ */
/* Silhouette material + Ground                                        */
/* ------------------------------------------------------------------ */

/** Shared near-black unlit material for all silhouette props. */
export const SILHOUETTE = new THREE.MeshBasicMaterial({ color: "#08060d" });

const GROUND_GEOMETRY = new THREE.CircleGeometry(40, 48);
const GROUND_MATERIAL = new THREE.MeshStandardMaterial({ color: "#0d0a16", roughness: 1, metalness: 0 });

export function Ground() {
  return (
    <mesh
      geometry={GROUND_GEOMETRY}
      material={GROUND_MATERIAL}
      rotation-x={-Math.PI / 2}
      position-y={-0.02}
    />
  );
}
