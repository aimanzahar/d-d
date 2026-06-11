"use client";

// Renderless: the only place live Convex data crosses into the zustand store
// that the 3D layer reads. Mounted once inside GameScreen.

import { useQuery } from "convex/react";
import { useEffect, useRef } from "react";
import { api } from "@/convex/_generated/api";
import { useSession } from "@/hooks/useSession";
import { useGameStore, type TokenView } from "@/stores/gameStore";

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

  const mountedAt = useRef(Date.now());

  useEffect(() => {
    if (!campaign) return;
    useGameStore
      .getState()
      .setScene(campaign.location.sceneType, campaign.mode);
  }, [campaign?.location.sceneType, campaign?.mode, campaign]);

  useEffect(() => {
    if (!combat || !party) {
      useGameStore.getState().setCombat(null);
      return;
    }
    const activeRefId = combat.initiative[combat.activeIndex]?.refId;
    const tokens: TokenView[] = [
      ...party
        .filter((c) => c.position && !c.conditions.some((x) => x.name === "dead"))
        .map((c) => ({
          id: String(c._id),
          kind: "pc" as const,
          label: c.name,
          x: c.position!.x,
          y: c.position!.y,
          hp: c.currentHp,
          maxHp: c.maxHp,
          mine: String(c._id) === String(session.characterId),
          active: String(c._id) === activeRefId,
          dead: false,
        })),
      ...combat.monsters
        .filter((m) => !m.isDead)
        .map((m) => ({
          id: String(m._id),
          kind: "monster" as const,
          label: m.label,
          x: m.position.x,
          y: m.position.y,
          hp: m.currentHp,
          maxHp: m.maxHp,
          mine: false,
          active: String(m._id) === activeRefId,
          dead: m.isDead,
        })),
    ];
    useGameStore.getState().setCombat({
      width: combat.map.width,
      height: combat.map.height,
      terrain: combat.map.terrain,
      theme: combat.map.theme,
      round: combat.round,
      tokens,
    });
  }, [combat, party, session.characterId]);

  useEffect(() => {
    if (!rolls) return;
    // Animate only rolls that landed after this client mounted (no replays)
    const fresh = rolls.filter((r) => r.at > mountedAt.current - 4000);
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
          })),
      );
    }
  }, [rolls]);

  return null;
}
