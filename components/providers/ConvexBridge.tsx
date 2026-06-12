"use client";

// Renderless: the only place live Convex data crosses into the zustand store
// that the 3D layer reads. Mounted once inside GameScreen.
//
// World snapshots are SYNCED TO THE DICE: while roll animations are queued
// (or a death animation is holding), combat/scene updates buffer in refs and
// drain when playback catches up — so a kill never vanishes a token (or the
// whole map) before its dice have landed.

import { useQuery } from "convex/react";
import { useEffect, useRef } from "react";
import { api } from "@/convex/_generated/api";
import { useSession } from "@/hooks/useSession";
import { useGameStore, type CombatView, type TokenView } from "@/stores/gameStore";

// Upper bound on the token death animation in Tokens.tsx
// (~0.5s topple + ~1s sink + margin).
const DEATH_HOLD_MS = 1700;

export function ConvexBridge() {
  const session = useSession();
  const campaign = useQuery(api.campaigns.get, {
    sessionToken: session.sessionToken,
    inviteCode: session.inviteCode,
  });
  const combat = useQuery(api.combat.get, {
    sessionToken: session.sessionToken,
    campaignId: session.campaignId,
  });
  const party = useQuery(api.characters.getParty, {
    sessionToken: session.sessionToken,
    campaignId: session.campaignId,
  });
  const rolls = useQuery(api.dice.recentRolls, {
    sessionToken: session.sessionToken,
    campaignId: session.campaignId,
  });

  // Stamped in an effect (not the ref initializer) so render stays pure.
  const mountedAt = useRef<number | null>(null);
  useEffect(() => {
    mountedAt.current ??= Date.now();
  }, []);

  // ---- deferral state (refs only — closure-safe in the mount-once drain) ----
  const pendingCombats = useRef<Array<CombatView | null>>([]);
  const pendingScene = useRef<{ sceneType: string; mode: "exploration" | "combat" } | null>(null);
  const holdUntil = useRef(0);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const applyCombat = (snap: CombatView | null) => {
    const current = useGameStore.getState().combat;
    if (snap && current) {
      // A token newly marked dead starts its topple — hold map/scene teardown
      // until the animation can finish.
      const wasDead = new Set(current.tokens.filter((t) => t.dead).map((t) => t.id));
      if (snap.tokens.some((t) => t.dead && !wasDead.has(t.id))) {
        holdUntil.current = Date.now() + DEATH_HOLD_MS;
      }
    }
    useGameStore.getState().setCombat(snap);
  };

  const drain = () => {
    if (holdTimer.current) {
      clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
    // Dice still animating — the queue subscription re-runs us on empty.
    if (useGameStore.getState().diceQueue.length > 0) return;
    while (pendingCombats.current.length > 0) {
      const next = pendingCombats.current[0];
      // Map teardown waits out a running death animation; live snapshots
      // (corpse still included, dead: true) apply straight through.
      if (next === null && Date.now() < holdUntil.current) {
        holdTimer.current = setTimeout(drain, holdUntil.current - Date.now() + 30);
        return;
      }
      pendingCombats.current.shift();
      applyCombat(next);
    }
    if (pendingScene.current) {
      if (Date.now() < holdUntil.current) {
        holdTimer.current = setTimeout(drain, holdUntil.current - Date.now() + 30);
        return;
      }
      const scene = pendingScene.current;
      pendingScene.current = null;
      useGameStore.getState().setScene(scene.sceneType, scene.mode);
    }
  };

  // Defer only while something is on screen — on a fresh mount recentRolls
  // replays rolls from the last 4s, and deferring then would blank the map
  // during hydration (and delay the combat-entrance under initiative dice).
  const deferring = () => {
    const s = useGameStore.getState();
    return (
      s.combat !== null &&
      (s.diceQueue.length > 0 ||
        pendingCombats.current.length > 0 ||
        Date.now() < holdUntil.current)
    );
  };

  // ORDER IS LOAD-BEARING: this effect must run BEFORE the scene/combat
  // effects below. A kill arrives in ONE Convex transition (rolls + combat +
  // party), and the deferral gates read diceQueue — the dice must enqueue
  // first within the same commit. Effects run in declaration order, and the
  // guarantee only holds while all four useQuery calls live in this component.
  useEffect(() => {
    if (!rolls) return;
    // Animate only rolls that landed after this client mounted (no replays)
    const mounted = mountedAt.current ?? Date.now();
    const fresh = rolls.filter((r) => r.at > mounted - 4000);
    if (fresh.length > 0) {
      useGameStore.getState().enqueueDice(
        fresh
          .slice()
          .reverse()
          .map((r) => ({
            rollId: r.rollId,
            actorName: r.actorName,
            purpose: r.purpose,
            dice: r.dice,
            total: r.total,
            crit: r.crit,
            at: r.at,
          })),
      );
    }
  }, [rolls]);

  useEffect(() => {
    if (!campaign) return;
    const next = { sceneType: campaign.location.sceneType, mode: campaign.mode };
    if (deferring()) {
      pendingScene.current = next; // latest wins
      drain(); // covers holds that begin while the dice queue is already empty
    } else {
      useGameStore.getState().setScene(next.sceneType, next.mode);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaign?.location.sceneType, campaign?.mode, campaign]);

  useEffect(() => {
    let snap: CombatView | null = null;
    if (combat && party) {
      const activeRefId = combat.initiative[combat.activeIndex]?.refId;
      const tokens: TokenView[] = [
        ...party
          .filter((c) => c.position)
          .map((c) => {
            const dead = c.conditions.some((x) => x.name === "dead");
            return {
              id: String(c._id),
              kind: "pc" as const,
              label: c.name,
              x: c.position!.x,
              y: c.position!.y,
              hp: c.currentHp,
              maxHp: c.maxHp,
              mine: String(c._id) === String(session.characterId),
              active: String(c._id) === activeRefId && !dead,
              dead,
            };
          }),
        ...combat.monsters.map((m) => ({
          id: String(m._id),
          kind: "monster" as const,
          label: m.label,
          x: m.position.x,
          y: m.position.y,
          hp: m.currentHp,
          maxHp: m.maxHp,
          mine: false,
          active: String(m._id) === activeRefId && !m.isDead,
          dead: m.isDead,
        })),
      ];
      snap = {
        width: combat.map.width,
        height: combat.map.height,
        terrain: combat.map.terrain,
        theme: combat.map.theme,
        round: combat.round,
        tokens,
      };
    }
    if (deferring()) {
      pendingCombats.current.push(snap);
      drain();
    } else {
      applyCombat(snap);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [combat, party, session.characterId]);

  // Drain when the dice playback runs dry. Mount-once; drain/applyCombat only
  // touch refs and getState, so the first render's closures stay valid.
  useEffect(() => {
    const unsub = useGameStore.subscribe(
      (s) => s.diceQueue.length === 0,
      (empty) => {
        if (empty) drain();
      },
    );
    return () => {
      unsub();
      if (holdTimer.current) clearTimeout(holdTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}
