"use client";

import { useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { api } from "@/convex/_generated/api";
import { usePanelHeight } from "@/hooks/usePanelHeight";
import { useSession } from "@/hooks/useSession";
import { ActionInput } from "./ActionInput";
import { CombatHUD } from "@/components/combat/CombatHUD";
import { DiceRollerHost } from "./DiceRollerHost";
import { NarrationFeed } from "./NarrationFeed";
import { PartySidebar } from "./PartySidebar";
import { RollPrompt } from "./RollPrompt";
import { ConvexBridge } from "@/components/providers/ConvexBridge";
import { StageCanvasLazy } from "@/components/three/StageCanvas.lazy";
import { BattleMap3D } from "@/components/three/battle";

// Owns the resize state so pointer-rate drag updates re-render only the
// panel, never the canvas/header/sidebar subtrees.
function ResizableChatPanel({ gmThinking }: { gmThinking: boolean }) {
  const { panelHeight, gripProps } = usePanelHeight();
  return (
    <div className="pointer-events-auto mx-3 mb-3 panel-notch">
      <div
        className="panel-notch-inner flex flex-col"
        // CSS max as instant backstop while the resize listener re-clamps
        style={{ height: panelHeight, maxHeight: "calc(100dvh - 240px)" }}
      >
        {/* drag grip — resize the panel from its top edge */}
        <div
          {...gripProps}
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize chat panel"
          className="flex justify-center items-center w-full py-1.5 cursor-row-resize select-none touch-none shrink-0"
        >
          <div className="w-12 h-1 rounded-full bg-gold-dim/50 hover:bg-gold-dim transition-colors" />
        </div>
        <NarrationFeed />
        <ActionInput gmThinking={gmThinking} />
      </div>
    </div>
  );
}

export function GameScreen() {
  const session = useSession();
  const router = useRouter();
  const campaign = useQuery(api.campaigns.get, {
    sessionToken: session.sessionToken,
    inviteCode: session.inviteCode,
  });

  useEffect(() => {
    if (campaign && campaign.status === "lobby") {
      router.replace(`/c/${session.inviteCode}/lobby`);
    }
  }, [campaign, router, session.inviteCode]);

  if (!campaign) return null;

  return (
    <div className="relative h-dvh overflow-hidden">
      <ConvexBridge />

      {/* The living world: ambient scene + tactical battlefield (z-0) */}
      <StageCanvasLazy>
        <BattleMap3D />
      </StageCanvasLazy>

      {/* 3D dice land above everything */}
      <DiceRollerHost />

      {/* UI overlay — pointer-events pass through to the canvas except panels */}
      <div className="absolute inset-0 z-10 flex flex-col pointer-events-none">
        <header className="pointer-events-auto flex items-center gap-3 px-4 h-12 border-b border-gold-dim/30 bg-ink-soft/70 backdrop-blur shrink-0">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/logo-96.png" alt="" className="w-7 h-7 rounded-full" aria-hidden />
          <h1 className="font-display text-sm tracking-[0.15em] text-gold truncate">
            {campaign.name}
          </h1>
          <span className="h-4 w-px bg-gold-dim/40" aria-hidden />
          <p className="font-narrative italic text-sm text-parchment-dim truncate flex-1">
            {campaign.location.name}
          </p>
          <span className="font-dice text-[0.65rem] tracking-[0.3em] text-parchment-faint">
            {session.inviteCode}
          </span>
        </header>

        <div className="flex flex-1 min-h-0">
          <div className="pointer-events-auto h-full bg-ink-soft/40 backdrop-blur-sm">
            <PartySidebar />
          </div>

          <main className="flex-1 flex flex-col min-w-0">
            {campaign.mode === "combat" && <CombatHUD />}
            <div className="pointer-events-auto">
              <RollPrompt />
            </div>

            {/* transparent battlefield window — clicks reach the canvas */}
            <div className="flex-1 min-h-[120px]" />

            <ResizableChatPanel gmThinking={campaign.gmStatus === "running"} />
          </main>
        </div>
      </div>
    </div>
  );
}
