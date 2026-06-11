// Server-authoritative dice. All randomness comes from crypto with rejection
// sampling (no modulo bias). Rolls happen inside mutations only.

export type DieRoll = {
  sides: number;
  count: number;
  results: number[];
  dropped: number[]; // discarded advantage/disadvantage die, shown dimmed
};

export type RollOutcome = {
  notation: string;
  dice: DieRoll[];
  modifier: number;
  total: number;
};

export function cryptoInt(maxExclusive: number): number {
  const buf = new Uint32Array(1);
  const limit = Math.floor(0xffffffff / maxExclusive) * maxExclusive;
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return buf[0] % maxExclusive;
  }
}

export function rollDie(sides: number): number {
  return cryptoInt(sides) + 1;
}

const NOTATION = /^\s*(\d{0,2})d(\d{1,3})\s*(?:([+-])\s*(\d{1,3}))?\s*$/i;

// Parses 'XdY+Z' (X ≤ 40, Y ≤ 100, |Z| ≤ 999). Returns null when invalid.
export function parseNotation(
  notation: string,
): { count: number; sides: number; modifier: number } | null {
  const m = NOTATION.exec(notation);
  if (!m) return null;
  const count = m[1] === "" ? 1 : parseInt(m[1], 10);
  const sides = parseInt(m[2], 10);
  const modifier = m[4] ? (m[3] === "-" ? -1 : 1) * parseInt(m[4], 10) : 0;
  if (count < 1 || count > 40 || sides < 2 || sides > 100) return null;
  return { count, sides, modifier };
}

export function rollNotation(notation: string): RollOutcome | null {
  const parsed = parseNotation(notation);
  if (!parsed) return null;
  const results = Array.from({ length: parsed.count }, () => rollDie(parsed.sides));
  return {
    notation,
    dice: [{ sides: parsed.sides, count: parsed.count, results, dropped: [] }],
    modifier: parsed.modifier,
    total: results.reduce((a, b) => a + b, 0) + parsed.modifier,
  };
}

// d20 with advantage/disadvantage: rolls two, keeps the right one, returns the
// loser in `dropped` so the 3D layer can render both dice.
export function rollD20(
  advantage: "normal" | "advantage" | "disadvantage",
  modifier: number,
): RollOutcome & { d20: number } {
  const first = rollDie(20);
  if (advantage === "normal") {
    return {
      notation: modifier >= 0 ? `1d20+${modifier}` : `1d20${modifier}`,
      dice: [{ sides: 20, count: 1, results: [first], dropped: [] }],
      modifier,
      total: first + modifier,
      d20: first,
    };
  }
  const second = rollDie(20);
  const keep = advantage === "advantage" ? Math.max(first, second) : Math.min(first, second);
  const drop = advantage === "advantage" ? Math.min(first, second) : Math.max(first, second);
  return {
    notation: `2d20${advantage === "advantage" ? "kh1" : "kl1"}${modifier >= 0 ? `+${modifier}` : modifier}`,
    dice: [{ sides: 20, count: 1, results: [keep], dropped: [drop] }],
    modifier,
    total: keep + modifier,
    d20: keep,
  };
}
