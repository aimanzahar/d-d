// Detects when GM narration DESCRIBES an ability/skill check or saving throw in
// prose. The model is supposed to surface checks via the request_player_roll tool
// (which creates the pending roll + the player's "Roll!" button); it sometimes
// forgets and just writes "X needs to make a Deception check" as narration, so no
// button ever appears. turn.ts uses this to detect that case and nudge the model
// to emit the structured call. Kept dependency-free so it's unit-testable.

// The 5e ability + skill vocabulary. A "check"/"save" governed by one of these
// (or by "DC <n>", or the literal "ability/skill check"/"saving throw") is almost
// certainly a mechanical roll request — not an incidental "check your supplies".
const SKILL_OR_ABILITY =
  "(?:strength|dexterity|constitution|intelligence|wisdom|charisma" +
  "|str|dex|con|int|wis|cha" +
  "|acrobatics|animal\\s+handling|arcana|athletics|deception|history|insight" +
  "|intimidation|investigation|medicine|nature|perception|performance|persuasion" +
  "|religion|sleight\\s+of\\s+hand|stealth|survival)";
const CHECK_TERM = "(?:check|save|saving\\s+throw)";

const CHECK_NOUN = new RegExp(
  // "Deception check", "Dexterity saving throw", "Wisdom save"
  `\\b${SKILL_OR_ABILITY}\\s+(?:ability\\s+|skill\\s+)?${CHECK_TERM}\\b` +
    // "DC 15 check", "DC 12 Stealth check"
    `|\\bDC\\s*\\d+\\b[^.?!]{0,30}?\\b${CHECK_TERM}\\b` +
    `|\\b${CHECK_TERM}\\b[^.?!]{0,30}?\\bDC\\s*\\d+\\b` +
    // bare "ability check" / "skill check" / "saving throw"
    `|\\b(?:ability|skill)\\s+${CHECK_TERM}\\b` +
    `|\\bsaving\\s+throw\\b`,
  "i",
);

export function narrationRequestsCheck(text: string): boolean {
  if (!text) return false;
  // Strip voice tags ([[Name|male|angry]] … [[/]]) and markdown so a check
  // term wrapped in **bold** or inside a quote is still seen.
  const plain = text.replace(/\[\[[^\]]*\]\]/g, "").replace(/[*_>#`~]/g, "");
  return CHECK_NOUN.test(plain);
}
