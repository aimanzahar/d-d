"use client";

import { useMutation } from "convex/react";
import { ConvexError } from "convex/values";
import { useState } from "react";
import { api } from "@/convex/_generated/api";
import { useSession } from "@/hooks/useSession";
import { Button } from "@/components/ui/Button";

export function ActionInput({ gmThinking }: { gmThinking: boolean }) {
  const session = useSession();
  const send = useMutation(api.messages.sendPlayerAction);
  const requestImage = useMutation(api.images.requestSceneImage);
  const [text, setText] = useState("");
  const [ooc, setOoc] = useState(false);
  const [busy, setBusy] = useState(false);
  const [imageNote, setImageNote] = useState<string | null>(null);

  async function handleVisualize() {
    setImageNote(null);
    try {
      await requestImage({ sessionToken: session.sessionToken, campaignId: session.campaignId });
      setImageNote("The vision is forming…");
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
    }
    setTimeout(() => setImageNote(null), 5000);
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
        ooc,
      });
      setText("");
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
      {imageNote && (
        <p className="font-narrative italic text-xs text-arcane-soft mb-2">{imageNote}</p>
      )}
      <div className="flex gap-3 items-end">
        <textarea
          className="field-arcane flex-1 px-3.5 py-2.5 text-[0.95rem] resize-none leading-snug"
          rows={2}
          placeholder={
            ooc
              ? "Say something to the table (the GM won't react)…"
              : "What do you do? (e.g. I check the cart for tracks…)"
          }
          value={text}
          maxLength={2000}
          onChange={(e) => setText(e.target.value)}
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
              className={`font-display text-[0.55rem] tracking-[0.2em] uppercase px-2 py-1 border cursor-pointer ${
                ooc
                  ? "border-arcane text-arcane-soft"
                  : "border-gold-dim/40 text-parchment-faint hover:border-gold-dim"
              }`}
              onClick={() => setOoc(!ooc)}
              title="Table talk doesn't trigger the GM"
            >
              {ooc ? "table talk" : "action"}
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
