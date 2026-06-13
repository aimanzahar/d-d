"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Panel } from "@/components/ui/Panel";

// A small popover that reveals `content` on hover (devices with a fine pointer)
// and on tap (touch / coarse pointer), with Escape + outside-click dismissal and
// an explicit close affordance on touch. Rendered in a body portal so it escapes
// overflow/transform ancestors — notably the anime.js step-entrance animation on
// the creation wizard, which would otherwise translate/fade it. Generic over the
// content node, so item descriptions (A1) and ability tooltips (A2) share it.
export function HoverPopover({
  content,
  children,
  className = "",
}: {
  content: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  // Whether this device drives the popover by hover (desktop) or tap (touch).
  // Read lazily so SSR (where `window` is absent) doesn't throw.
  const hasHover = () =>
    typeof window !== "undefined" && !!window.matchMedia?.("(hover: hover)").matches;

  // Anchor the popover's bottom-center just above the trigger, clamped so it
  // never spills past the viewport edges.
  const place = () => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const left = Math.min(Math.max(r.left + r.width / 2, 12), window.innerWidth - 12);
    setCoords({ top: r.top - 8, left });
  };

  const show = () => {
    place();
    setOpen(true);
  };
  const hide = () => setOpen(false);

  // Dismissal listeners (mainly for the touch path; hover auto-hides on leave).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t) || popRef.current?.contains(t)) return;
      setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
    };
  }, [open]);

  const touch = !hasHover();

  return (
    <>
      <span
        ref={triggerRef}
        className={`inline-flex ${className}`}
        onPointerEnter={(e) => e.pointerType !== "touch" && show()}
        onPointerLeave={(e) => e.pointerType !== "touch" && hide()}
        onClick={(e) => {
          // Hover already drives the desktop case; tap toggles on touch.
          if (hasHover()) return;
          e.stopPropagation();
          open ? hide() : show();
        }}
      >
        {children}
      </span>
      {open &&
        coords &&
        createPortal(
          <div
            ref={popRef}
            role="tooltip"
            className="fixed z-[300] -translate-x-1/2 -translate-y-full"
            style={{ top: coords.top, left: coords.left, maxWidth: "min(20rem, calc(100vw - 24px))" }}
          >
            <Panel innerClassName="p-3 text-sm text-parchment-dim leading-snug">
              {touch && (
                <button
                  type="button"
                  aria-label="Close"
                  className="float-right -mt-1 -mr-1 ml-2 px-1.5 text-parchment-faint hover:text-parchment cursor-pointer"
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpen(false);
                  }}
                >
                  ✕
                </button>
              )}
              {content}
            </Panel>
          </div>,
          document.body,
        )}
    </>
  );
}
