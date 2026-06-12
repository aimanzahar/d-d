"use client";

import { animate, stagger, utils } from "animejs";
import { useMutation } from "convex/react";
import { ConvexError } from "convex/values";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/convex/_generated/api";
import { useAccount } from "@/hooks/useAccount";
import { useAnimeScope } from "@/hooks/useAnimeScope";
import { withBasePath } from "@/lib/basePath";
import { saveSessionToken } from "@/lib/session";
import { AuthCard } from "@/components/landing/AuthCard";
import { MyCampaigns } from "@/components/landing/MyCampaigns";
import { Button } from "@/components/ui/Button";
import { Label, TextArea, TextInput } from "@/components/ui/Field";
import { OrnateRule } from "@/components/ui/OrnateRule";
import { Panel } from "@/components/ui/Panel";

const ERRORS: Record<string, string> = {
  missing_fields: "Every hero needs a name. Fill in the blanks.",
  campaign_not_found: "No table answers to that code.",
  campaign_started: "That party has already set out — the gate is closed.",
  campaign_full: "The table is full. Six adventurers is a crowd already.",
  nickname_taken: "Someone at that table already bears this name.",
  invalid_account: "Your ledger entry has expired — sign in again.",
};

function errorMessage(e: unknown): string {
  if (e instanceof ConvexError) {
    const code = (e.data as { code?: string })?.code;
    if (code && ERRORS[code]) return ERRORS[code];
  }
  return "The weave faltered. Try again.";
}

