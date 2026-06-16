// Spoken GM narration. After a GM message finalizes (gm/turn.ts), finalize splits
// the prose into ordered voiced segments (narrator + tagged NPC dialogue, see
// gm/voices.ts + docs/adr/0006) and this fire-and-forget action synthesizes each
// segment to its own clip via Minimax speech-2.8-turbo (OpenAI-compatible gateway, same
// key as grok/qwen-image), stores the mp3 in Convex storage, and attaches it to
// the segment. Non-fatal: the turn has already succeeded — TTS failure only drops
// that clip; the client plays whatever clips are ready, in order.

import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import type { ActionCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { NARRATOR_VOICE } from "./voices";

const TTS_MODEL = "speech-2.8-turbo";

// The Minimax TTS path is gateway-native, not OpenAI-style, so it hangs off the
// gateway ROOT (the gateway origin), not the /v1 base used for chat/images.
function ttsUrl(): string {
  return (process.env.LLM_BASE_URL ?? "").replace(/\/v1\/?$/, "") + "/minimax/v1/t2a_v2";
}

// Scene-derived PACING (speed only). Per-line emotion now rides on each segment
// (GM-tagged, validated, stored at finalize — docs/adr/0007), so the old
// scene->emotion map is gone; it emitted "neutral"/"calm", and "neutral" isn't a
// valid speech-2.8 emotion. A segment with no emotion sends none, letting Minimax
// auto-select from the text.
function derivePacing(mode: string, sceneType: string): { speed: number } {
  if (mode === "combat") return { speed: 1.1 }; // urgent, intense
  if (["dungeon", "cave", "swamp", "temple", "forest"].includes(sceneType))
    return { speed: 0.95 }; // wary
  return { speed: 1.0 };
}

// Minimax returns audio as a HEX string (not base64 like the image endpoint).
function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const clean = hex.trim();
  const len = clean.length >> 1;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out as Uint8Array<ArrayBuffer>;
}

// Synthesize one line in one voice and store it; throws on a rejected request
// (e.g. an unknown voice_id), so the caller can retry with the narrator voice.
async function synthOne(
  ctx: ActionCtx,
  text: string,
  voiceId: string,
  speed: number,
  emotion?: string,
): Promise<Id<"_storage">> {
  // Omit emotion entirely when absent — Minimax then auto-selects from the text.
  // Never send "" (not in the enum; the gateway would reject the whole segment).
  const voice_setting: Record<string, unknown> = { voice_id: voiceId, speed };
  if (emotion) voice_setting.emotion = emotion;
  const res = await fetch(ttsUrl(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.LLM_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: TTS_MODEL,
      text,
      voice_setting,
      audio_setting: { sample_rate: 32000, bitrate: 128000, format: "mp3" },
    }),
  });
  const json = await res.json();
  const audioHex = json?.data?.audio;
  if (json?.base_resp?.status_code !== 0 || typeof audioHex !== "string" || !audioHex) {
    throw new Error(`TTS rejected: ${JSON.stringify(json?.base_resp ?? json).slice(0, 220)}`);
  }
  const bytes = hexToBytes(audioHex);
  return await ctx.storage.store(new Blob([bytes], { type: "audio/mpeg" }));
}

export const getSynthesisInput = internalQuery({
  args: { gmMessageId: v.id("messages") },
  handler: async (ctx, args) => {
    const msg = await ctx.db.get(args.gmMessageId);
    if (!msg || msg.kind !== "gm" || !msg.audioSegments?.length) return null;
    const campaign = await ctx.db.get(msg.campaignId);
    return {
      segments: [...msg.audioSegments].sort((a, b) => a.order - b.order),
      mode: (campaign as any)?.mode ?? "exploration",
      sceneType: (campaign as any)?.location?.sceneType ?? "field",
    };
  },
});

// --- per-segment status patches (read-modify-write the array) --------------

