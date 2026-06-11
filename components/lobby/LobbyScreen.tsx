"use client";

import usePresence from "@convex-dev/presence/react";
import { animate, stagger } from "animejs";
import { useMutation, useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useAnimeScope } from "@/hooks/useAnimeScope";
import { useSession } from "@/hooks/useSession";
import { Button } from "@/components/ui/Button";
import { OrnateRule } from "@/components/ui/OrnateRule";
import { Panel } from "@/components/ui/Panel";

const MAX_PLAYERS = 6;

function InviteCodeCard({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Panel className="relative overflow-hidden" innerClassName="code-shimmer relative px-8 py-5 flex flex-col items-center gap-1.5">
      <span className="font-display text-[0.6rem] tracking-[0.35em] uppercase text-gold-dim">
        Summoning code
      </span>
      <button
        className="font-dice text-4xl tracking-[0.45em] gold-text cursor-pointer pl-2"
        title="Copy invite"
        onClick={() => {
          void navigator.clipboard.writeText(
            `${window.location.origin}/c/${code}/join`,
          );
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        }}
      >
        {code}
      </button>
      <span className="font-narrative italic text-xs text-parchment-faint h-4">
        {copied ? "Invitation copied to the winds…" : "Click to copy the invite link"}
      </span>
    </Panel>
  );
}

export function LobbyScreen() {
  const session = useSession();
  const router = useRouter();
  const players = useQuery(api.players.list, {
    sessionToken: session.sessionToken,
    campaignId: session.campaignId,
  });
  const reissue = useMutation(api.campaigns.reissueToken);
  const presenceState = usePresence(
    api.presence,
    session.campaignId,
    session.playerId,
  );
  const online = new Map(
    (presenceState ?? []).map((p) => [p.userId, p.online] as const),
  );

  const [reissuedFor, setReissuedFor] = useState<{ playerId: string; url: string } | null>(null);

  const root = useAnimeScope<HTMLDivElement>(() => {
    animate(".lobby-rise", {
      opacity: [0, 1],
      translateY: [14, 0],
      duration: 600,
      delay: stagger(90),
      ease: "out(2)",
    });
  });

  // Pop newly-joined players in
  const seenIds = useRef(new Set<string>());
  useEffect(() => {
    if (!players) return;
    const fresh = players.filter((p) => !seenIds.current.has(p.playerId));
    for (const p of fresh) seenIds.current.add(p.playerId);
    if (fresh.length > 0 && seenIds.current.size > fresh.length) {
      animate(
        fresh.map((p) => `[data-player="${p.playerId}"]`).join(", "),
        { scale: [0.92, 1], opacity: [0, 1], duration: 450, ease: "out(3)" },
      );
    }
  }, [players]);

  async function handleReissue(playerId: string) {
    const result = await reissue({
      sessionToken: session.sessionToken,
      campaignId: session.campaignId,
      playerId: playerId as Id<"players">,
    });
    const url = `${window.location.origin}/c/${session.inviteCode}/restore?t=${result.sessionToken}`;
    void navigator.clipboard.writeText(url);
    setReissuedFor({ playerId, url });
    setTimeout(() => setReissuedFor(null), 5000);
  }

  const everyoneReady =
    (players?.length ?? 0) >= 1 && (players ?? []).every((p) => p.character !== null);

  return (
    <div ref={root} className="flex-1 flex flex-col items-center px-6 py-12 gap-8 max-w-3xl mx-auto w-full">
      <header className="lobby-rise text-center opacity-0">
        <p className="font-display text-[0.6rem] tracking-[0.4em] uppercase text-gold-dim mb-2">
          The party gathers
        </p>
        <h1 className="font-display text-3xl sm:text-4xl gold-text">{session.campaignName}</h1>
      </header>

      <div className="lobby-rise opacity-0">
        <InviteCodeCard code={session.inviteCode} />
      </div>

      <div className="lobby-rise w-full opacity-0">
        <OrnateRule className="mb-6" />
        <ul className="space-y-3">
          {(players ?? []).map((p) => (
            <li key={p.playerId} data-player={p.playerId}>
              <Panel innerClassName="px-5 py-4 flex items-center gap-4">
                {/* presence dot */}
                <span
                  className={`w-2 h-2 rounded-full shrink-0 ${
                    online.get(p.playerId)
                      ? "bg-vitality shadow-[0_0_8px_rgba(63,158,99,0.8)]"
                      : "bg-parchment-faint/40"
                  }`}
                  title={online.get(p.playerId) ? "At the table" : "Away"}
                />
                <div className="flex-1 min-w-0">
                  <p className="font-display text-sm tracking-wider text-parchment truncate">
                    {p.nickname}
                    {p.isHost && (
                      <span className="ml-2 text-gold text-xs" title="Host">
                        ♛
                      </span>
                    )}
                    {p.isMe && (
                      <span className="ml-2 text-[0.6rem] tracking-[0.25em] uppercase text-parchment-faint">
                        you
                      </span>
                    )}
                  </p>
                  <p className="font-narrative italic text-sm text-parchment-dim truncate">
                    {p.character
                      ? `${p.character.name} — level ${p.character.level}`
                      : "No hero forged yet"}
                  </p>
                </div>
                {p.isMe && (
                  <Button
                    variant={p.character ? "ghost" : "ember"}
                    size="sm"
                    onClick={() => router.push(`/c/${session.inviteCode}/create`)}
                  >
                    {p.character ? "Re-forge" : "Forge your hero"}
                  </Button>
                )}
                {session.isHost && !p.isMe && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void handleReissue(p.playerId)}
                    title="Copy a recovery link for a player who lost their seat"
                  >
                    {reissuedFor?.playerId === p.playerId ? "Link copied ✓" : "Reissue invite"}
                  </Button>
                )}
              </Panel>
            </li>
          ))}
          {Array.from({ length: Math.max(0, MAX_PLAYERS - (players?.length ?? 0)) }).map(
            (_, i) => (
              <li key={`empty-${i}`}>
                <div className="border border-dashed border-gold-dim/25 px-5 py-4 text-center">
                  <span className="font-narrative italic text-sm text-parchment-faint/60">
                    An empty chair waits…
                  </span>
                </div>
              </li>
            ),
          )}
        </ul>
      </div>

      {session.isHost && (
        <div className="lobby-rise flex flex-col items-center gap-2 opacity-0">
          <Button variant="ember" size="lg" disabled={!everyoneReady} title={everyoneReady ? undefined : "Every hero must be forged before the tale begins"}>
            Begin the adventure
          </Button>
          {!everyoneReady && (
            <p className="font-narrative italic text-xs text-parchment-faint">
              Every seated player needs a hero before the candles are lit.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
