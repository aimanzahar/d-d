// Per-speaker narration voices. The GM wraps spoken dialogue in
// [[Name|gender|emotion]]"…"[[/]] tags (see prompt.ts); this module turns one GM
// message into an ordered list of parsed segments. Dependency-light on purpose
// (no convex imports): it is the single source of truth for the tag grammar +
// voice mapping, imported by both the synthesis pipeline (gm/tts.ts) and the
// finalize resolver (messages.ts), the same way feats.ts is shared (see
// docs/adr/0002). parseSegments is PURELY syntactic — it does NOT resolve a
// concrete voiceId; the finalize resolver does that with the per-campaign gender
// registry. See docs/adr/0006 and docs/adr/0007.

// The narrator (untagged prose) keeps the original preset; it is intentionally
// NOT in any pool, so an NPC never sounds exactly like the narrator.
export const NARRATOR_VOICE = "English_expressive_narrator";

export type Gender = "male" | "female" | "neutral";
export const GENDERS = new Set<Gender>(["male", "female", "neutral"]);

// Valid Minimax speech-2.8-turbo emotions (official platform docs). NOTE: "neutral"
// is NOT valid on 2.8 (third-party docs only); whisper/fluent are 2.6-only. Omitting
// emotion lets the model auto-select from the text — our fallback for untagged or
// invalid values.
export type Emotion =
  | "happy"
  | "sad"
  | "angry"
  | "fearful"
  | "disgusted"
  | "surprised"
  | "calm";
export const EMOTION_ENUM = new Set<Emotion>([
  "happy",
  "sad",
  "angry",
  "fearful",
  "disgusted",
  "surprised",
  "calm",
]);

// Curated, gender-labelled Minimax `English_*` system voices, verified against the
// System Voice ID List. An NPC maps deterministically by name into the pool matching
// its (GM-tagged) gender; unknown gender draws from the combined set. Smoke-test each
// id against the gateway before shipping; an unknown id fails its segment and falls
// back to NARRATOR_VOICE (see gm/tts.ts). See docs/adr/0007.
export const MALE_POOL = [
  "English_ManWithDeepVoice",
  "English_Trustworth_Man",
  "English_DecentYoungMan",
  "English_Diligent_Man",
  "English_Deep-VoicedGentleman",
  "English_PatientMan",
];
export const FEMALE_POOL = [
  "English_Graceful_Lady",
  "English_ConfidentWoman",
  "English_PlayfulGirl",
  "English_SereneWoman",
  "English_LovelyGirl",
  "English_radiant_girl",
];
const COMBINED_POOL = [...MALE_POOL, ...FEMALE_POOL];

// Cost/latency guardrail per message (see docs/adr/0006): bound total spoken
// characters and the number of TTS calls. Overflow merges into a narrator tail.
export const MAX_TTS_CHARS = 1800;
export const MAX_SEGMENTS = 8;

// A parsed segment: narrator (name=null) or a named speaker, plus the optional
// GM-tagged gender and validated emotion. The finalize resolver turns name+gender
// into a concrete voiceId via the per-campaign gender registry (docs/adr/0007).
export type VoiceSegment = {
  order: number;
  name: string | null;
  gender?: Gender;
  emotion?: Emotion;
  text: string;
};

// Matches a single voice tag token: [[…]] (anything up to the next "]]"). Used to
// strip tags for display and out of synthesized text. The "*" form also catches an
// empty [[]] orphan.
const VOICE_TAG_RE = /\[\[[^\]]*\]\]/g;

// A full dialogue span: [[inner]] … [[/]]. The inner is "Name|tok|tok…" (an empty
// Name, e.g. [[|angry]], is a narrator-mood span). Non-greedy body so adjacent spans
// don't merge. A [[…]] with no closing [[/]] simply isn't a span — its orphan token
// is stripped and the text falls through as narrator.
const SPAN_RE = /\[\[([^\]]+?)\]\]([\s\S]*?)\[\[\/\]\]/g;

// FNV-1a (32-bit). Stable, in-code, deterministic — the same name always maps to the
// same voice (within its gender pool) across messages and deploys.
function hashStr(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// The single canonical speaker key: lowercase, internal whitespace collapsed, ends
// trimmed. EVERY consumer (voice hash, gender registry reads/writes) MUST key off
// this so "Barkeep", "  barkeep " and "the  barkeep" never split into two voices.
export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, " ").trim();
}

export function voiceForSpeaker(name: string, gender?: Gender): string {
  const key = normalizeName(name);
  if (!key) return NARRATOR_VOICE;
  const pool = gender === "male" ? MALE_POOL : gender === "female" ? FEMALE_POOL : COMBINED_POOL;
  return pool[hashStr(key) % pool.length];
}

// Prose-based gender fallback (docs/adr/0007). The GM is told to tag |gender on a
// speaker's first line, but it often forgets; an untagged speaker would otherwise be
// hashed into the mixed pool — a coin flip that gives a narrated woman a male voice.
// When gender is unknown we scan the speaker's name plus the narration immediately
// adjacent to their line for gendered words/pronouns and pick the clear winner.
// Word-boundary + case-insensitive so "the" never matches "he", "there" never "her".
const FEMALE_WORDS = [
  "she", "her", "hers", "herself", "woman", "women", "girl", "lady", "ladies",
  "madam", "maiden", "queen", "princess", "duchess", "countess", "mistress", "dame",
  "barmaid", "priestess", "nun", "mother", "sister", "daughter", "wife", "widow",
  "aunt", "niece", "grandmother", "crone", "matron", "witch",
];
const MALE_WORDS = [
  "he", "him", "his", "himself", "man", "men", "boy", "lad", "gentleman", "sir",
  "lord", "king", "prince", "duke", "count", "master", "monk", "priest", "friar",
  "brother", "son", "husband", "uncle", "nephew", "grandfather", "fellow",
];
const FEMALE_RE = new RegExp(`\\b(?:${FEMALE_WORDS.join("|")})\\b`, "gi");
const MALE_RE = new RegExp(`\\b(?:${MALE_WORDS.join("|")})\\b`, "gi");

