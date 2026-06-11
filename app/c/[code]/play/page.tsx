"use client";

import { CampaignGate } from "@/components/providers/CampaignGate";
import { GameScreen } from "@/components/game/GameScreen";

export default function PlayPage() {
  return (
    <CampaignGate>
      <GameScreen />
    </CampaignGate>
  );
}
