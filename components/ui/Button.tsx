"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "ember" | "gold" | "ghost";

const base =
  "relative inline-flex items-center justify-center gap-2 font-display tracking-[0.14em] uppercase " +
  "transition-all duration-150 active:scale-[0.97] disabled:opacity-40 disabled:pointer-events-none " +
  "cursor-pointer select-none";

const variants: Record<Variant, string> = {
  ember:
    "bg-gradient-to-b from-ember to-[#b34f15] text-ink font-bold " +
    "shadow-[0_0_24px_rgba(232,114,42,0.25)] hover:shadow-[0_0_36px_rgba(232,114,42,0.45)] " +
    "hover:brightness-110",
  gold:
    "border border-gold-dim/60 text-gold hover:border-gold hover:text-gold-bright " +
    "hover:shadow-[0_0_20px_rgba(201,164,92,0.15)] bg-ink-soft/40",
  ghost: "text-parchment-dim hover:text-parchment hover:bg-ink-raise/50",
};

const sizes = {
  sm: "px-3 py-1.5 text-[0.7rem]",
  md: "px-5 py-2.5 text-xs",
  lg: "px-8 py-3.5 text-sm",
};

// Corner ticks that brighten on hover — tiny "metal fitting" details.
function Ticks() {
  const tick = "absolute w-[7px] h-[7px] border-gold/40 transition-colors duration-150 group-hover:border-gold-bright/80";
  return (
    <>
      <span className={`${tick} top-0 left-0 border-t border-l`} aria-hidden />
      <span className={`${tick} top-0 right-0 border-t border-r`} aria-hidden />
      <span className={`${tick} bottom-0 left-0 border-b border-l`} aria-hidden />
      <span className={`${tick} bottom-0 right-0 border-b border-r`} aria-hidden />
    </>
  );
}

export function Button({
  variant = "gold",
  size = "md",
  className = "",
  children,
  ...rest
}: {
  variant?: Variant;
  size?: keyof typeof sizes;
  children: ReactNode;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button className={`group ${base} ${variants[variant]} ${sizes[size]} ${className}`} {...rest}>
      {variant !== "ghost" && <Ticks />}
      {children}
    </button>
  );
}
