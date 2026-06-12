"use client";

import { animate, stagger } from "animejs";
import { useEffect, useRef, useState } from "react";
import { createStreamingMarkdown, renderGmMarkdown } from "@/lib/markdown";

// Streamed GM narration with incremental word reveal. The message doc's
// content is APPEND-ONLY while streaming (backend contract), so each update
// only animates the newly-arrived words. Once complete, the spans collapse
// back to parsed markdown to keep the DOM light.
export function GMMessage({
  content,
  status,
}: {
  content: string;
  status: "streaming" | "complete" | "error";
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const revealedRef = useRef(0);
  // Created lazily, never reset: NarrationFeed keys each message by _id, so
  // the component (and this formatter) remounts per message.
  const markdownRef = useRef<ReturnType<typeof createStreamingMarkdown> | null>(null);
  const [settled, setSettled] = useState(status !== "streaming");

  useEffect(() => {
    if (settled || !containerRef.current) return;
    const fresh = content.slice(reveatedSafe(revealedRef.current, content));
    if (fresh) {
      revealedRef.current = content.length;
      markdownRef.current ??= createStreamingMarkdown();
      // Tokens are whitespace-split words with markers stripped and style
      // flags attached (slice indexing above stays in raw-content space).
      const tokens = markdownRef.current.feed(fresh);
      const frag = document.createDocumentFragment();
      const spans: HTMLSpanElement[] = [];
      const revealTo: number[] = [];
      // Consecutive styled fragments of one word (e.g. bold "Grom" + plain
      // "'s") share an inline-block wrapper so the word stays one unbreakable
      // animation unit; whitespace tokens close the current word.
      let word: HTMLSpanElement | null = null;
      for (const token of tokens) {
        const span = document.createElement("span");
        span.textContent = token.text;
        if (token.bold) {
          span.style.fontWeight = "600";
          span.style.color = "var(--color-gold-bright)";
        }
        if (token.italic || token.quote) span.style.fontStyle = "italic";
        if (!token.text.trim()) {
          word = null;
          frag.appendChild(span);
          continue;
        }
        if (!word) {
          word = document.createElement("span");
          word.style.display = "inline-block";
          word.style.opacity = "0";
          spans.push(word);
          // Lightweight quote hint — true blockquote styling lands on settle
          revealTo.push(token.quote ? 0.92 : 1);
          frag.appendChild(word);
        }
        word.appendChild(span);
      }
      containerRef.current.appendChild(frag);
      if (spans.length > 0) {
        animate(spans, {
          opacity: (_: unknown, i?: number) => [0, revealTo[i ?? 0]],
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
        className="gm-prose font-narrative text-[1.05rem] leading-relaxed text-parchment"
      >
        {renderGmMarkdown(content)}
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
