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
const DRAG_SMOOTH = 0.08; // near-1:1 while the right button is held
const SWAY_RADIUS = 13;
const ZOOM_MIN = 0.55; // multiplier on the camera's offset from the look-target
const ZOOM_MAX = 1.8;

/**
 * Exploration: gentle azimuth sway (±0.07 rad over ~30s) around (0, 7, 13),
 * looking at (0, 1.5, 0). Combat: frames the whole map from above, then lets
 * the player right-drag to pan (look-target clamped to the map) and wheel to
 * zoom; both reset on each new encounter map and persist across turns. Both
 * position and look-target are damped.
 */
function CameraDirector() {
  const lookAt = useRef(new THREE.Vector3(0, 1.5, 0));
  const posGoal = useRef(new THREE.Vector3(0, 7, 13));
  const lookGoal = useRef(new THREE.Vector3(0, 1.5, 0));
  const pan = useRef({ x: 0, z: 0 }); // look-target offset on the map plane
  const zoom = useRef(1);
  const drag = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const combatKey = useRef<string | null>(null);
  const gl = useThree((state) => state.gl);
  const invalidate = useThree((state) => state.invalidate);

  useEffect(() => {
    const el = gl.domElement;

    const onContextMenu = (e: Event) => e.preventDefault();

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 2 || drag.current) return;
      const { mode, combat } = useGameStore.getState();
      if (mode !== "combat" || !combat) return;
      try {
        // Capture so the drag survives crossing the UI overlays above the canvas
        el.setPointerCapture(e.pointerId);
      } catch {
        // pointer already gone — the drag just won't survive leaving the canvas
      }
      drag.current = { pointerId: e.pointerId, x: e.clientX, y: e.clientY };
    };

    const onPointerMove = (e: PointerEvent) => {
      const d = drag.current;
      if (!d || d.pointerId !== e.pointerId) return;
      if ((e.buttons & 2) === 0) {
        drag.current = null; // release was lost (capture stolen) — self-heal
        return;
      }
      const { combat } = useGameStore.getState();
      if (!combat) return;
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      d.x = e.clientX;
      d.y = e.clientY;
      const camY = Math.max(combat.width, combat.height) * 0.85;
      const camDist = combat.height * 0.55 + 6;
      // World units per pixel at look-target depth (fov 45) — the ground
      // tracks the cursor ~1:1, "grabbing" the map.
      const unitsPerPx =
        (2 * Math.hypot(camY, camDist) * zoom.current * Math.tan((45 * Math.PI) / 360)) /
        el.clientHeight;
      pan.current.x = THREE.MathUtils.clamp(
        pan.current.x - dx * unitsPerPx,
        -combat.width / 2,
        combat.width / 2,
      );
      pan.current.z = THREE.MathUtils.clamp(
        pan.current.z - dy * unitsPerPx,
        -combat.height / 2,
        combat.height / 2,
      );
      invalidate();
    };

    const onPointerEnd = (e: PointerEvent) => {
      if (drag.current?.pointerId === e.pointerId) drag.current = null;
    };

    const onWheel = (e: WheelEvent) => {
      if (useGameStore.getState().mode !== "combat") return;
      e.preventDefault();
      zoom.current = THREE.MathUtils.clamp(
        zoom.current * Math.exp(e.deltaY * 0.001),
        ZOOM_MIN,
        ZOOM_MAX,
      );
      invalidate();
    };

    el.addEventListener("contextmenu", onContextMenu);
    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("pointermove", onPointerMove);
    el.addEventListener("pointerup", onPointerEnd);
    el.addEventListener("pointercancel", onPointerEnd);
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("contextmenu", onContextMenu);
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("pointerup", onPointerEnd);
      el.removeEventListener("pointercancel", onPointerEnd);
      el.removeEventListener("wheel", onWheel);
    };
  }, [gl, invalidate]);

  useFrame((state, delta) => {
    const { mode, combat } = useGameStore.getState();
    if (mode === "combat" && combat) {
      // New encounter map → forget the player's pan/zoom (same signature
      // BattleMap3D uses to retrigger its entrance animation).
      const key = `${combat.width}x${combat.height}|${combat.terrain.join("\n")}`;
      if (combatKey.current !== key) {
        combatKey.current = key;
        pan.current.x = 0;
        pan.current.z = 0;
        zoom.current = 1;
      }
      const camY = Math.max(combat.width, combat.height) * 0.85;
      const camDist = combat.height * 0.55 + 6;
      posGoal.current.set(
        pan.current.x,
        camY * zoom.current,
        pan.current.z + camDist * zoom.current,
      );
      lookGoal.current.set(pan.current.x, 0, pan.current.z);
    } else {
      combatKey.current = null; // next combat entry starts from the default framing
      drag.current = null; // cancel a drag if the mode flipped mid-gesture
      const azimuth = Math.sin((state.clock.elapsedTime * Math.PI * 2) / 30) * 0.07;
      posGoal.current.set(Math.sin(azimuth) * SWAY_RADIUS, 7, Math.cos(azimuth) * SWAY_RADIUS);
      lookGoal.current.set(0, 1.5, 0);
    }

    const smooth = drag.current ? DRAG_SMOOTH : CAM_SMOOTH;
    damp3(state.camera.position, posGoal.current, smooth, delta);
    damp3(lookAt.current, lookGoal.current, smooth, delta);
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
