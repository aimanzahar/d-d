"use client";

import { useMutation, useQuery } from "convex/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/convex/_generated/api";
import { useSession } from "./useSession";

const PING_THROTTLE_MS = 1500; // at most one ping per this interval while typing
const IDLE_CLEAR_MS = 4000; // stop showing "typing" this long after the last keystroke

// Broadcasts the local player's "is typing" state and surfaces everyone else's.
export function useTyping() {
  const session = useSession();
  const ping = useMutation(api.typing.ping);
  const clear = useMutation(api.typing.clear);
  const rows = useQuery(api.typing.list, {
    sessionToken: session.sessionToken,
    campaignId: session.campaignId,
  });

  const lastPing = useRef(0);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [typers, setTypers] = useState<string[]>([]);

  // Recompute the visible typers on a timer so names fade once their TTL
  // elapses, even without a new server write. Date.now() stays in the timer
  // callback (never during render), and setState runs async (never sync in the
  // effect body) — both keep the React purity lint happy.
  useEffect(() => {
    const recompute = () => {
      const now = Date.now();
      const live = (rows ?? []).filter((r) => r.typingUntil > now).map((r) => r.characterName);
      setTypers((prev) =>
        prev.length === live.length && prev.every((n, i) => n === live[i]) ? prev : live,
      );
    };
    const t = setInterval(recompute, 250);
    return () => clearInterval(t);
  }, [rows]);

  const stopTyping = useCallback(() => {
    if (idleTimer.current) {
      clearTimeout(idleTimer.current);
      idleTimer.current = null;
    }
    lastPing.current = 0;
    void clear({ sessionToken: session.sessionToken, campaignId: session.campaignId });
  }, [clear, session.sessionToken, session.campaignId]);

  const onKeystroke = useCallback(() => {
    const now = Date.now();
    if (now - lastPing.current > PING_THROTTLE_MS) {
      lastPing.current = now;
      void ping({ sessionToken: session.sessionToken, campaignId: session.campaignId });
    }
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(stopTyping, IDLE_CLEAR_MS);
  }, [ping, stopTyping, session.sessionToken, session.campaignId]);

  // Clear my row when the composer unmounts.
  useEffect(() => () => stopTyping(), [stopTyping]);

  return { onKeystroke, stopTyping, typers };
}
