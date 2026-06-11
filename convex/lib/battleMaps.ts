// Hand-authored battle map presets. The GM picks a preset by key (or the
// engine matches the current sceneType) — the LLM never authors raw terrain.
// '.' open · '#' wall/blocker · '^' difficult · '~' water

export type BattleMapPreset = {
  key: string;
  width: number;
  height: number;
  terrain: string[];
  theme: string; // sceneType
  playerArea: { x: number; y: number };
  enemyArea: { x: number; y: number };
};

const M = (s: string) => s.trim().split("\n").map((r) => r.trim());

export const BATTLE_MAPS: Record<string, BattleMapPreset> = {
  forest_clearing: {
    key: "forest_clearing",
    width: 16,
    height: 12,
    theme: "forest",
    playerArea: { x: 2, y: 9 },
    enemyArea: { x: 12, y: 2 },
    terrain: M(`
      ....#..........#
      .#....^^....#...
      ...^^.^^........
      ..........^#....
      .#..............
      ......~~~.......
      .....~~~~~..^...
      ......~~....##..
      .^..............
      ....#...^^......
      ..........#.....
      .....#..........
    `),
  },
  dungeon_chamber: {
    key: "dungeon_chamber",
    width: 14,
    height: 12,
    theme: "dungeon",
    playerArea: { x: 2, y: 9 },
    enemyArea: { x: 11, y: 2 },
    terrain: M(`
      ##############
      #....#.......#
      #....#...##..#
      #.........#..#
      #..##........#
      #..##....#####
      #........#...#
      #.^^.........#
      ####.....##..#
      #............#
      #..#.....#...#
      ##############
    `),
  },
  cave_hollow: {
    key: "cave_hollow",
    width: 15,
    height: 12,
    theme: "cave",
    playerArea: { x: 2, y: 9 },
    enemyArea: { x: 12, y: 3 },
    terrain: M(`
      ######.########
      ##......^.....#
      #..#.......#..#
      #....~~....##.#
      ##...~~~......#
      #.....~....#..#
      #.##......... #
      #..^^...#.....#
      #..........^..#
      ##....#.......#
      ###.........###
      ######.#.######
    `),
  },
  road_ambush: {
    key: "road_ambush",
    width: 18,
    height: 10,
    theme: "road",
    playerArea: { x: 3, y: 5 },
    enemyArea: { x: 13, y: 4 },
    terrain: M(`
      .^^...#....^^^....
      ..^.....^......#..
      ..................
      ..................
      ..................
      ..................
      .#....^...........
      ...^^....#....^...
      .^....#......^^^..
      ..#.....^^....#...
    `),
  },
  town_square: {
    key: "town_square",
    width: 16,
    height: 14,
    theme: "town",
    playerArea: { x: 2, y: 11 },
    enemyArea: { x: 12, y: 2 },
    terrain: M(`
      ####.#####.#####
      #..............#
      #..##......##..#
      #..##......##..#
      ................
      ......~~........
      ......~~........
      ................
      #..##......##..#
      #..##......##..#
      #..............#
      #..............#
      #....##..##....#
      ####.######.####
    `),
  },
  open_field: {
    key: "open_field",
    width: 18,
    height: 12,
    theme: "field",
    playerArea: { x: 3, y: 9 },
    enemyArea: { x: 14, y: 2 },
    terrain: M(`
      ..................
      ....^^............
      ..........^.......
      .......#..........
      ..................
      ..^...............
      ..................
      ............^^....
      .....#............
      ..................
      .........^........
      ..................
    `),
  },
};

// Best preset for a scene type (falls back to open_field).
export function presetForScene(sceneTypeOrKey: string): BattleMapPreset {
  if (BATTLE_MAPS[sceneTypeOrKey]) return BATTLE_MAPS[sceneTypeOrKey];
  const byTheme: Record<string, string> = {
    forest: "forest_clearing",
    swamp: "forest_clearing",
    dungeon: "dungeon_chamber",
    castle: "dungeon_chamber",
    temple: "dungeon_chamber",
    cave: "cave_hollow",
    mountain: "cave_hollow",
    road: "road_ambush",
    camp: "road_ambush",
    town: "town_square",
    tavern: "town_square",
    ship: "road_ambush",
    field: "open_field",
  };
  return BATTLE_MAPS[byTheme[sceneTypeOrKey] ?? "open_field"];
}
