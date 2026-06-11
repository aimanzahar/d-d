"use client";

import type { InputHTMLAttributes, TextareaHTMLAttributes } from "react";

export function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="block font-display text-[0.65rem] tracking-[0.22em] uppercase text-gold-dim mb-1.5">
      {children}
    </span>
  );
}

export function TextInput({
  className = "",
  ...rest
}: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`field-arcane w-full px-3.5 py-2.5 text-[0.95rem] rounded-[2px] ${className}`}
      {...rest}
    />
  );
}

export function TextArea({
  className = "",
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={`field-arcane w-full px-3.5 py-2.5 text-[0.95rem] rounded-[2px] resize-none leading-relaxed ${className}`}
      {...rest}
    />
  );
}
