"use client";

import { animate, stagger } from "animejs";
import { useMutation, useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/convex/_generated/api";
import { useAccount } from "@/hooks/useAccount";
import { useAnimeScope } from "@/hooks/useAnimeScope";
import { getSessionToken, saveSessionToken } from "@/lib/session";
import { AuthCard } from "@/components/landing/AuthCard";
import { Button } from "@/components/ui/Button";
import { Label, TextInput } from "@/components/ui/Field";
import { OrnateRule } from "@/components/ui/OrnateRule";
import { Panel } from "@/components/ui/Panel";

const ERRORS: Record<string, string> = {
  campaign_not_found: "No table answers to that code.",
  campaign_started: "That party has already set out — the gate is closed.",
  campaign_full: "The table is full.",
  nickname_taken: "Someone at that table already bears this name.",
  not_a_member: "This table holds no seat in your name.",
  invalid_account: "Your ledger entry has expired — sign in again.",
};

export default function JoinPage() {
  const params = useParams<{ code: string }>();
  const router = useRouter();
  const code = (params.code ?? "").toUpperCase();
  const join = useMutation(api.campaigns.join);
  const rejoin = useMutation(api.accounts.rejoinCampaign);

  const { accountToken } = useAccount();
  // Does this account already hold a seat here? (skip until signed in)
  const mine = useQuery(
    api.accounts.playerInCampaign,
    typeof accountToken === "string" ? { accountToken, inviteCode: code } : "skip",
  );

  const [nickname, setNickname] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Already have a seat? Straight to the lobby.
  useEffect(() => {
    if (getSessionToken(code)) router.replace(`/c/${code}/lobby`);
  }, [code, router]);

  // hydrating | signed-out | rejoin | join — the rise animation replays per phase
  const phase =
    accountToken === undefined || (accountToken && mine === undefined)
      ? "hydrating"
      : accountToken === null
        ? "signed-out"
        : mine
          ? "rejoin"
          : "join";

  const root = useAnimeScope<HTMLDivElement>(() => {
    animate(".join-rise", {
      opacity: [0, 1],
      translateY: [16, 0],
      duration: 650,
      delay: stagger(100),
      ease: "out(2)",
    });
  }, [phase]);

  async function handleJoin() {
    if (typeof accountToken !== "string") return;
    setBusy(true);
    setError(null);
    try {
      const result = await join({ inviteCode: code, nickname, accountToken });
      saveSessionToken(result.inviteCode, result.sessionToken);
      router.push(`/c/${result.inviteCode}/lobby`);
    } catch (e) {
      const errCode =
        e instanceof ConvexError ? (e.data as { code?: string })?.code : undefined;
      setError((errCode && ERRORS[errCode]) ?? "The weave faltered. Try again.");
      setBusy(false);
    }
  }

  async function handleRejoin() {
    if (typeof accountToken !== "string") return;
    setBusy(true);
    setError(null);
    try {
      const result = await rejoin({ accountToken, inviteCode: code });
      saveSessionToken(result.inviteCode, result.sessionToken);
      router.replace(`/c/${code}/lobby`);
    } catch (e) {
      const errCode =
        e instanceof ConvexError ? (e.data as { code?: string })?.code : undefined;
      setError((errCode && ERRORS[errCode]) ?? "The weave faltered. Try again.");
      setBusy(false);
    }
  }

  if (phase === "hydrating") return null;

  return (
    <div ref={root} className="flex-1 flex flex-col items-center justify-center px-6">
      <p className="join-rise font-display text-[0.65rem] tracking-[0.45em] text-gold-dim uppercase mb-4 opacity-0">
        You have been summoned
      </p>
      <p className="join-rise font-dice text-3xl tracking-[0.5em] gold-text mb-3 opacity-0">{code}</p>
      <div className="join-rise w-48 mb-10 opacity-0">
        <OrnateRule />
      </div>

      {phase === "signed-out" && (
        <>
          <p className="join-rise font-narrative italic text-parchment-dim mb-6 opacity-0">
            Sign in to take your seat at this table.
          </p>
          <AuthCard className="join-rise w-full max-w-md opacity-0" />
        </>
      )}

      {phase === "rejoin" && mine && (
        <Panel className="join-rise w-full max-w-md opacity-0" innerClassName="p-7 text-center">
          <p className="font-display text-[0.65rem] tracking-[0.45em] text-gold-dim uppercase mb-3">
            Welcome back
          </p>
          <p className="font-narrative italic text-xl text-parchment">{mine.nickname}</p>
          {mine.characterName && (
            <p className="mt-1 font-narrative italic text-sm text-parchment-dim">
              bearing the mantle of {mine.characterName}
            </p>
          )}
          <Button
            variant="ember"
            size="lg"
            className="w-full mt-6"
            disabled={busy}
            onClick={handleRejoin}
          >
            Return to the table
          </Button>
          {error && (
            <p className="mt-4 text-blood font-narrative italic text-sm" role="alert">
              {error}
            </p>
          )}
        </Panel>
      )}

      {phase === "join" && (
        <Panel className="join-rise w-full max-w-md opacity-0" innerClassName="p-7">
          <label className="block mb-5">
            <Label>Your name</Label>
            <TextInput
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              placeholder="What the table will call you"
              maxLength={24}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter" && nickname.trim() && !busy) void handleJoin();
              }}
            />
          </label>
          <Button
            variant="ember"
            size="lg"
            className="w-full"
            disabled={busy || !nickname.trim()}
            onClick={handleJoin}
          >
            Take your seat
          </Button>
          {error && (
            <p className="mt-4 text-blood font-narrative italic text-sm" role="alert">
              {error}
            </p>
          )}
        </Panel>
      )}
    </div>
  );
}
