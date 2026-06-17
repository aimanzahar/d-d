import { describe, it, expect } from "vitest";
import {
  parseSegments,
  voiceForSpeaker,
  normalizeName,
  inferGender,
  MALE_POOL,
  FEMALE_POOL,
  EMOTION_ENUM,
  MAX_SEGMENTS,
  MAX_TTS_CHARS,
  NARRATOR_VOICE,
} from "./voices";

// parseSegments is now a PURE syntactic parser: it does NOT resolve voiceIds (the
// finalize resolver does that with the gender registry). It returns ordered
// segments carrying { order, name|null, gender?, emotion?, text }. name===null is
// the narrator. See docs/adr/0007.

const names = (segs: ReturnType<typeof parseSegments>) => segs.map((s) => s.name);

describe("parseSegments — basic structure", () => {
  it("plain narration is a single narrator segment with no emotion", () => {
    const segs = parseSegments("The hall is cold and silent.");
    expect(segs).toHaveLength(1);
    expect(segs[0].name).toBeNull();
    expect(segs[0].emotion).toBeUndefined();
    expect(segs[0].text).toBe("The hall is cold and silent.");
    expect(segs[0].order).toBe(0);
  });

  it("splits a named span into narrator / speaker / narrator and strips markdown", () => {
    const segs = parseSegments('**Borin** says [[Borin]]"hi"[[/]] then leaves.');
    expect(names(segs)).toEqual([null, "Borin", null]);
    expect(segs[0].text).toBe("Borin says");
    expect(segs[1].text).toContain("hi");
    expect(segs[2].text).toBe("then leaves.");
    expect(segs.map((s) => s.order)).toEqual([0, 1, 2]);
  });

  it("empty / whitespace-only message yields zero segments", () => {
    expect(parseSegments("")).toEqual([]);
    expect(parseSegments("   \n  ")).toEqual([]);
  });

  it("a whitespace-only span is dropped", () => {
    expect(parseSegments("[[Borin]]   [[/]]")).toEqual([]);
  });

  it("an unclosed tag degrades to narrator (tag token stripped)", () => {
    const segs = parseSegments('[[Borin]]"hi there"');
    expect(segs).toHaveLength(1);
    expect(segs[0].name).toBeNull();
    expect(segs[0].text).toContain("hi there");
  });
});

describe("parseSegments — token classification (order-free, disjoint vocabularies)", () => {
  it("classifies gender and emotion regardless of order", () => {
    const a = parseSegments('[[Borin|angry|male]]"x"[[/]]')[0];
    const b = parseSegments('[[Borin|male|angry]]"x"[[/]]')[0];
    expect(a.name).toBe("Borin");
    expect(a.gender).toBe("male");
    expect(a.emotion).toBe("angry");
    expect(b.gender).toBe("male");
    expect(b.emotion).toBe("angry");
  });

  it("rejects an invalid emotion (not in the Minimax enum)", () => {
    const seg = parseSegments('[[Borin|excited]]"x"[[/]]')[0];
    expect(seg.name).toBe("Borin");
    expect(seg.emotion).toBeUndefined();
    expect(seg.gender).toBeUndefined();
  });

  it("classifies 'neutral' as a GENDER, never as an emotion", () => {
    const seg = parseSegments('[[Borin|neutral]]"x"[[/]]')[0];
    expect(seg.gender).toBe("neutral");
    expect(seg.emotion).toBeUndefined();
  });

  it("first gender token and first emotion token win", () => {
    const g = parseSegments('[[Borin|male|female]]"x"[[/]]')[0];
    expect(g.gender).toBe("male");
    const e = parseSegments('[[Borin|happy|sad]]"x"[[/]]')[0];
    expect(e.emotion).toBe("happy");
  });

  it("treats the first field as the Name even when it looks like a token", () => {
    const seg = parseSegments('[[Happy|female]]"x"[[/]]')[0];
    expect(seg.name).toBe("Happy");
    expect(seg.gender).toBe("female");
  });

  it("ignores unknown trailing tokens", () => {
    const seg = parseSegments('[[Borin|male|loud|xyz]]"x"[[/]]')[0];
    expect(seg.gender).toBe("male");
    expect(seg.emotion).toBeUndefined();
  });
});

describe("parseSegments — narrator mood span [[|emotion]]", () => {
  it("an empty-name span is a narrator segment carrying that emotion (NOT dropped)", () => {
    const segs = parseSegments("[[|angry]]The door bursts open.[[/]]");
    expect(segs).toHaveLength(1);
    expect(segs[0].name).toBeNull();
    expect(segs[0].emotion).toBe("angry");
    expect(segs[0].text).toBe("The door bursts open.");
  });

  it("a narrator-mood span does NOT merge into surrounding plain narration", () => {
    const segs = parseSegments("Cold wind. [[|angry]]The door slams.[[/]] Silence falls.");
    expect(names(segs)).toEqual([null, null, null]);
    expect(segs.map((s) => s.emotion)).toEqual([undefined, "angry", undefined]);
    expect(segs[0].text).toBe("Cold wind.");
    expect(segs[1].text).toBe("The door slams.");
    expect(segs[2].text).toBe("Silence falls.");
  });
});

