"use client";

// Spoken GM narration playback. Singleton mounted once in GameScreen. Subscribes
// to the narration-audio feed and plays GM clips through one <audio> element, in
// order (queue, never overlapping). Each message is an ordered list of voiced
// segments (narrator + tagged NPC dialogue, see docs/adr/0006); they play in
// order, and segments enqueue as they finish synthesizing so playback starts on
// the first clip without waiting for the whole message. On arrival it voices the
// CURRENT scene once, then every new narration as it lands. Respects the
// per-player mute toggle and unlocks autoplay on the first user gesture (browsers
// block audio until then).

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
  // Each queue item is one voiced segment, keyed `${messageId}:${order}`.
  const queueRef = useRef<{ key: string; url: string }[]>([]);
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

  // Ingest the feed. Unified path: enqueue any ready segment whose message is at
  // or after the watermark and hasn't been queued yet, in chronological → order
  // sequence. Within a message we stop at the first not-yet-ready segment so a
  // later clip never plays before an earlier one.
  useEffect(() => {
    if (!feed) return;
    if (!initializedRef.current) {
      initializedRef.current = true;
      // Watermark at the newest message that already has any audio; seed every
      // older message's segments as seen so history never replays. The newest-
      // with-audio message stays unseeded, so the CURRENT scene voices once and
      // its later segments still enqueue as they synthesize.
      const audioTimes = feed
        .filter((m) => m.segments.some((s) => !!s.audioUrl))
        .map((m) => m.createdAt);
      watermarkRef.current = audioTimes.length ? Math.max(...audioTimes) : 0;
      for (const m of feed) {
        if (m.createdAt < watermarkRef.current) {
          for (const s of m.segments) seenRef.current.add(`${m.id}:${s.order}`);
        }
      }
    }
    const toAdd: { key: string; url: string }[] = [];
    for (const m of [...feed].sort((a, b) => a.createdAt - b.createdAt)) {
      if (m.createdAt < watermarkRef.current) continue; // history
      for (const s of [...m.segments].sort((a, b) => a.order - b.order)) {
        const key = `${m.id}:${s.order}`;
        if (seenRef.current.has(key)) continue;
        if (!s.audioUrl) break; // keep order: wait for this clip before later ones
        seenRef.current.add(key);
        toAdd.push({ key, url: s.audioUrl });
      }
    }
    for (const item of toAdd) queueRef.current.push(item);
    if (toAdd.length) playNext();
  }, [feed, playNext]);

  return <audio ref={audioRef} className="hidden" preload="auto" onEnded={advance} onError={advance} />;
}
