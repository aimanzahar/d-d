"use client";

import { CampaignGate } from "@/components/providers/CampaignGate";
import { LobbyScreen } from "@/components/lobby/LobbyScreen";

export default function LobbyPage() {
  return (
    <CampaignGate>
      <LobbyScreen />
    </CampaignGate>
  );
}
