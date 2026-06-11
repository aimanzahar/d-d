"use client";

// Full-screen transparent canvas that rolls one DiceEvent's worth of physical
// dice into an invisible tray, then reports completion. Loaded with
// next/dynamic({ ssr: false }) by DiceRollerHost.

import { useCallback, useEffect, useMemo, useRef } from "react";
import { Canvas } from "@react-three/fiber";
import { ContactShadows } from "@react-three/drei";
import { CuboidCollider, Physics, RigidBody } from "@react-three/rapier";
import type { DiceEvent } from "@/stores/gameStore";
import { PhysicalDie } from "./PhysicalDie";

const LINGER_MS = 1300; // pause on the settled pile before onDone
const SAFETY_MS = 8000; // absolute ceiling — onDone always fires

type DiceOverlayProps = {
  event: DiceEvent;
  onDone: () => void;
};

type DieSpec = { sides: number; value: number; dimmed: boolean };

export default function DiceOverlay({ event, onDone }: DiceOverlayProps) {
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  }, [onDone]);

  const dice = useMemo<DieSpec[]>(
    () =>
      event.dice.flatMap((group) => [
        ...group.results.map((value) => ({ sides: group.sides, value, dimmed: false })),
        ...group.dropped.map((value) => ({ sides: group.sides, value, dimmed: true })),
      ]),
    [event],
  );

  const doneFired = useRef(false);
  const settledCount = useRef(0);
  const lingerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fireDone = useCallback(() => {
    if (doneFired.current) return;
    doneFired.current = true;
    onDoneRef.current();
  }, []);

  const handleSettled = useCallback(() => {
    settledCount.current += 1;
    if (settledCount.current >= dice.length && lingerTimer.current === null) {
      lingerTimer.current = setTimeout(fireDone, LINGER_MS);
    }
  }, [dice.length, fireDone]);

  useEffect(() => {
    const safety = setTimeout(fireDone, SAFETY_MS);
    // Degenerate event with no dice: nothing will ever settle, end quickly.
    const empty = dice.length === 0 ? setTimeout(fireDone, LINGER_MS) : null;
    return () => {
      clearTimeout(safety);
      if (empty !== null) clearTimeout(empty);
      if (lingerTimer.current !== null) clearTimeout(lingerTimer.current);
    };
  }, [fireDone, dice.length]);

  return (
    <div className="fixed inset-0 z-40 pointer-events-none">
      <Canvas
        frameloop="always"
        dpr={[1, 2]}
        gl={{ alpha: true }}
        camera={{ position: [0, 10, 5], fov: 36 }}
        onCreated={({ camera }) => camera.lookAt(0, 0, 0)}
      >
        <ambientLight intensity={0.5} />
        <directionalLight position={[4, 9, 3]} intensity={1.4} />

        <Physics gravity={[0, -24, 0]}>
          {/* Invisible tray: floor (top at y=0), four walls, and a lid so no
              die can ever escape the play volume. */}
          <RigidBody type="fixed" colliders={false}>
            <CuboidCollider args={[7, 0.5, 5]} position={[0, -0.5, 0]} />
            <CuboidCollider args={[0.5, 4, 5]} position={[-6.5, 3.5, 0]} />
            <CuboidCollider args={[0.5, 4, 5]} position={[6.5, 3.5, 0]} />
            <CuboidCollider args={[7, 4, 0.5]} position={[0, 3.5, -4.5]} />
            <CuboidCollider args={[7, 4, 0.5]} position={[0, 3.5, 4.5]} />
            <CuboidCollider args={[7, 0.5, 5]} position={[0, 8, 0]} />
          </RigidBody>

          {dice.map((die, i) => (
            <PhysicalDie
              key={`${event.rollId}-${i}`}
              sides={die.sides}
              value={die.value}
              dimmed={die.dimmed}
              spawnIndex={i}
              onSettled={handleSettled}
            />
          ))}
        </Physics>

        <ContactShadows
          position={[0, 0.01, 0]}
          opacity={0.5}
          blur={2.4}
          far={4}
          resolution={256}
          scale={16}
        />
      </Canvas>
    </div>
  );
}
