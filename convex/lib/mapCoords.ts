// Deterministic fallback map coordinates for a POI with no GM-assigned position,
// so the "you are here" pin always has a stable place to render. Pure and
// synchronous (safe to call inside Convex mutations — no crypto, no Date): the
// same slug always maps to the same point, inside a safe inner band (0.15–0.85
// on both axes) so pins never clip the map's edge.

function hash(str: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(h, 33) ^ str.charCodeAt(i)) >>> 0;
  }
  return h >>> 0;
}

export function fallbackCoord(slug: string): { x: number; y: number } {
  const band = (h: number) => 0.15 + ((h % 1000) / 1000) * 0.7;
  // Two decorrelated passes (distinct seed + reversed input) so x and y don't track each other.
  return {
    x: band(hash(slug, 5381)),
    y: band(hash([...slug].reverse().join(""), 2166136261)),
  };
}
