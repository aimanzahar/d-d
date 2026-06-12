"use client";

// Seed text handed to the action composer (e.g. inventory clicks prefill the input).

import { create } from "zustand";

type ComposerStore = {
  seed: string | null;
  setSeed: (text: string) => void;
  clearSeed: () => void;
};

export const useComposerStore = create<ComposerStore>()((set) => ({
  seed: null,
  setSeed: (text) => set({ seed: text }),
  clearSeed: () => set({ seed: null }),
}));
