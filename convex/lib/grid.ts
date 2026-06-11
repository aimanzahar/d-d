// Grid combat math — pure TS, imported by both Convex functions and the
// client (no Convex dependencies). 1 cell = 5 ft. Terrain rows use:
// '.' open, '#' wall, '^' difficult, '~' water (difficult).

export type Cell = { x: number; y: number };

export const CELL_FEET = 5;

export function key(c: Cell): string {
  return `${c.x},${c.y}`;
}

export function chebyshev(a: Cell, b: Cell): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

export function distanceFeet(a: Cell, b: Cell): number {
  return chebyshev(a, b) * CELL_FEET;
}

export function terrainAt(terrain: string[], c: Cell): string {
  return terrain[c.y]?.[c.x] ?? "#";
}

function stepCost(terrain: string[], c: Cell): number {
  const t = terrainAt(terrain, c);
  if (t === "#") return Infinity;
  if (t === "^" || t === "~") return 2 * CELL_FEET; // difficult terrain
  return CELL_FEET;
}

const DIRS: Cell[] = [
  { x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 },
  { x: 1, y: 1 }, { x: 1, y: -1 }, { x: -1, y: 1 }, { x: -1, y: -1 },
];

// Dijkstra over the grid. Enemy-occupied cells block movement entirely;
// ally-occupied cells can be moved through but not ended in.
export function reachableCells(opts: {
  terrain: string[];
  width: number;
  height: number;
  start: Cell;
  budgetFeet: number;
  blockers: Set<string>; // enemies + anything impassable
  passThrough: Set<string>; // allies — traversable, not stoppable
}): Map<string, { cost: number; from: string | null }> {
  const dist = new Map<string, { cost: number; from: string | null }>();
  dist.set(key(opts.start), { cost: 0, from: null });
  const queue: { cell: Cell; cost: number }[] = [{ cell: opts.start, cost: 0 }];
  while (queue.length > 0) {
    queue.sort((a, b) => a.cost - b.cost);
    const { cell, cost } = queue.shift()!;
    if (cost > (dist.get(key(cell))?.cost ?? Infinity)) continue;
    for (const d of DIRS) {
      const next = { x: cell.x + d.x, y: cell.y + d.y };
      if (next.x < 0 || next.y < 0 || next.x >= opts.width || next.y >= opts.height) continue;
      const nk = key(next);
      if (opts.blockers.has(nk)) continue;
      const stepFeet = stepCost(opts.terrain, next);
      if (!Number.isFinite(stepFeet)) continue;
      const total = cost + stepFeet;
      if (total > opts.budgetFeet) continue;
      if (total < (dist.get(nk)?.cost ?? Infinity)) {
        dist.set(nk, { cost: total, from: key(cell) });
        queue.push({ cell: next, cost: total });
      }
    }
  }
  dist.delete(key(opts.start));
  // Can't STOP in a pass-through (ally) cell
  return dist;
}

export function endableCells(
  reach: Map<string, { cost: number; from: string | null }>,
  passThrough: Set<string>,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const [k, v] of reach) if (!passThrough.has(k)) out.set(k, v.cost);
  return out;
}

// Reconstructs the cell path to `goal` from a reachableCells result.
export function pathTo(
  reach: Map<string, { cost: number; from: string | null }>,
  start: Cell,
  goal: Cell,
): Cell[] | null {
  const goalKey = key(goal);
  if (!reach.has(goalKey)) return null;
  const path: Cell[] = [];
  let cursor: string | null = goalKey;
  while (cursor && cursor !== key(start)) {
    const [x, y] = cursor.split(",").map(Number);
    path.unshift({ x, y });
    cursor = reach.get(cursor)?.from ?? null;
  }
  return path;
}

// Enemies whose melee reach covers any cell the mover LEAVES (opportunity-
// attack detection — flagged for the GM, never auto-resolved).
export function provokedFrom(
  path: Cell[],
  start: Cell,
  enemies: { name: string; cell: Cell; reachFeet?: number }[],
): string[] {
  const cellsLeft = [start, ...path.slice(0, -1)];
  const provokers = new Set<string>();
  const destination = path[path.length - 1];
  for (const enemy of enemies) {
    const reach = Math.max(1, Math.round((enemy.reachFeet ?? 5) / CELL_FEET));
    for (const left of cellsLeft) {
      if (chebyshev(left, enemy.cell) <= reach && chebyshev(destination, enemy.cell) > reach) {
        provokers.add(enemy.name);
        break;
      }
    }
  }
  return [...provokers];
}

// Cells covered by an SRD area_of_effect at `target`, cast from `origin`.
export function aoeCells(opts: {
  shape: "sphere" | "cylinder" | "cube" | "cone" | "line";
  sizeFeet: number;
  origin: Cell;
  target: Cell;
  width: number;
  height: number;
}): Cell[] {
  const out: Cell[] = [];
  const radius = Math.round(opts.sizeFeet / CELL_FEET);
  const inBounds = (c: Cell) => c.x >= 0 && c.y >= 0 && c.x < opts.width && c.y < opts.height;

  if (opts.shape === "sphere" || opts.shape === "cylinder") {
    for (let y = opts.target.y - radius; y <= opts.target.y + radius; y++) {
      for (let x = opts.target.x - radius; x <= opts.target.x + radius; x++) {
        const c = { x, y };
        if (inBounds(c) && chebyshev(c, opts.target) <= radius) out.push(c);
      }
    }
  } else if (opts.shape === "cube") {
    const side = Math.max(1, Math.round(opts.sizeFeet / CELL_FEET));
    for (let y = opts.target.y; y < opts.target.y + side; y++) {
      for (let x = opts.target.x; x < opts.target.x + side; x++) {
        const c = { x, y };
        if (inBounds(c)) out.push(c);
      }
    }
  } else if (opts.shape === "line") {
    // Supercover walk from origin toward target, up to sizeFeet
    const steps = Math.round(opts.sizeFeet / CELL_FEET);
    const dx = opts.target.x - opts.origin.x;
    const dy = opts.target.y - opts.origin.y;
    const len = Math.max(Math.abs(dx), Math.abs(dy)) || 1;
    for (let i = 1; i <= steps; i++) {
      const c = {
        x: Math.round(opts.origin.x + (dx / len) * i),
        y: Math.round(opts.origin.y + (dy / len) * i),
      };
      if (inBounds(c)) out.push(c);
      else break;
    }
  } else if (opts.shape === "cone") {
    // 5e cone: width equals length; ±26.5° around the origin→target direction
    const lengthCells = Math.round(opts.sizeFeet / CELL_FEET);
    const angle = Math.atan2(opts.target.y - opts.origin.y, opts.target.x - opts.origin.x);
    for (let y = opts.origin.y - lengthCells; y <= opts.origin.y + lengthCells; y++) {
      for (let x = opts.origin.x - lengthCells; x <= opts.origin.x + lengthCells; x++) {
        const c = { x, y };
        if (!inBounds(c) || (c.x === opts.origin.x && c.y === opts.origin.y)) continue;
        if (chebyshev(c, opts.origin) > lengthCells) continue;
        const cellAngle = Math.atan2(c.y - opts.origin.y, c.x - opts.origin.x);
        let diff = Math.abs(cellAngle - angle);
        if (diff > Math.PI) diff = 2 * Math.PI - diff;
        if (diff <= 0.4636) out.push(c); // atan(0.5) ≈ 26.57°
      }
    }
  }
  return out;
}
