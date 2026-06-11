"use client";

import { animate, stagger } from "animejs";
import { useEffect, useRef, useState } from "react";

// Streamed GM narration with incremental word reveal. The message doc's
// content is APPEND-ONLY while streaming (backend contract), so each update
// only animates the newly-arrived words. Once complete, the spans collapse
// back to plain text to keep the DOM light.
export function GMMessage({
  content,
  status,
}: {
  content: string;
  status: "streaming" | "complete" | "error";
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const revealedRef = useRef(0);
  const [settled, setSettled] = useState(status !== "streaming");

  useEffect(() => {
    if (settled || !containerRef.current) return;
    const fresh = content.slice(reveatedSafe(revealedRef.current, content));
    if (fresh) {
      revealedRef.current = content.length;
      const words = fresh.split(/(\s+)/).filter((w) => w.length > 0);
      const frag = document.createDocumentFragment();
      const spans: HTMLSpanElement[] = [];
      for (const word of words) {
        const span = document.createElement("span");
        span.textContent = word;
        if (word.trim()) {
          span.style.opacity = "0";
          span.style.display = "inline-block";
          spans.push(span);
        }
        frag.appendChild(span);
      }
      containerRef.current.appendChild(frag);
      if (spans.length > 0) {
        animate(spans, {
          opacity: [0, 1],
          translateY: [5, 0],
          filter: ["blur(4px)", "blur(0px)"],
          duration: 240,
          delay: stagger(18),
          ease: "out(2)",
        });
      }
    }
    if (status !== "streaming") {
      // allow the last words to finish animating, then collapse
      const timer = setTimeout(() => setSettled(true), 800);
      return () => clearTimeout(timer);
    }
  }, [content, status, settled]);

  // Distinct keys force React to swap the DOM node on settle — the streaming
  // container holds imperative spans React doesn't track, so it must unmount.
  if (settled) {
    return (
      <div
        key="settled"
        className="gm-prose font-narrative text-[1.05rem] leading-relaxed text-parchment whitespace-pre-wrap"
      >
        {content}
        {status === "error" && (
          <span className="block mt-1 font-ui text-xs text-blood italic">
            …the thread of the tale frayed here.
          </span>
        )}
      </div>
    );
  }
  return (
    <div
      key="streaming"
      ref={containerRef}
      className="gm-prose font-narrative text-[1.05rem] leading-relaxed text-parchment whitespace-pre-wrap"
    />
  );
}

function reveatedSafe(revealed: number, content: string): number {
  return Math.min(revealed, content.length);
}
