"use client";

import { createContext, useContext } from "react";
import type { Id } from "@/convex/_generated/dataModel";

export type Session = {
  sessionToken: string;
  playerId: Id<"players">;
  nickname: string;
  isHost: boolean;
  characterId: Id<"characters"> | null;
  campaignId: Id<"campaigns">;
  inviteCode: string;
  campaignName: string;
  campaignStatus: "lobby" | "active" | "ended";
};

export const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error("useSession must be used inside <CampaignGate>");
  return session;
}
