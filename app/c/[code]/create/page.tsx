"use client";

import { CampaignGate } from "@/components/providers/CampaignGate";
import { CreateScreen } from "@/components/creation/CreateScreen";

export default function CreatePage() {
  return (
    <CampaignGate>
      <CreateScreen />
    </CampaignGate>
  );
}
