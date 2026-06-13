"use client";

// Per-player narration audio preference (spoken GM narration). Persisted to
// localStorage so a player's mute choice and volume survive reloads. Default ON.

import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";

const KEY = "emberquill:narration";

function load(): { enabled: boolean; volume: number } {
  if (typeof window === "undefined") return { enabled: true, volume: 0.9 };
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw) as { enabled?: boolean; volume?: number };
      return {
        enabled: p.enabled !== false, // default ON
        volume: typeof p.volume === "number" ? p.volume : 0.9,
      };
    }
  } catch {
    /* ignore corrupt storage */
  }
  return { enabled: true, volume: 0.9 };
}

function save(enabled: boolean, volume: number) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ enabled, volume }));
  } catch {
    /* ignore */
  }
}

type AudioStore = {
  narrationEnabled: boolean;
  volume: number; // 0..1
  setNarrationEnabled: (v: boolean) => void;
  setVolume: (v: number) => void;
};

const initial = load();

export const useAudioStore = create<AudioStore>()(
  subscribeWithSelector((set, get) => ({
    narrationEnabled: initial.enabled,
    volume: initial.volume,
    setNarrationEnabled: (v) => {
      set({ narrationEnabled: v });
      save(v, get().volume);
    },
    setVolume: (v) => {
      const volume = Math.min(1, Math.max(0, v));
      set({ volume });
      save(get().narrationEnabled, volume);
    },
  })),
);
