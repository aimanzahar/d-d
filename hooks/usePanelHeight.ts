"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent } from "react";

const STORAGE_KEY = "eq.chatPanelHeight";
const MIN_PX = 220;
const TOP_CLEARANCE = 240; // header + battlefield spacer + margins + combat HUD headroom

function clamp(px: number): number {
  if (typeof window === "undefined") return px;
  // max can dip below MIN_PX on tiny viewports — keep min/max from inverting
  const max = Math.max(MIN_PX, window.innerHeight - TOP_CLEARANCE);
  return Math.min(Math.max(px, MIN_PX), max);
}

/** Chat panel height in px — drag-resizable from the top edge, persisted to localStorage. */
export function usePanelHeight() {
  const [panelHeight, setPanelHeight] = useState(() => {
    if (typeof window === "undefined") return MIN_PX;
    const stored = Number(window.localStorage.getItem(STORAGE_KEY));
    return clamp(stored > 0 ? stored : window.innerHeight * 0.52);
  });
  const drag = useRef<{ startY: number; startHeight: number; latest: number } | null>(null);

  // Re-clamp when the viewport shrinks (window resize, device rotation) so a
  // stale large height never pushes the input off the bottom of the screen.
  useEffect(() => {
    const onResize = () => setPanelHeight((h) => clamp(h));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const onPointerDown = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      // capture so the 3D canvas never sees the drag
      e.currentTarget.setPointerCapture(e.pointerId);
      drag.current = { startY: e.clientY, startHeight: panelHeight, latest: panelHeight };
    },
    [panelHeight]
  );

  const onPointerMove = useCallback((e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    // dragging up grows the panel
    const next = clamp(drag.current.startHeight + (drag.current.startY - e.clientY));
    drag.current.latest = next;
    setPanelHeight(next);
  }, []);

  const onPointerUp = useCallback((e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    window.localStorage.setItem(STORAGE_KEY, String(drag.current.latest));
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  }, []);

  return {
    panelHeight,
    gripProps: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp },
  };
}
