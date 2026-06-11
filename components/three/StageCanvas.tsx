"use client";

// The persistent 3D stage. Renders on demand (frameloop="demand") with a
// ~30Hz invalidate ticker driving shader time and camera damping; the ticker
// pauses entirely when the tab is hidden.

import { useEffect, useRef } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { damp3 } from "maath/easing";
import * as THREE from "three";
import { useGameStore } from "@/stores/gameStore";
import { AmbientStage } from "./ambient/AmbientStage";

/** Drives frames under frameloop="demand"; paused while document.hidden. */
function InvalidateTicker() {
  const invalidate = useThree((state) => state.invalidate);

  useEffect(() => {
    let id: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (id === null) id = setInterval(() => invalidate(), 33);
    };
    const stop = () => {
      if (id !== null) {
        clearInterval(id);
        id = null;
      }
    };
    const onVisibility = () => (document.hidden ? stop() : start());
    document.addEventListener("visibilitychange", onVisibility);
    onVisibility();
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [invalidate]);

  return null;
}

// smoothTime ≈ 1 / damp-factor(2.5)
const CAM_SMOOTH = 0.4;
const SWAY_RADIUS = 13;

/**
 * Exploration: gentle azimuth sway (±0.07 rad over ~30s) around (0, 7, 13),
 * looking at (0, 1.5, 0). Combat: pulls up and back to frame the whole map,
 * looking at the origin. Both position and look-target are damped.
 */
function CameraDirector() {
  const lookAt = useRef(new THREE.Vector3(0, 1.5, 0));
  const posGoal = useRef(new THREE.Vector3(0, 7, 13));
  const lookGoal = useRef(new THREE.Vector3(0, 1.5, 0));

  useFrame((state, delta) => {
    const { mode, combat } = useGameStore.getState();
    if (mode === "combat" && combat) {
      posGoal.current.set(
        0,
        Math.max(combat.width, combat.height) * 0.85,
        combat.height * 0.55 + 6,
      );
      lookGoal.current.set(0, 0, 0);
    } else {
      const azimuth = Math.sin((state.clock.elapsedTime * Math.PI * 2) / 30) * 0.07;
      posGoal.current.set(Math.sin(azimuth) * SWAY_RADIUS, 7, Math.cos(azimuth) * SWAY_RADIUS);
      lookGoal.current.set(0, 1.5, 0);
    }

    damp3(state.camera.position, posGoal.current, CAM_SMOOTH, delta);
    damp3(lookAt.current, lookGoal.current, CAM_SMOOTH, delta);
    state.camera.lookAt(lookAt.current);
  });

  return null;
}

export default function StageCanvas({ children }: { children?: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-0">
      <Canvas
        frameloop="demand"
        dpr={[1, 1.75]}
        gl={{ antialias: true, powerPreference: "high-performance" }}
        camera={{ fov: 45, position: [0, 7, 13] }}
        onCreated={(state) => {
          // Debug handle for E2E scene-graph checks
          (window as unknown as { __three?: unknown }).__three = state;
          // Allow the browser to restore a lost WebGL context (driver resets,
          // tab pressure); three re-uploads resources on restoration.
          const canvas = state.gl.domElement;
          canvas.addEventListener("webglcontextlost", (e) => {
            e.preventDefault();
            console.warn("WebGL context lost — awaiting restore");
          });
          canvas.addEventListener("webglcontextrestored", () => {
            console.warn("WebGL context restored");
            state.invalidate();
          });
        }}
      >
        <InvalidateTicker />
        <CameraDirector />
        <AmbientStage />
        {children}
      </Canvas>
    </div>
  );
}
