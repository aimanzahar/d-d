"use client";

// One physically simulated die. The rapier body tumbles freely; once it comes
// to rest we read which logical face landed up (down for a d4) and — if it is
// not the server-authoritative result — slerp ONLY the visual child mesh by the
// corrective rotation that brings the correct face into the landed face's
// place. The physics body is never touched, so the pile stays stable.

import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { RigidBody, type RapierRigidBody } from "@react-three/rapier";
import * as THREE from "three";
import { buildDie, type DieSides } from "./diceGeometries";

const SUPPORTED_SIDES: readonly DieSides[] = [4, 6, 8, 10, 12, 20];

/** Smallest supported die that can represent the requested one. */
function normalizeSides(sides: number): DieSides {
  for (const s of SUPPORTED_SIDES) {
    if (s >= sides) return s;
  }
  return 20;
}

const IDENTITY_Q = new THREE.Quaternion();
const SCRATCH_Q = new THREE.Quaternion();
const SCRATCH_V = new THREE.Vector3();
const SCRATCH_E = new THREE.Euler();

const GRACE_MS = 400;
const REST_SPEED = 0.15; // linear + angular magnitude threshold
const REST_SPEED_SQ = REST_SPEED * REST_SPEED;
const REST_FRAMES = 10;
const REMAP_MS = 150;

export type PhysicalDieProps = {
  sides: number;
  /** The server result this die MUST end up showing. */
  value: number;
  /** A dropped advantage/disadvantage die — rendered ghosted. */
  dimmed?: boolean;
  spawnIndex: number;
  onSettled: () => void;
};

export function PhysicalDie({ sides, value, dimmed = false, spawnIndex, onSettled }: PhysicalDieProps) {
  const safeSides = normalizeSides(sides);
  const die = useMemo(() => buildDie(safeSides), [safeSides]);

  const bodyRef = useRef<RapierRigidBody>(null);
  const visualRef = useRef<THREE.Group>(null);

  const bornAt = useRef(-1);
  const restFrames = useRef(0);
  const settled = useRef(false);
  const remapping = useRef(false);
  const remapStart = useRef(0);
  const corrective = useRef(new THREE.Quaternion());

  const onSettledRef = useRef(onSettled);
  useEffect(() => {
    onSettledRef.current = onSettled;
  }, [onSettled]);

  // Deterministic stagger above the tray (render must stay pure); the random
  // jitter, orientation, and velocities are applied in the mount effect below.
  const spawnPosition = useMemo<[number, number, number]>(() => {
    const col = spawnIndex % 4;
    const row = Math.floor(spawnIndex / 4);
    return [(col - 1.5) * 1.3, 4.5 + row * 0.8, ((row % 3) - 1) * 1.4];
  }, [spawnIndex]);

  // Dropped dice get ghosted clones of the shared materials.
  const materials = useMemo(() => {
    if (!dimmed) return die.materials;
    return die.materials.map((m) => {
      const clone = m.clone();
      clone.transparent = true;
      clone.opacity = 0.35;
      return clone;
    });
  }, [die, dimmed]);

  useEffect(() => {
    if (materials === die.materials) return;
    const owned = materials;
    return () => {
      for (const m of owned) m.dispose(); // clones only; textures are shared
    };
  }, [materials, die]);

  // Jitter the spawn point, randomize orientation, and kick the die toward
  // the tray center with a random tangent + tumble.
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    bornAt.current = performance.now();

    const t = body.translation();
    const px = t.x + (Math.random() - 0.5) * 0.4;
    const py = t.y + Math.random() * 0.3;
    const pz = t.z + (Math.random() - 0.5) * 0.4;
    body.setTranslation({ x: px, y: py, z: pz }, true);

    SCRATCH_E.set(
      Math.random() * Math.PI * 2,
      Math.random() * Math.PI * 2,
      Math.random() * Math.PI * 2,
    );
    SCRATCH_Q.setFromEuler(SCRATCH_E);
    body.setRotation({ x: SCRATCH_Q.x, y: SCRATCH_Q.y, z: SCRATCH_Q.z, w: SCRATCH_Q.w }, true);

    SCRATCH_V.set(-px, 0, -pz);
    if (SCRATCH_V.lengthSq() < 1e-6) SCRATCH_V.set(1, 0, 0);
    SCRATCH_V.normalize();
    const speed = 4 + Math.random() * 3;
    const swirl = (Math.random() - 0.5) * 4;
    body.setLinvel(
      {
        x: SCRATCH_V.x * speed - SCRATCH_V.z * swirl,
        y: -1,
        z: SCRATCH_V.z * speed + SCRATCH_V.x * swirl,
      },
      true,
    );
    const spin = () => (10 + Math.random() * 8) * (Math.random() < 0.5 ? -1 : 1);
    body.setAngvel({ x: spin(), y: spin(), z: spin() }, true);
  }, []);

  useFrame(() => {
    const body = bodyRef.current;
    const visual = visualRef.current;
    if (!body || !visual) return;

    // Phase 3: ease the visual child toward the corrective rotation.
    if (remapping.current) {
      const t = Math.min(1, (performance.now() - remapStart.current) / REMAP_MS);
      visual.quaternion.slerpQuaternions(IDENTITY_Q, corrective.current, t);
      if (t >= 1) remapping.current = false;
      return;
    }
    if (settled.current) return;

    // Phase 1: tumble. Wait out the grace period, then watch for rest.
    if (bornAt.current < 0 || performance.now() - bornAt.current < GRACE_MS) return;

    const lv = body.linvel();
    const av = body.angvel();
    const atRest =
      lv.x * lv.x + lv.y * lv.y + lv.z * lv.z < REST_SPEED_SQ &&
      av.x * av.x + av.y * av.y + av.z * av.z < REST_SPEED_SQ;
    restFrames.current = atRest ? restFrames.current + 1 : 0;
    if (!body.isSleeping() && restFrames.current < REST_FRAMES) return;

    // Phase 2: settled. Read the landed logical face and plan the remap.
    settled.current = true;

    const r = body.rotation();
    SCRATCH_Q.set(r.x, r.y, r.z, r.w);
    // d4 exception: it rests on a face; the result is the face that is DOWN.
    const readDown = safeSides === 4;
    let landed = 0;
    let bestDot = readDown ? Infinity : -Infinity;
    for (let i = 0; i < die.faceNormals.length; i++) {
      const d = SCRATCH_V.copy(die.faceNormals[i]).applyQuaternion(SCRATCH_Q).y;
      if (readDown ? d < bestDot : d > bestDot) {
        bestDot = d;
        landed = i;
      }
    }

    if (die.faceValues[landed] !== value) {
      const wanted = die.faceValues.indexOf(value);
      if (wanted !== -1) {
        // Rotation taking the wanted face's local normal onto the landed
        // face's local normal: world-space, q * (R * n_wanted) = q * n_landed,
        // i.e. the wanted face ends up exactly where the landed face rests.
        corrective.current.setFromUnitVectors(die.faceNormals[wanted], die.faceNormals[landed]);
        remapStart.current = performance.now();
        remapping.current = true;
      }
      // wanted === -1 only for unsupported dice (e.g. d100): leave as-is.
    }

    onSettledRef.current();
  });

  return (
    <RigidBody
      ref={bodyRef}
      colliders="hull"
      ccd
      position={spawnPosition}
      friction={0.6}
      restitution={0.3}
      linearDamping={0.15}
      angularDamping={0.4}
    >
      <group ref={visualRef}>
        <mesh geometry={die.geometry} material={materials} />
      </group>
    </RigidBody>
  );
}
