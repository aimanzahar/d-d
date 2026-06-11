import type { HTMLAttributes, ReactNode } from "react";

// Notched glass panel with a gold gradient edge — the house style surface.
export function Panel({
  children,
  className = "",
  innerClassName = "",
  ...rest
}: {
  children: ReactNode;
  className?: string;
  innerClassName?: string;
} & HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={`panel-notch ${className}`} {...rest}>
      <div className={`panel-notch-inner h-full w-full ${innerClassName}`}>{children}</div>
    </div>
  );
}
