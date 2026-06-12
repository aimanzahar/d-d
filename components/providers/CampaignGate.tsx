"use client";

import { useQuery } from "convex/react";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import { api } from "@/convex/_generated/api";
import { SessionContext, type Session } from "@/hooks/useSession";
import { getSessionToken } from "@/lib/session";

function Splash() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-8">
      <div className="relative w-24 h-24" aria-hidden>
        {/* slow counter-rotating rune rings */}
        <svg className="absolute inset-0 animate-spin [animation-duration:14s]" viewBox="0 0 100 100">
          <circle cx="50" cy="50" r="46" fill="none" stroke="var(--color-gold-dim)" strokeWidth="1" strokeDasharray="4 7" opacity="0.7" />
        </svg>
        <svg className="absolute inset-0 animate-spin [animation-duration:9s] [animation-direction:reverse]" viewBox="0 0 100 100">
          <circle cx="50" cy="50" r="34" fill="none" stroke="var(--color-arcane)" strokeWidth="1" strokeDasharray="2 9" opacity="0.5" />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="w-2 h-2 rotate-45 bg-ember animate-ember-pulse" />
        </div>
      </div>
      <p className="font-display text-xs tracking-[0.4em] uppercase text-parchment-dim animate-flicker">
        Consulting the ledger
      </p>
    </div>
  );
}

// The stored token only changes via this tab's own join/leave navigations,
// so the session-token "store" never pushes updates.
const subscribeNever = () => () => {};

export function CampaignGate({ children }: { children: ReactNode }) {
  const params = useParams<{ code: string }>();
  const router = useRouter();
  const code = (params.code ?? "").toUpperCase();

  // undefined = server snapshot (localStorage unreadable); null = no token stored
  const token = useSyncExternalStore<string | null | undefined>(
    subscribeNever,
    () => getSessionToken(code),
    () => undefined,
  );

  const me = useQuery(api.players.resume, token ? { sessionToken: token } : "skip");

  const invalid =
    token === null || (me !== undefined && (me === null || me.inviteCode !== code));

  useEffect(() => {
    if (invalid) router.replace(`/c/${code}/join`);
  }, [invalid, router, code]);

  if (token === undefined || (token && me === undefined) || invalid) return <Splash />;

  const session: Session = {
    sessionToken: token!,
    playerId: me!.playerId,
    nickname: me!.nickname,
    isHost: me!.isHost,
    characterId: me!.characterId,
    campaignId: me!.campaignId,
    inviteCode: me!.inviteCode,
    campaignName: me!.campaignName,
    campaignStatus: me!.campaignStatus,
  };

  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
}
