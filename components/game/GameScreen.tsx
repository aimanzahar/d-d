"use client";

import { useMutation, useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { api } from "@/convex/_generated/api";
import { useSession } from "@/hooks/useSession";
import { ActionInput } from "./ActionInput";
import { CombatHUD } from "@/components/combat/CombatHUD";
import { NarrationFeed } from "./NarrationFeed";
import { PartySidebar } from "./PartySidebar";
import { RollPrompt } from "./RollPrompt";
import { Button } from "@/components/ui/Button";

export function GameScreen() {
  const session = useSession();
  const router = useRouter();
  const campaign = useQuery(api.campaigns.get, {
    sessionToken: session.sessionToken,
    inviteCode: session.inviteCode,
  });
  const retry = useMutation(api.campaigns.retryGm);

  // Back to the lobby if the adventure hasn't started
  useEffect(() => {
    if (campaign && campaign.status === "lobby") {
      router.replace(`/c/${session.inviteCode}/lobby`);
    }
  }, [campaign, router, session.inviteCode]);

  if (!campaign) return null;

  return (
    <div className="flex-1 flex flex-col h-dvh">
      {/* Top bar */}
      <header className="flex items-center gap-4 px-5 h-14 border-b border-gold-dim/30 bg-ink-soft/70 backdrop-blur shrink-0">
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
        <PartySidebar />
        <main className="flex-1 flex flex-col min-w-0 border-x border-gold-dim/20">
          {campaign.mode === "combat" && <CombatHUD />}
          <RollPrompt />
          <NarrationFeed />
          <ActionInput gmThinking={campaign.gmStatus === "running"} />
        </main>
      </div>
    </div>
  );
}
