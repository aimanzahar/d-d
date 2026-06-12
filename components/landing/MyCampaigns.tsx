"use client";

import { useMutation, useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/convex/_generated/api";
import { useAccount } from "@/hooks/useAccount";
import { saveSessionToken } from "@/lib/session";
import { Button } from "@/components/ui/Button";
import { Panel } from "@/components/ui/Panel";

// The signed-in account's shelf of campaigns, most recently visited first.
// Renders nothing while signed out, loading, or when the shelf is empty.
export function MyCampaigns() {
  const router = useRouter();
  const { accountToken } = useAccount();
  const rows = useQuery(api.accounts.myCampaigns, accountToken ? { accountToken } : "skip");
  const rejoin = useMutation(api.accounts.rejoinCampaign);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleRejoin(inviteCode: string) {
    if (!accountToken) return;
    setBusy(true);
    setError(null);
    try {
      const result = await rejoin({ accountToken, inviteCode });
      saveSessionToken(result.inviteCode, result.sessionToken);
      // The lobby auto-forwards to /play once the campaign is active
      router.push(`/c/${result.inviteCode}/lobby`);
    } catch {
      setError("That table has been cleared away.");
      setBusy(false);
    }
  }

  if (!accountToken || !rows || rows.length === 0) return null;

  const sorted = [...rows].sort((a, b) => b.lastSeenAt - a.lastSeenAt);

  return (
    <Panel className="w-full max-w-4xl" innerClassName="p-6">
      <h2 className="font-display tracking-[0.2em] text-gold uppercase text-base mb-4">
        Your Campaigns
      </h2>
      <div className="divide-y divide-gold-dim/20">
        {sorted.map((row) => (
          <div key={row.inviteCode} className="flex items-center justify-between gap-4 py-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-display text-parchment">{row.campaignName}</span>
                <span
                  className={`font-display text-[0.55rem] tracking-[0.2em] uppercase border px-1.5 py-0.5 ${
                    row.campaignStatus === "active"
                      ? "text-vitality border-vitality/40"
                      : "text-gold-dim border-gold-dim/40"
                  }`}
                >
                  {row.campaignStatus === "active" ? "At the table" : "Gathering"}
                </span>
                {row.isHost && (
                  <span className="font-display text-[0.55rem] tracking-[0.2em] uppercase border border-gold/40 text-gold px-1.5 py-0.5">
                    Host
                  </span>
                )}
              </div>
              <p className="font-narrative italic text-xs text-parchment-dim mt-1 truncate">
                {row.nickname} &mdash;{" "}
                {row.characterName
                  ? `${row.characterName} (Lv ${row.characterLevel})`
                  : "no hero forged yet"}
              </p>
            </div>
            <div className="flex items-center gap-4 shrink-0">
              <span className="font-dice text-xs tracking-[0.3em] text-parchment-faint">
                {row.inviteCode}
              </span>
              <Button
                variant="gold"
                size="sm"
                disabled={busy}
                onClick={() => handleRejoin(row.inviteCode)}
              >
                Rejoin
              </Button>
            </div>
          </div>
        ))}
      </div>
      {error && (
        <p className="mt-3 font-narrative italic text-sm text-blood" role="alert">
          {error}
        </p>
      )}
    </Panel>
  );
}