// Returns the dominant gender across name + adjacent narration, or undefined on a tie
// or no signal (so the caller falls back to the mixed pool — never worse than today).
// Only male/female are inferred; "neutral" stays an explicit GM choice.
export function inferGender(name: string, context = ""): Gender | undefined {
  const hay = `${name} ${context}`;
  const f = (hay.match(FEMALE_RE) ?? []).length;
  const m = (hay.match(MALE_RE) ?? []).length;
  if (f > m) return "female";
  if (m > f) return "male";
  return undefined;
}

// Parse a tag's inner string ("Name|tok|tok…") into a speaker. First field is the
// Name (empty -> narrator). Remaining tokens are classified by disjoint vocabulary:
// gender ∈ {male,female,neutral}, emotion ∈ EMOTION_ENUM; first of each class wins,
// unknown/duplicate tokens are ignored.
function parseTag(inner: string): { name: string | null; gender?: Gender; emotion?: Emotion } {
  const parts = inner.split("|");
  const rawName = (parts[0] ?? "").trim();
  const name = rawName === "" ? null : rawName;
  let gender: Gender | undefined;
  let emotion: Emotion | undefined;
  for (let i = 1; i < parts.length; i++) {
    const tok = parts[i].trim().toLowerCase();
    if (!tok) continue;
    if (gender === undefined && GENDERS.has(tok as Gender)) {
      gender = tok as Gender;
    } else if (emotion === undefined && EMOTION_ENUM.has(tok as Emotion)) {
      emotion = tok as Emotion;
    }
  }
  return { name, gender, emotion };
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

type Run = { name: string | null; gender?: Gender; emotion?: Emotion; text: string };

// Split a raw GM message into ordered parsed segments. Untagged prose = narrator;
// [[Name|gender|emotion]]"…"[[/]] = that speaker; [[|emotion]]…[[/]] = a narrator-mood
// span. Consecutive runs with the SAME (name, emotion) merge, whitespace-only drops,
// then the count/char guardrail applies (overflow tail folded into one narrator
// segment, then truncated to the char budget). An untagged or all-stripped message
// yields a single narrator segment (or none if it was empty) — the safe fallback that
// never blocks playback. Voice resolution (name+gender -> voiceId) happens later, in
// the finalize resolver, with the registry. See docs/adr/0007.
export function parseSegments(content: string): VoiceSegment[] {
  const raw: Run[] = [];
  const addNarr = (s: string) => {
    const t = forTts(s);
    if (t) raw.push({ name: null, text: t });
  };
  const addSpan = (inner: string, body: string) => {
    const t = forTts(body);
    if (!t) return;
    const { name, gender, emotion } = parseTag(inner);
    raw.push({ name, gender, emotion, text: t });
  };

  let last = 0;
  let m: RegExpExecArray | null;
  SPAN_RE.lastIndex = 0;
  while ((m = SPAN_RE.exec(content)) !== null) {
    addNarr(content.slice(last, m.index));
    addSpan(m[1], m[2]);
    last = SPAN_RE.lastIndex;
  }
  addNarr(content.slice(last));

  // Merge consecutive runs with the same speaker identity (name) AND the same
  // emotion — so adjacent narrator prose merges, but a [[|angry]] beat between two
  // plain narrations stays its own segment, and two emotions for one speaker split.
  // Merge by NAME, not by hashed voice, so two distinct NPCs are never fused.
  const merged: Run[] = [];
  for (const p of raw) {
    const prev = merged[merged.length - 1];
    if (prev && prev.name === p.name && (prev.emotion ?? null) === (p.emotion ?? null)) {
      prev.text = `${prev.text} ${p.text}`;
      if (prev.gender === undefined && p.gender !== undefined) prev.gender = p.gender;
    } else {
      merged.push({ ...p });
    }
  }

  // Count guardrail: fold the overflow tail into one (emotion-less) narrator segment.
  let capped = merged;
  if (merged.length > MAX_SEGMENTS) {
    const head = merged.slice(0, MAX_SEGMENTS - 1);
    const tail = merged
      .slice(MAX_SEGMENTS - 1)
      .map((p) => p.text)
      .join(" ")
      .trim();
    if (tail) head.push({ name: null, text: tail });
    capped = head;
  }

  // Char guardrail: keep segments until the budget is spent; truncate the one that
  // crosses it and drop the rest. Emotion/gender/name thread through unchanged.
  const out: VoiceSegment[] = [];
  let total = 0;
  for (const p of capped) {
    if (total >= MAX_TTS_CHARS) break;
    const room = MAX_TTS_CHARS - total;
    const text = p.text.length > room ? p.text.slice(0, room).trim() : p.text;
    if (!text) continue;
    out.push({ order: out.length, name: p.name, gender: p.gender, emotion: p.emotion, text });
    total += text.length;
  }
  return out;
}
