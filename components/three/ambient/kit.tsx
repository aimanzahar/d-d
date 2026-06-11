"use client";

// Shared ambient-scene building blocks: GPU particle fields, flickering point
// lights, and silhouette/ground primitives. Everything heavy (geometry,
// shaders) is memoized or module-cached; useFrame bodies allocate nothing.

import { useEffect, useMemo, useRef } from "react";
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

  useFrame((state) => {
    material.uniforms.uTime.value = state.clock.elapsedTime;
  });

  return <points geometry={geometry} material={material} frustumCulled={false} />;
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
  // Per-instance phase so multiple torches never flicker in lockstep.
  const phase = useMemo(() => Math.random() * 17, []);

  useFrame((state) => {
    const light = ref.current;
    if (!light) return;
    const t = state.clock.elapsedTime + phase;
    light.intensity = intensity * (0.82 + 0.13 * Math.sin(t * 7.3) + 0.05 * Math.sin(t * 13.7));
  });

  return <pointLight ref={ref} color={color} intensity={intensity} position={position} distance={distance} decay={2} />;
}

/* ------------------------------------------------------------------ */
/* Silhouettes + Ground                                                */
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