export function LandingScreen() {
  const router = useRouter();
  const { accountToken, me, signOut } = useAccount();
  const create = useMutation(api.campaigns.create);
  const join = useMutation(api.campaigns.join);

  const [campaignName, setCampaignName] = useState("");
  const [hostName, setHostName] = useState("");
  const [premise, setPremise] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [joinName, setJoinName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const root = useAnimeScope<HTMLDivElement>(() => {
    // Title chars rise out of blur, staggered from center
    animate(".hero-char", {
      opacity: [0, 1],
      translateY: [26, 0],
      filter: ["blur(10px)", "blur(0px)"],
      duration: 900,
      delay: stagger(55, { from: "center" }),
      ease: "out(3)",
    });
    animate(".hero-rise", {
      opacity: [0, 1],
      translateY: [18, 0],
      duration: 700,
      delay: stagger(110, { start: 500 }),
      ease: "out(2)",
    });
    // Slow-rising embers, randomized per-particle, looping forever
    utils.$(".ember-mote").forEach((el) => {
      const drift = utils.random(-60, 60);
      const dur = utils.random(7000, 14000);
      animate(el, {
        translateY: [`0px`, `-${utils.random(380, 720)}px`],
        translateX: [`0px`, `${drift}px`],
        opacity: [
          { to: [0, utils.random(0.35, 0.8)], duration: dur * 0.2 },
          { to: 0, duration: dur * 0.8 },
        ],
        scale: [utils.random(0.6, 1.3), 0.2],
        duration: dur,
        loop: true,
        delay: utils.random(0, 9000),
        ease: "linear",
      });
    });
  });

  async function handleCreate() {
    if (!accountToken) return; // unreachable: the form only renders signed-in
    setBusy(true);
    setError(null);
    try {
      const result = await create({
        name: campaignName,
        nickname: hostName,
        premise,
        accountToken,
      });
      saveSessionToken(result.inviteCode, result.sessionToken);
      router.push(`/c/${result.inviteCode}/lobby`);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  async function handleJoin() {
    if (!accountToken) return; // unreachable: the form only renders signed-in
    setBusy(true);
    setError(null);
    try {
      const result = await join({
        inviteCode: joinCode,
        nickname: joinName,
        accountToken,
      });
      saveSessionToken(result.inviteCode, result.sessionToken);
      router.push(`/c/${result.inviteCode}/lobby`);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  const title = "EMBERQUILL";

  return (
    <div ref={root} className="relative flex-1 flex flex-col px-6">
      {/* Decorative layers clipped on their own so the page itself can still
          grow and scroll when a short viewport can't fit the forms */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none" aria-hidden>
        {/* hero art backdrop, masked into the ink */}
        <div
          className="absolute inset-0 opacity-40"
          style={{
            backgroundImage: `url(${withBasePath("/brand/hero.jpg")})`,
            backgroundSize: "cover",
            backgroundPosition: "center 30%",
            maskImage:
              "radial-gradient(95% 80% at 50% 35%, black 30%, transparent 78%)",
            WebkitMaskImage:
              "radial-gradient(95% 80% at 50% 35%, black 30%, transparent 78%)",
          }}
        />
        {/* rising embers */}
        <div className="absolute inset-x-0 bottom-0 h-[55vh]">
          {Array.from({ length: 20 }).map((_, i) => (
            <span
              key={i}
              className="ember-mote absolute bottom-0 w-[3px] h-[3px] rounded-full opacity-0"
              style={{
                left: `${4 + (i * 92) / 20 + (i % 3) * 1.5}%`,
                background: i % 4 === 0 ? "var(--color-gold-bright)" : "var(--color-ember-bright)",
                boxShadow: "0 0 6px currentColor",
              }}
            />
          ))}
        </div>
      </div>

      {/* Account chip — pinned outside the centered column so it never
          disturbs the hero rhythm. Nothing while hydrating or signed out. */}
      {me && (
        <div className="absolute top-4 right-4 z-10 flex items-center gap-3">
          <span className="font-display text-[0.6rem] tracking-[0.2em] uppercase text-parchment-faint">
            signed in as {me?.name}
          </span>
          <button
            type="button"
            onClick={signOut}
            className="font-display text-[0.6rem] tracking-[0.2em] uppercase text-gold-dim hover:text-gold transition-colors cursor-pointer"
          >
            Sign out
          </button>
        </div>
      )}

      <div className="relative flex-1 flex flex-col items-center justify-center py-6 w-full">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={withBasePath("/brand/logo-512.png")}
          alt="Emberquill emblem — a quill crossed with a d20"
          className="hero-rise relative w-24 h-24 sm:w-28 sm:h-28 mb-3 opacity-0 rounded-full shadow-[0_0_48px_rgba(232,114,42,0.25)]"
        />
        <p className="hero-rise relative font-display text-[0.7rem] tracking-[0.5em] text-gold-dim uppercase mb-4 opacity-0">
          An AI Game Master awaits
        </p>

        <h1 className="font-display font-800 text-5xl sm:text-7xl md:text-8xl leading-none mb-5 select-none">
          {/* gold-text sits on each span: background-clip:text can't reach
              through the inline-block char boxes the animation needs */}
          {title.split("").map((ch, i) => (
            <span key={i} className="hero-char gold-text inline-block opacity-0">
              {ch}
            </span>
          ))}
        </h1>

        <div className="hero-rise w-64 opacity-0">
          <OrnateRule />
        </div>

        <p className="hero-rise font-narrative italic text-lg sm:text-xl text-parchment-dim mt-5 mb-8 max-w-xl text-center opacity-0">
          Gather your companions. The quill writes the world, the dice decide your place in it
          &mdash; and the Game Master never sleeps.
        </p>

        {/* Auth state hydrates after mount, so none of these blocks exist
            during the hero-rise entrance pass — they render plainly (no
            hero-rise/opacity-0, which would leave them stuck invisible). */}
        {accountToken === undefined ? null : accountToken === null ? (
          <AuthCard />
        ) : (
          <div className="w-full flex flex-col items-center gap-6">
            <MyCampaigns />

            <div className="grid md:grid-cols-2 gap-6 w-full max-w-4xl">
              {/* Forge a campaign */}
              <Panel innerClassName="p-7">
                <h2 className="font-display text-base tracking-[0.2em] text-gold mb-6 uppercase">
                  Forge a Campaign
                </h2>
                <div className="space-y-4">
                  <label className="block">
                    <Label>Campaign name</Label>
                    <TextInput
                      value={campaignName}
                      onChange={(e) => setCampaignName(e.target.value)}
                      placeholder="The Ashes of Veldrenmoor"
                      maxLength={60}
                    />
                  </label>
                  <label className="block">
                    <Label>Your name</Label>
                    <TextInput
                      value={hostName}
                      onChange={(e) => setHostName(e.target.value)}
                      placeholder="What the table calls you"
                      maxLength={24}
                    />
                  </label>
                  <label className="block">
                    <Label>The premise — seed for your Game Master</Label>
                    <TextArea
                      rows={4}
                      value={premise}
                      onChange={(e) => setPremise(e.target.value)}
                      placeholder="A mining town has gone silent beneath a red comet. The last caravan returned empty, horses still in harness…"
                      maxLength={2000}
                    />
                  </label>
                  <Button
                    variant="ember"
                    size="lg"
                    className="w-full"
                    disabled={busy || !campaignName.trim() || !hostName.trim() || !premise.trim()}
                    onClick={handleCreate}
                  >
                    Light the candles
                  </Button>
                </div>
              </Panel>

              {/* Join by code */}
              <Panel innerClassName="p-7 flex flex-col">
                <h2 className="font-display text-base tracking-[0.2em] text-gold mb-6 uppercase">
                  Join by Code
                </h2>
                <div className="space-y-4 flex-1">
                  <label className="block">
                    <Label>Invite code</Label>
                    <TextInput
                      value={joinCode}
                      onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                      placeholder="KQ7M2X"
                      maxLength={6}
                      className="font-dice tracking-[0.45em] text-center text-lg uppercase"
                    />
                  </label>
                  <label className="block">
                    <Label>Your name</Label>
                    <TextInput
                      value={joinName}
                      onChange={(e) => setJoinName(e.target.value)}
                      placeholder="What the table will call you"
                      maxLength={24}
                    />
                  </label>
                </div>
                <p className="font-narrative italic text-sm text-parchment-faint my-5">
                  Six letters from a friend are all it takes to pull up a chair.
                </p>
                <Button
                  variant="gold"
                  size="lg"
                  className="w-full"
                  disabled={busy || joinCode.trim().length !== 6 || !joinName.trim()}
                  onClick={handleJoin}
                >
                  Take your seat
                </Button>
              </Panel>
            </div>
          </div>
        )}

        {error && (
          <p className="mt-6 text-blood font-narrative italic text-base" role="alert">
            {error}
          </p>
        )}
      </div>

      <p className="relative text-center text-[0.65rem] text-parchment-faint/70 py-3">
        Includes material from the System Reference Document 5.1 by Wizards of the Coast LLC,
        licensed under CC-BY-4.0.
      </p>
    </div>
  );
}
