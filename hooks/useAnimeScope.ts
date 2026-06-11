"use client";

import { createScope, type Scope } from "animejs";
import { useEffect, useRef, type RefObject } from "react";

// anime.js v4 React lifecycle helper: animations registered inside `setup`
// are confined to `root`'s subtree and reverted on unmount (strict-mode safe).
export function useAnimeScope<T extends HTMLElement>(
  setup: (scope?: Scope) => void,
  deps: unknown[] = [],
): RefObject<T | null> {
  const root = useRef<T>(null);
  const scope = useRef<Scope | null>(null);

  useEffect(() => {
    if (!root.current) return;
    scope.current = createScope({ root: root.current as HTMLElement }).add(setup);
    return () => {
      scope.current?.revert();
      scope.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return root;
}