export const markSegmentGenerating = internalMutation({
  args: { gmMessageId: v.id("messages"), order: v.number() },
  handler: async (ctx, args) => {
    const msg = await ctx.db.get(args.gmMessageId);
    if (!msg?.audioSegments) return;
    const audioSegments = msg.audioSegments.map((s) =>
      s.order === args.order ? { ...s, audioStatus: "generating" as const } : s,
    );
    await ctx.db.patch(args.gmMessageId, { audioSegments });
  },
});

export const finishSegmentAudio = internalMutation({
  args: { gmMessageId: v.id("messages"), order: v.number(), storageId: v.id("_storage") },
  handler: async (ctx, args) => {
    const msg = await ctx.db.get(args.gmMessageId);
    if (!msg?.audioSegments) return;
    const audioSegments = msg.audioSegments.map((s) =>
      s.order === args.order
        ? { ...s, audioStatus: "done" as const, audioStorageId: args.storageId }
        : s,
    );
    await ctx.db.patch(args.gmMessageId, { audioSegments });
  },
});

export const failSegment = internalMutation({
  args: { gmMessageId: v.id("messages"), order: v.number() },
  handler: async (ctx, args) => {
    const msg = await ctx.db.get(args.gmMessageId);
    if (!msg?.audioSegments) return;
    const audioSegments = msg.audioSegments.map((s) =>
      s.order === args.order && s.audioStatus !== "done"
        ? { ...s, audioStatus: "failed" as const }
        : s,
    );
    await ctx.db.patch(args.gmMessageId, { audioSegments });
  },
});

// Watchdog: never leave segments stuck on pending/generating if the action dies.
export const failPendingSegments = internalMutation({
  args: { gmMessageId: v.id("messages") },
  handler: async (ctx, args) => {
    const msg = await ctx.db.get(args.gmMessageId);
    if (!msg?.audioSegments) return;
    const audioSegments = msg.audioSegments.map((s) =>
      s.audioStatus === "pending" || s.audioStatus === "generating"
        ? { ...s, audioStatus: "failed" as const }
        : s,
    );
    await ctx.db.patch(args.gmMessageId, { audioSegments });
  },
});

export const synthesize = internalAction({
  args: { campaignId: v.id("campaigns"), gmMessageId: v.id("messages") },
  handler: async (ctx, args) => {
    const input = await ctx.runQuery(internal.gm.tts.getSynthesisInput, {
      gmMessageId: args.gmMessageId,
    });
    if (!input || input.segments.length === 0) return;

    // Watchdog: flip any segment still pending/generating to failed after 5 min,
    // so a dead action never leaves the player waiting on a clip that won't come.
    await ctx.scheduler.runAfter(5 * 60_000, internal.gm.tts.failPendingSegments, {
      gmMessageId: args.gmMessageId,
    });

    const { speed } = derivePacing(input.mode, input.sceneType);

    // Sequential: clip 0 lands first so playback can start while the rest
    // synthesize. Order matters; concurrency would only add gateway burst.
    for (const seg of input.segments) {
      if (seg.audioStatus === "done") continue;
      const emotion = seg.emotion; // per-line; undefined -> Minimax auto-selects
      await ctx.runMutation(internal.gm.tts.markSegmentGenerating, {
        gmMessageId: args.gmMessageId,
        order: seg.order,
      });
      try {
        let storageId: Id<"_storage">;
        try {
          storageId = await synthOne(ctx, seg.text, seg.voiceId, speed, emotion);
        } catch (error) {
          // Unknown/rejected voice_id (or a transient hiccup): fall back to the
          // narrator voice so the line is still spoken (same emotion).
          console.error(
            `TTS segment ${seg.order} voice ${seg.voiceId} failed; retrying narrator:`,
            error,
          );
          storageId = await synthOne(ctx, seg.text, NARRATOR_VOICE, speed, emotion);
        }
        await ctx.runMutation(internal.gm.tts.finishSegmentAudio, {
          gmMessageId: args.gmMessageId,
          order: seg.order,
          storageId,
        });
      } catch (error) {
        console.error(`TTS segment ${seg.order} synthesis failed:`, error);
        await ctx.runMutation(internal.gm.tts.failSegment, {
          gmMessageId: args.gmMessageId,
          order: seg.order,
        });
      }
    }
  },
});
