"use client";

// Spoken GM narration playback. Singleton mounted once in GameScreen. Subscribes
// to the narration-audio feed and plays GM clips through one <audio> element, in
// order (queue, never overlapping). On arrival it voices the CURRENT scene once,
// then every new narration as it lands. Respects the per-player mute toggle and
// unlocks autoplay on the first user gesture (browsers block audio until then).

import { useQuery } from "convex/react";
import { useCallback, useEffect, useRef } from "react";
import { api } from "@/convex/_generated/api";
import { useSession } from "@/hooks/useSession";
import { useAudioStore } from "@/stores/audioStore";

export function NarrationAudio() {
  const session = useSession();
  const feed = useQuery(api.messages.narrationAudio, {
    sessionToken: session.sessionToken,
    campaignId: session.campaignId,
  });

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const queueRef = useRef<{ id: string; url: string }[]>([]);
  const seenRef = useRef<Set<string>>(new Set());
  const initializedRef = useRef(false);
  const watermarkRef = useRef(0);
  const playingRef = useRef(false);
  const unlockedRef = useRef(false);

  // Play the head of the queue if idle, enabled, and audio is unlocked. The head
  // stays queued until it actually finishes (advance), so a blocked play() is
  // retried on the next gesture/enqueue rather than lost.
  const playNext = useCallback(() => {
    const el = audioRef.current;
    if (!el || playingRef.current || !unlockedRef.current) return;
    if (!useAudioStore.getState().narrationEnabled) {
      queueRef.current = [];
      return;
    }
    const next = queueRef.current[0];
    if (!next) return;
    playingRef.current = true;
    el.src = next.url;
    el.volume = useAudioStore.getState().volume;
    el.play().catch(() => {
      // Autoplay still blocked — keep the clip queued and wait for a gesture.
      playingRef.current = false;
    });
  }, []);

  // A clip finished (or errored): drop it and move on.
  const advance = useCallback(() => {
    queueRef.current.shift();
    playingRef.current = false;
    playNext();
  }, [playNext]);

  // Unlock autoplay on the first user interaction, then drain the queue.
  useEffect(() => {
    const unlock = () => {
      unlockedRef.current = true;
      playNext();
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, [playNext]);

  // Stop immediately on mute; resume draining on unmute.
  useEffect(
    () =>
      useAudioStore.subscribe(
        (s) => s.narrationEnabled,
        (enabled) => {
          if (!enabled) {
            queueRef.current = [];
            audioRef.current?.pause();
            playingRef.current = false;
          } else {
            playNext();
          }
        },
      ),
    [playNext],
  );

  // Ingest the feed.
  useEffect(() => {
    if (!feed) return;
    if (!initializedRef.current) {
      initializedRef.current = true;
      // Watermark at the newest message, mark all as seen (no replaying history),
      // then voice the CURRENT scene once — the most recent narration with audio —
      // so arriving at the table narrates what's on screen.
      watermarkRef.current = feed.reduce((max, m) => Math.max(max, m.createdAt), 0);
      for (const m of feed) seenRef.current.add(m.id);
      const current = feed
        .filter((m) => !!m.audioUrl)
        .sort((a, b) => b.createdAt - a.createdAt)[0];
      if (current?.audioUrl) {
        queueRef.current.push({ id: current.id, url: current.audioUrl });
        playNext();
      }
      return;
    }
    const fresh = feed
      .filter(
        (m) => !!m.audioUrl && m.createdAt > watermarkRef.current && !seenRef.current.has(m.id),
      )
      .sort((a, b) => a.createdAt - b.createdAt);
    for (const m of fresh) {
      seenRef.current.add(m.id);
      queueRef.current.push({ id: m.id, url: m.audioUrl as string });
    }
    if (fresh.length) playNext();
  }, [feed, playNext]);

  return <audio ref={audioRef} className="hidden" preload="auto" onEnded={advance} onError={advance} />;
}
