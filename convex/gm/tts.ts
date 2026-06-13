// Spoken GM narration. After a GM message finalizes (gm/turn.ts), a fire-and-
// forget action synthesizes its prose to speech via Minimax speech-2.8-turbo
// (OpenAI-compatible gateway, same key as grok/gpt-image-2), stores the mp3 in Convex
// storage, and attaches it to the message. Mirrors convex/images.ts. Non-fatal:
// the turn has already succeeded — TTS failure only drops the audio.

import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";

const TTS_MODEL = "speech-2.8-turbo";
const VOICE_ID = "English_expressive_narrator"; // a free preset narrator voice
const MAX_TTS_CHARS = 1800; // bounds latency/cost on rare huge messages

// The Minimax TTS path is gateway-native, not OpenAI-style, so it hangs off the
// gateway ROOT (the gateway origin), not the /v1 base used for chat/images.
function ttsUrl(): string {
  return (process.env.LLM_BASE_URL ?? "").replace(/\/v1\/?$/, "") + "/minimax/v1/t2a_v2";
}

// Map game state to a Minimax emotion + pacing. emotion enum:
// happy|sad|angry|fearful|disgusted|surprised|neutral|calm. Tunable.
function deriveTone(mode: string, sceneType: string): { emotion: string; speed: number } {
  if (mode === "combat") return { emotion: "angry", speed: 1.1 }; // urgent, intense
  if (["tavern", "town", "castle"].includes(sceneType)) return { emotion: "happy", speed: 1.0 };
  if (["dungeon", "cave", "swamp", "temple", "forest"].includes(sceneType))
    return { emotion: "neutral", speed: 0.95 }; // wary
  if (["ship", "mountain", "field", "road", "camp"].includes(sceneType))
    return { emotion: "calm", speed: 1.0 };
  return { emotion: "neutral", speed: 1.0 };
}

// Minimax returns audio as a HEX string (not base64 like the image endpoint).
function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const clean = hex.trim();
  const len = clean.length >> 1;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out as Uint8Array<ArrayBuffer>;
}

export const getSynthesisInput = internalQuery({
  args: { gmMessageId: v.id("messages") },
  handler: async (ctx, args) => {
    const msg = await ctx.db.get(args.gmMessageId);
    if (!msg || msg.kind !== "gm") return null;
    const campaign = await ctx.db.get(msg.campaignId);
    return {
      content: msg.content,
      mode: (campaign as any)?.mode ?? "exploration",
      sceneType: (campaign as any)?.location?.sceneType ?? "field",
    };
  },
});

export const markGenerating = internalMutation({
  args: { gmMessageId: v.id("messages") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.gmMessageId, { audioStatus: "generating" });
  },
});

export const finishAudio = internalMutation({
  args: { gmMessageId: v.id("messages"), storageId: v.id("_storage") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.gmMessageId, { audioStatus: "done", audioStorageId: args.storageId });
  },
});

// Only flips a still-pending message to failed — never clobbers a 'done' result
// (used both by the action's catch and the watchdog).
export const failAudio = internalMutation({
  args: { gmMessageId: v.id("messages") },
  handler: async (ctx, args) => {
    const msg = await ctx.db.get(args.gmMessageId);
    if (msg?.audioStatus === "generating") await ctx.db.patch(args.gmMessageId, { audioStatus: "failed" });
  },
});

export const synthesize = internalAction({
  args: { campaignId: v.id("campaigns"), gmMessageId: v.id("messages") },
  handler: async (ctx, args) => {
    const input = await ctx.runQuery(internal.gm.tts.getSynthesisInput, {
      gmMessageId: args.gmMessageId,
    });
    if (!input) return;
    const text = input.content
      .replace(/[*>#_]/g, "") // strip markdown so asterisks aren't spoken
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_TTS_CHARS);
    if (!text) return;

    await ctx.runMutation(internal.gm.tts.markGenerating, { gmMessageId: args.gmMessageId });
    // Watchdog: never leave a message stuck on 'generating' if this action dies.
    await ctx.scheduler.runAfter(5 * 60_000, internal.gm.tts.failAudio, {
      gmMessageId: args.gmMessageId,
    });

    try {
      const { emotion, speed } = deriveTone(input.mode, input.sceneType);
      const res = await fetch(ttsUrl(), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.LLM_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: TTS_MODEL,
          text,
          voice_setting: { voice_id: VOICE_ID, speed, emotion },
          audio_setting: { sample_rate: 32000, bitrate: 128000, format: "mp3" },
        }),
      });
      const json = await res.json();
      const audioHex = json?.data?.audio;
      if (json?.base_resp?.status_code !== 0 || typeof audioHex !== "string" || !audioHex) {
        throw new Error(`TTS rejected: ${JSON.stringify(json?.base_resp ?? json).slice(0, 220)}`);
      }
      const bytes = hexToBytes(audioHex);
      const storageId = await ctx.storage.store(new Blob([bytes], { type: "audio/mpeg" }));
      await ctx.runMutation(internal.gm.tts.finishAudio, {
        gmMessageId: args.gmMessageId,
        storageId,
      });
    } catch (error) {
      console.error("TTS synthesis failed:", error);
      await ctx.runMutation(internal.gm.tts.failAudio, { gmMessageId: args.gmMessageId });
    }
  },
});