describe("parseSegments — merge by (name, emotion)", () => {
  it("merges adjacent same-name, same-emotion runs", () => {
    const segs = parseSegments('[[Borin]]"a"[[/]] [[Borin]]"b"[[/]]');
    expect(segs).toHaveLength(1);
    expect(segs[0].name).toBe("Borin");
    expect(segs[0].text).toBe('"a" "b"');
  });

  it("does NOT merge same-name runs with different emotions", () => {
    const segs = parseSegments('[[Borin|happy]]"a"[[/]] [[Borin|sad]]"b"[[/]]');
    expect(segs).toHaveLength(2);
    expect(segs[0].emotion).toBe("happy");
    expect(segs[1].emotion).toBe("sad");
  });

  it("never merges two different speakers", () => {
    const segs = parseSegments('[[Ann]]"a"[[/]] [[Bob]]"b"[[/]]');
    expect(names(segs)).toEqual(["Ann", "Bob"]);
  });
});

describe("parseSegments — guardrails thread emotion through", () => {
  it("keeps head emotions and folds the overflow tail into a plain narrator segment", () => {
    const valid = [...EMOTION_ENUM];
    // 10 distinct speakers, each with a valid emotion -> exceeds MAX_SEGMENTS (8).
    const content = Array.from({ length: 10 }, (_, i) => {
      const emo = valid[i % valid.length];
      return `[[NPC${i}|${emo}]]"line ${i}"[[/]]`;
    }).join(" ");
    const segs = parseSegments(content);
    expect(segs).toHaveLength(MAX_SEGMENTS);
    // first MAX_SEGMENTS-1 keep their (valid) emotion
    for (let i = 0; i < MAX_SEGMENTS - 1; i++) {
      expect(segs[i].emotion).toBe(valid[i % valid.length]);
    }
    // folded tail is narrator, no emotion
    const tail = segs[MAX_SEGMENTS - 1];
    expect(tail.name).toBeNull();
    expect(tail.emotion).toBeUndefined();
  });

  it("a truncated segment still carries its emotion", () => {
    const head = "a".repeat(1000); // narrator, no emotion
    const body = "b".repeat(1000);
    const segs = parseSegments(`${head} [[Borin|angry]]"${body}"[[/]]`);
    expect(segs).toHaveLength(2);
    expect(segs[0].text.length).toBe(1000);
    expect(segs[1].emotion).toBe("angry");
    // total char budget respected
    expect(segs[0].text.length + segs[1].text.length).toBeLessThanOrEqual(MAX_TTS_CHARS);
    expect(segs[1].text.length).toBeLessThan(1000); // got truncated
  });
});

describe("voiceForSpeaker — gendered pools, deterministic", () => {
  it("female names map into the FEMALE_POOL", () => {
    const v = voiceForSpeaker("Maela", "female");
    expect(FEMALE_POOL).toContain(v);
    expect(MALE_POOL).not.toContain(v);
  });

  it("male names map into the MALE_POOL", () => {
    const v = voiceForSpeaker("Borin", "male");
    expect(MALE_POOL).toContain(v);
    expect(FEMALE_POOL).not.toContain(v);
  });

  it("unknown gender draws from the combined pool", () => {
    const v = voiceForSpeaker("Stranger", undefined);
    expect([...MALE_POOL, ...FEMALE_POOL]).toContain(v);
  });

  it("is deterministic and normalizes the name key", () => {
    expect(voiceForSpeaker("Borin", "male")).toBe(voiceForSpeaker("  borin ", "male"));
  });

  it("never returns the narrator voice for a named speaker", () => {
    expect(voiceForSpeaker("Borin", "male")).not.toBe(NARRATOR_VOICE);
    expect(voiceForSpeaker("Maela", "female")).not.toBe(NARRATOR_VOICE);
  });
});

describe("normalizeName — one canonical key", () => {
  it("lowercases, trims, and collapses internal whitespace", () => {
    expect(normalizeName("Barkeep")).toBe("barkeep");
    expect(normalizeName("  barkeep ")).toBe("barkeep");
    expect(normalizeName("The  Barkeep")).toBe("the barkeep");
    expect(normalizeName("Sir\tRobert\nthe  Bold")).toBe("sir robert the bold");
  });

  it("gives the same voice regardless of spacing (the divergent-voice bug)", () => {
    expect(voiceForSpeaker("Sir Robert", "male")).toBe(voiceForSpeaker("Sir  Robert ", "male"));
  });
});

describe("inferGender — prose-based fallback", () => {
  it("infers female from she/her/woman cues (the barkeep case)", () => {
    expect(
      inferGender("Barkeep", "a wiry woman jerks her chin toward the shelf. she says, voice low."),
    ).toBe("female");
  });

  it("infers male from he/him/sir cues", () => {
    expect(inferGender("Watchman", "the guard draws his cudgel; he barks at the half-elf, sir.")).toBe(
      "male",
    );
  });

  it("reads a gendered word in the speaker's own name", () => {
    expect(inferGender("Lady Maela", "")).toBe("female");
    expect(inferGender("Lord Borin", "")).toBe("male");
  });

  it("returns undefined with no signal (falls back to the mixed pool)", () => {
    expect(inferGender("Hooded Stranger", "the figure slides a notice across the table.")).toBeUndefined();
  });

  it("returns undefined on a tie so a wrong guess never wins", () => {
    expect(inferGender("Twins", "he and she speak as one.")).toBeUndefined();
  });

  it("does not match substrings (the/there must not read as he/her)", () => {
    expect(inferGender("Voice", "there is something in the air over there.")).toBeUndefined();
  });
});
