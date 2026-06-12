"use client";

import { useMutation, useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import { useEffect, useRef, useState } from "react";
import { api } from "@/convex/_generated/api";
import { useSession } from "@/hooks/useSession";
import { useTyping } from "@/hooks/useTyping";
import { Button } from "@/components/ui/Button";
import { useComposerStore } from "@/stores/composerStore";

const DOWN_CONDITIONS = ["dead", "unconscious", "stable"];

export function ActionInput({ gmThinking }: { gmThinking: boolean }) {
  const session = useSession();
  const send = useMutation(api.messages.sendPlayerAction);
  const requestImage = useMutation(api.images.requestSceneImage);
  const { onKeystroke, stopTyping, typers } = useTyping();
  const [text, setText] = useState("");
  const [ooc, setOoc] = useState(false);
  const [busy, setBusy] = useState(false);
  const [imageNote, setImageNote] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Live state that decides whether the player may take an ACTION right now.
  const combat = useQuery(api.combat.get, {
    sessionToken: session.sessionToken,
    campaignId: session.campaignId,
  });
  const me = useQuery(api.characters.getMine, { sessionToken: session.sessionToken });
  const campaign = useQuery(api.campaigns.get, {
    sessionToken: session.sessionToken,
    inviteCode: session.inviteCode,
  });

  const incapacitated = !!me?.conditions.some((c) => DOWN_CONDITIONS.includes(c.name));
  const inCombat = campaign?.mode === "combat";
  const active = combat?.initiative[combat.activeIndex];
  const notMyTurn = inCombat && !!combat && active?.refId !== String(session.characterId);
  // When down or off-turn, the composer is locked to table talk (the server
  // coerces it too — this just makes the UI honest about it).
  const forcedOoc = incapacitated || notMyTurn;
  const effectiveOoc = forcedOoc || ooc;

  // Soft spotlight (exploration only) — a cue, never a block.
  const spotlight = campaign?.spotlightCharacterId ?? null;
  const mySpotlight = spotlight === session.characterId;
  const showSpotlightHint = campaign?.mode === "exploration" && !effectiveOoc && !incapacitated;

  // Seed from the composer store (inventory clicks): replace when empty, append when typed.
  useEffect(
    () =>
      useComposerStore.subscribe(({ seed }) => {
        if (seed === null) return;
        setText((t) => (t.trim() ? `${t} ${seed}` : seed));
        textareaRef.current?.focus();
        useComposerStore.getState().clearSeed();
      }),
    [],
  );

  // The latest image's reactive status drives the persistent "forming" line.
  const latest = useQuery(api.images.latest, {
    sessionToken: session.sessionToken,
    campaignId: session.campaignId,
  });
  const forming = latest?.status === "generating";
  const prevStatus = useRef<string | null>(null);
  useEffect(() => {
    if (prevStatus.current === "generating" && latest?.status === "failed") {
      setImageNote("The vision slipped away.");
      setTimeout(() => setImageNote(null), 5000);
    }
    prevStatus.current = latest?.status ?? null;
  }, [latest?.status]);

  async function handleVisualize() {
    setImageNote(null);
    try {
      await requestImage({ sessionToken: session.sessionToken, campaignId: session.campaignId });
      // success: the reactive `forming` line takes over
    } catch (e) {
      const code = e instanceof ConvexError ? (e.data as { code?: string })?.code : null;
      setImageNote(
        code === "image_cooldown"
          ? "The scrying pool needs a moment — try again shortly."
          : code === "image_in_flight"
            ? "A vision is already forming."
            : code === "image_daily_cap"
              ? "The scrying pool has run dry for today."
              : "The vision slipped away.",
      );
      setTimeout(() => setImageNote(null), 5000);
    }
  }

  async function handleSend() {
    const content = text.trim();
    if (!content) return;
    setBusy(true);
    try {
      await send({
        sessionToken: session.sessionToken,
        campaignId: session.campaignId,
        content,
        ooc: effectiveOoc,
      });
      setText("");
      stopTyping();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border-t border-gold-dim/30 bg-ink-soft/80 backdrop-blur px-4 py-3">
      {gmThinking && (
        <p className="font-narrative italic text-xs text-arcane-soft mb-2 animate-flicker">
          The Game Master is weaving the tale…
        </p>
      )}
      {typers.length > 0 && (
        <p className="font-narrative italic text-xs text-arcane-soft mb-2 animate-flicker">
          {typers.length === 1
            ? `${typers[0]} is typing…`
            : typers.length === 2
              ? `${typers[0]} and ${typers[1]} are typing…`
              : `${typers.length} heroes are typing…`}
        </p>
      )}
      {forming && (
        <p className="font-narrative italic text-xs text-arcane-soft mb-2 animate-flicker">
          The vision is forming…
        </p>
      )}
      {!forming && imageNote && (
        <p className="font-narrative italic text-xs text-arcane-soft mb-2">{imageNote}</p>
      )}
      {forcedOoc && (
        <p className="font-narrative italic text-xs text-blood/90 mb-2">
          {incapacitated
            ? "Your hero has fallen — you can only speak to the table."
            : "It's not your turn — only table talk reaches the others now."}
        </p>
      )}
      {showSpotlightHint && (
        <p className="font-narrative italic text-xs text-gold-dim mb-2">
          {spotlight == null
            ? "Anyone can act."
            : mySpotlight
              ? "✦ It's your turn to act."
              : "Another hero is in the spotlight — you can still act."}
        </p>
      )}
      <div className="flex gap-3 items-end">
        <textarea
          ref={textareaRef}
          className="field-arcane flex-1 px-3.5 py-2.5 text-[0.95rem] resize-none leading-snug"
          rows={2}
          placeholder={
            effectiveOoc
              ? "Say something to the table (the GM won't react)…"
              : "What do you do? (e.g. I check the cart for tracks…)"
          }
          value={text}
          maxLength={2000}
          onChange={(e) => {
            setText(e.target.value);
            onKeystroke();
          }}
          onBlur={stopTyping}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void handleSend();
            }
          }}
        />
        <div className="flex flex-col gap-1.5">
          <div className="flex gap-1.5">
            <button
              disabled={forcedOoc}
              className={`font-display text-[0.55rem] tracking-[0.2em] uppercase px-2 py-1 border ${
                effectiveOoc
                  ? "border-arcane text-arcane-soft"
                  : "border-gold-dim/40 text-parchment-faint hover:border-gold-dim"
              } ${forcedOoc ? "opacity-60 cursor-default" : "cursor-pointer"}`}
              onClick={() => !forcedOoc && setOoc(!ooc)}
              title={
                forcedOoc
                  ? incapacitated
                    ? "Your hero is down — table talk only"
                    : "Wait for your turn — table talk only"
                  : "Table talk doesn't trigger the GM"
              }
            >
              {effectiveOoc ? "table talk" : "action"}
            </button>
            <button
              className="font-display text-[0.55rem] tracking-[0.2em] uppercase px-2 py-1 border border-arcane/40 text-arcane-soft hover:border-arcane cursor-pointer"
              onClick={handleVisualize}
              title="Conjure an image of the current scene"
            >
              ✦ visualize
            </button>
          </div>
          <Button variant="ember" size="md" disabled={busy || !text.trim()} onClick={handleSend}>
            Send
          </Button>
        </div>
      </div>
    </div>
  );
}
