// Per-speaker narration voices. The GM wraps spoken dialogue in [[Name]]"…"[[/]]
// tags (see prompt.ts); this module turns one GM message into an ordered list of
// voiced segments. Dependency-light on purpose (no convex imports): it is the
// single source of truth for the tag grammar + voice mapping, imported by both
// the synthesis pipeline (gm/tts.ts) and the finalize hook (messages.ts), the
// same way feats.ts is shared (see docs/adr/0002). See docs/adr/0006.

// The narrator (untagged prose) keeps the original preset; it is intentionally
// NOT in the pool, so an NPC never sounds exactly like the narrator.
export const NARRATOR_VOICE = "English_expressive_narrator";

// Curated Minimax `English_*` system voices, verified against the System Voice
// ID List. NPCs are mapped here deterministically by name (no gender control —
// accepted debt, see docs/adr/0006). Smoke-test each against the gateway before
// shipping; an unknown id fails its segment and falls back to NARRATOR_VOICE.
export const VOICE_POOL = [
  "English_ManWithDeepVoice",
  "English_Trustworth_Man",
  "English_DecentYoungMan",
  "English_PassionateWarrior",
  "English_Graceful_Lady",
  "English_ConfidentWoman",
  "English_PlayfulGirl",
  "English_WiseScholar",
];

// Cost/latency guardrail per message (see docs/adr/0006): bound total spoken
// characters and the number of TTS calls. Overflow merges into a narrator tail.
export const MAX_TTS_CHARS = 1800;
export const MAX_SEGMENTS = 8;

export type VoiceSegment = { order: number; voiceId: string; text: string };

// Matches a single voice tag token: [[Name]] or [[/]] (anything up to the next
// "]]"). Used to strip tags for display and out of synthesized text.
const VOICE_TAG_RE = /\[\[[^\]]*\]\]/g;

// A full dialogue span: [[Name]] … [[/]]. Non-greedy body so adjacent spans
// don't merge. A [[Name]] with no closing [[/]] simply isn't a span — its
// orphan token is stripped and the text falls through as narrator.
const SPAN_RE = /\[\[([^\]]+?)\]\]([\s\S]*?)\[\[\/\]\]/g;

// FNV-1a (32-bit). Stable, in-code, deterministic — the same name always maps
// to the same voice across messages and deploys.
function hashStr(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function voiceForSpeaker(name: string): string {
  const key = name.trim().toLowerCase();
  if (!key) return NARRATOR_VOICE;
  return VOICE_POOL[hashStr(key) % VOICE_POOL.length];
}

// Remove voice tags but keep everything else (incl. markdown) — for the prose
// players read in the feed.
export function stripVoiceTags(s: string): string {
  return s.replace(VOICE_TAG_RE, "");
}

// TTS-ready text for one segment: drop tags, drop the markdown the model emits
// (* _ # and leading >), collapse whitespace. Mirrors the original tts.ts strip.
function forTts(s: string): string {
  return stripVoiceTags(s)
    .replace(/[*>#_]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Rewrite of the message body for the feed/transcript/memory: tags gone, prose
// (and markdown) intact. Run once at finalize.
export function cleanForDisplay(content: string): string {
  return stripVoiceTags(content);
}

// Split a raw GM message into ordered voiced segments. Untagged prose = narrator;
// [[Name]]"…"[[/]] = that speaker's voice. Consecutive same-voice runs merge,
// whitespace-only drops, then the count/char guardrail applies (overflow tail
// folded into one narrator segment, then truncated to the char budget). An
// untagged or all-stripped message yields a single narrator segment (or none if
// it was empty) — the safe fallback that never blocks playback.
export function parseSegments(content: string): VoiceSegment[] {
  const raw: { voiceId: string; text: string }[] = [];
  const addNarr = (s: string) => {
    const t = forTts(s);
    if (t) raw.push({ voiceId: NARRATOR_VOICE, text: t });
  };
  const addNamed = (name: string, s: string) => {
    const t = forTts(s);
    if (t) raw.push({ voiceId: voiceForSpeaker(name), text: t });
  };

  let last = 0;
  let m: RegExpExecArray | null;
  SPAN_RE.lastIndex = 0;
  while ((m = SPAN_RE.exec(content)) !== null) {
    addNarr(content.slice(last, m.index));
    addNamed(m[1].trim(), m[2]);
    last = SPAN_RE.lastIndex;
  }
  addNarr(content.slice(last));

  // Merge consecutive same-voice runs (adjacent narrator prose, or two NPCs that
  // happen to hash to one voice) into a single clip.
  const merged: { voiceId: string; text: string }[] = [];
  for (const p of raw) {
    const prev = merged[merged.length - 1];
    if (prev && prev.voiceId === p.voiceId) prev.text = `${prev.text} ${p.text}`;
    else merged.push({ ...p });
  }

  // Count guardrail: fold the overflow tail into one narrator segment.
  let capped = merged;
  if (merged.length > MAX_SEGMENTS) {
    const head = merged.slice(0, MAX_SEGMENTS - 1);
    const tail = merged
      .slice(MAX_SEGMENTS - 1)
      .map((p) => p.text)
      .join(" ")
      .trim();
    if (tail) head.push({ voiceId: NARRATOR_VOICE, text: tail });
    capped = head;
  }

  // Char guardrail: keep segments until the budget is spent; truncate the one
  // that crosses it and drop the rest.
  const out: VoiceSegment[] = [];
  let total = 0;
  for (const p of capped) {
    if (total >= MAX_TTS_CHARS) break;
    const room = MAX_TTS_CHARS - total;
    const text = p.text.length > room ? p.text.slice(0, room).trim() : p.text;
    if (!text) continue;
    out.push({ order: out.length, voiceId: p.voiceId, text });
    total += text.length;
  }
  return out;
}
