"use client";

import { useMutation, useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
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
  const depart = useMutation(api.campaigns.departCampaign);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Two-click confirm: first click arms the row, second fires; disarms after 3s
  const [confirming, setConfirming] = useState<string | null>(null);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
  }, []);

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

  async function handleDepart(inviteCode: string) {
    if (!accountToken || busy) return;
    if (confirming !== inviteCode) {
      setConfirming(inviteCode);
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
      confirmTimer.current = setTimeout(() => setConfirming(null), 3000);
      return;
    }
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    setConfirming(null);
    setBusy(true);
    setError(null);
    try {
      await depart({ accountToken, inviteCode }); // reactive query drops the row
    } catch {
      setError("The candles refused to go out. Try again.");
    } finally {
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
                      : row.campaignStatus === "ended"
                        ? "text-blood/80 border-blood/40"
                        : "text-gold-dim border-gold-dim/40"
                  }`}
                >
                  {row.campaignStatus === "active"
                    ? "At the table"
                    : row.campaignStatus === "ended"
                      ? "Tale ended"
                      : "Gathering"}
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
              <button
                type="button"
                disabled={busy}
                onClick={() => handleDepart(row.inviteCode)}
                title={
                  row.isHost
                    ? "Delete this campaign for everyone — there is no undo"
                    : "Give up your seat (and your hero) at this table"
                }
                className={`font-display text-[0.55rem] tracking-[0.2em] uppercase px-2 py-1 border cursor-pointer disabled:cursor-default ${
                  confirming === row.inviteCode
                    ? "border-blood text-blood animate-flicker"
                    : "border-blood/30 text-blood/60 hover:border-blood/70 hover:text-blood"
                }`}
              >
                {confirming === row.inviteCode
                  ? row.isHost
                    ? "Delete forever?"
                    : "Leave the table?"
                  : row.isHost
                    ? "Delete"
                    : "Leave"}
              </button>
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
