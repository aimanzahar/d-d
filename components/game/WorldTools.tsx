"use client";

import { useState, type ReactNode } from "react";
import { CodexWindow } from "./CodexWindow";
import { RegionMapWindow } from "./RegionMapWindow";

type WorldWindow = "codex" | "map" | null;

function ToolButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 font-display text-[0.55rem] tracking-[0.2em] uppercase px-2 py-1.5 border cursor-pointer transition-colors ${
        active
          ? "border-gold text-gold-bright bg-gold/10"
          : "border-gold-dim/40 text-parchment-faint hover:border-gold-dim"
      }`}
    >
      {children}
    </button>
  );
}

// Sidebar toolbar opening the world windows (codex; map added in Phase E).
export function WorldTools() {
  const [open, setOpen] = useState<WorldWindow>(null);
  const toggle = (w: WorldWindow) => setOpen((cur) => (cur === w ? null : w));
  return (
    <>
      <div className="flex gap-1.5">
        <ToolButton active={open === "codex"} onClick={() => toggle("codex")}>
          📖 Codex
        </ToolButton>
        <ToolButton active={open === "map"} onClick={() => toggle("map")}>
          🗺 Map
        </ToolButton>
      </div>
      {open === "codex" && <CodexWindow onClose={() => setOpen(null)} />}
      {open === "map" && <RegionMapWindow onClose={() => setOpen(null)} />}
    </>
  );
}
