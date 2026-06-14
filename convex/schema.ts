import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// Canonical scene types — drives the 3D ambient scene picker and the
// change_location GM tool. Keep in sync with lib/sceneTypes.ts on the client.
export const sceneType = v.union(
  v.literal("tavern"),
  v.literal("forest"),
  v.literal("dungeon"),
  v.literal("cave"),
  v.literal("town"),
  v.literal("castle"),
  v.literal("road"),
  v.literal("ship"),
  v.literal("mountain"),
  v.literal("swamp"),
  v.literal("temple"),
  v.literal("field"),
  v.literal("camp"),
);

const condition = v.object({
  name: v.string(), // SRD condition index ('poisoned', ...) plus 'stable'
  source: v.optional(v.string()),
  expiresRound: v.optional(v.number()),
});

export default defineSchema({
  // Persistent accounts (email+password and/or Google). Campaign membership
  // still rides on players.sessionToken — accountToken only proves identity.
  users: defineTable({
    email: v.string(), // stored lowercased+trimmed
    name: v.string(),
    passwordHash: v.optional(v.string()), // pbkdf2-sha256$iter$salt$hash; absent = Google-only
    googleSub: v.optional(v.string()),
    image: v.optional(v.string()),
    failedLogins: v.optional(v.number()),
    lockedUntil: v.optional(v.number()),
    lastInspiredAt: v.optional(v.number()), // "inspire me" LLM-call cooldown
  })
    .index("by_email", ["email"])
    .index("by_googleSub", ["googleSub"]),

  accountSessions: defineTable({
    userId: v.id("users"),
    token: v.string(), // 32-byte hex accountToken; lives in client localStorage
    createdAt: v.number(),
    lastSeenAt: v.optional(v.number()),
  })
    .index("by_token", ["token"])
    .index("by_user", ["userId"]),

  campaigns: defineTable({
    name: v.string(),
    inviteCode: v.string(), // 6-char A-Z0-9, crypto-random
    // "ended": the story concluded (e.g. total party kill) — read-only history
    status: v.union(v.literal("lobby"), v.literal("active"), v.literal("ended")),
    mode: v.union(v.literal("exploration"), v.literal("combat")),
    location: v.object({
      name: v.string(),
      description: v.string(),
      sceneType,
    }),
    premise: v.string(), // host-entered adventure seed
    summary: v.string(), // rolling compressed story digest (~1500 chars)
    gm: v.object({
      status: v.union(v.literal("idle"), v.literal("running")),
      startedAt: v.optional(v.number()), // heartbeat — bumped on stream flush
      generation: v.number(), // monotonic; stale scheduled actions no-op
    }),
    activeCombatId: v.optional(v.id("combats")),
    // Stall-breaker: GM turns at the current scene since the last meaningful
    // progress (location or quest-flag change). Reset to 0 on progress; when it
    // crosses the threshold the engine injects a one-shot complication directive.
    stall: v.optional(v.object({ count: v.number(), firedAt: v.optional(v.number()) })),
    // Soft-spotlight (exploration only): whose turn it is to act. A gentle cue,
    // never enforced. undefined = anyone may act.
    spotlightCharacterId: v.optional(v.id("characters")),
    // AI-generated region map backdrop. Markers (POIs) overlay it via the pois
    // table's normalized x/y — the image itself carries no labels.
    regionMap: v.optional(
      v.object({
        status: v.union(v.literal("generating"), v.literal("done"), v.literal("failed")),
        storageId: v.optional(v.id("_storage")),
        prompt: v.optional(v.string()),
        generatedAt: v.optional(v.number()),
      }),
    ),
  }).index("by_inviteCode", ["inviteCode"]),

  // Ephemeral "is typing" presence. One row per player; typingUntil is a TTL —
  // expired rows are ignored by `list` and may be GC'd lazily.
  typing: defineTable({
    campaignId: v.id("campaigns"),
    playerId: v.id("players"),
    characterName: v.string(),
    typingUntil: v.number(),
  })
    .index("by_campaign", ["campaignId"])
    .index("by_player", ["playerId"]),

  // --- World Codex: the party's player-facing journal, written by GM tools ---

  factions: defineTable({
    campaignId: v.id("campaigns"),
    slug: v.string(), // stable snake_case id used by tools + POI refs
    name: v.string(),
    description: v.string(),
    standing: v.union(
      v.literal("allied"),
      v.literal("friendly"),
      v.literal("neutral"),
      v.literal("unfriendly"),
      v.literal("hostile"),
      v.literal("unknown"),
    ),
    symbol: v.optional(v.string()),
    discovered: v.boolean(),
    updatedAt: v.number(),
  })
    .index("by_campaign", ["campaignId"])
    .index("by_campaign_slug", ["campaignId", "slug"]),

  // Points of interest = clickable region-map markers + journal entries.
  pois: defineTable({
    campaignId: v.id("campaigns"),
    slug: v.string(),
    name: v.string(),
    kind: v.union(
      v.literal("settlement"),
      v.literal("dungeon"),
      v.literal("landmark"),
      v.literal("wilds"),
      v.literal("danger"),
      v.literal("quest_site"),
    ),
    description: v.string(),
    factionSlug: v.optional(v.string()),
    // Normalized map coords (0-1). Absent = recorded but not placed on the map.
    x: v.optional(v.number()),
    y: v.optional(v.number()),
    discovered: v.boolean(), // visited vs merely heard-of
    isCurrent: v.boolean(), // "you are here"
    updatedAt: v.number(),
  })
    .index("by_campaign", ["campaignId"])
    .index("by_campaign_slug", ["campaignId", "slug"]),

  quests: defineTable({
    campaignId: v.id("campaigns"),
    slug: v.string(), // == the slug in quest.<slug>.status flag
    title: v.string(),
    description: v.string(),
    status: v.union(v.literal("active"), v.literal("completed"), v.literal("failed")),
    factionSlug: v.optional(v.string()),
    poiSlug: v.optional(v.string()),
    updatedAt: v.number(),
  })
    .index("by_campaign", ["campaignId"])
    .index("by_campaign_slug", ["campaignId", "slug"]),

  players: defineTable({
    campaignId: v.id("campaigns"),
    nickname: v.string(),
    sessionToken: v.string(), // 32-byte hex; lives in client localStorage
    isHost: v.boolean(),
    characterId: v.optional(v.id("characters")),
    userId: v.optional(v.id("users")), // owning account; absent = unclaimed legacy seat
    lastSeenAt: v.number(),
    lastInspiredAt: v.optional(v.number()), // backstory-muse LLM-call cooldown
    lastPortraitAt: v.optional(v.number()), // portrait-generation cooldown
  })
    .index("by_token", ["sessionToken"])
    .index("by_campaign", ["campaignId"])
    .index("by_user", ["userId"]),

  characters: defineTable({
    campaignId: v.id("campaigns"),
    playerId: v.id("players"),
    name: v.string(),
    raceIndex: v.string(),
    subraceIndex: v.optional(v.string()),
    classIndex: v.string(),
    subclassIndex: v.optional(v.string()),
    backgroundIndex: v.string(), // 'acolyte' — the only SRD background
    alignment: v.optional(v.string()),
    level: v.number(),
    xp: v.number(),
    pendingLevelUp: v.boolean(),
    abilities: v.object({
      str: v.number(),
      dex: v.number(),
      con: v.number(),
      int: v.number(),
      wis: v.number(),
      cha: v.number(),
    }), // final scores incl. racial bonuses
    maxHp: v.number(),
    currentHp: v.number(),
    tempHp: v.number(),
    hitDice: v.object({ die: v.number(), max: v.number(), used: v.number() }),
    ac: v.number(), // derived from equipped armor; recomputed on equip change
    speed: v.number(), // feet
    proficiencies: v.object({
      skills: v.array(v.string()),
      savingThrows: v.array(v.string()),
      armor: v.array(v.string()),
      weapons: v.array(v.string()),
      tools: v.array(v.string()),
      languages: v.array(v.string()),
    }),
    conditions: v.array(condition),
    exhaustion: v.number(), // 0-6
    deathSaves: v.object({ successes: v.number(), failures: v.number() }),
    spellcasting: v.optional(
      v.object({
        ability: v.string(), // 'int' | 'wis' | 'cha'
        cantrips: v.array(v.string()), // SRD spell indexes
        known: v.array(v.string()),
        prepared: v.array(v.string()),
        // slots[0] = level-1 slots ... slots[8] = level-9
        slots: v.array(v.object({ max: v.number(), used: v.number() })),
      }),
    ),
    inventory: v.array(
      v.object({
        itemIndex: v.optional(v.string()), // SRD equipment index; absent = custom item
        name: v.string(),
        quantity: v.number(),
        equipped: v.boolean(),
      }),
    ),
    currency: v.object({
      cp: v.number(),
      sp: v.number(),
      ep: v.number(),
      gp: v.number(),
      pp: v.number(),
    }),
    featureChoices: v.any(), // resolved choice-DSL picks (fighting style, ...)
    // Feats taken (currently only at creation, via a variant race). `choices`
    // holds a feat's internal sub-pick, e.g. Resilient's chosen ability.
    feats: v.optional(
      v.array(v.object({ index: v.string(), choices: v.optional(v.any()) })),
    ),
    // Per-feat combat state (ADR 0005) — kept OUT of turnState. Per-turn flags
    // store the round number they were used and self-expire vs combat.round.
    combatResources: v.optional(
      v.object({
        luckPoints: v.number(),
        savageUsedRound: v.optional(v.number()),
        defensiveDuelistRound: v.optional(v.number()),
        gwmActive: v.optional(v.boolean()),
        sharpshooterActive: v.optional(v.boolean()),
      }),
    ),
    position: v.optional(v.object({ x: v.number(), y: v.number() })), // combat grid cell
    portraitStorageId: v.optional(v.id("_storage")), // uploaded or AI-generated portrait
    notes: v.string(),
  })
    .index("by_campaign", ["campaignId"])
    .index("by_player", ["playerId"]),

  messages: defineTable({
    campaignId: v.id("campaigns"),
    kind: v.union(
      v.literal("gm"),
      v.literal("player"),
      v.literal("system"),
      v.literal("roll"),
      v.literal("image"),
    ),
    playerId: v.optional(v.id("players")),
    characterName: v.optional(v.string()),
    // GM messages: append-only while status === 'streaming' (frontend contract)
    content: v.string(),
    status: v.union(v.literal("streaming"), v.literal("complete"), v.literal("error")),
    ooc: v.boolean(), // table talk; never triggers the GM
    processed: v.boolean(), // GM-consumption flag — unprocessed docs are the GM queue
    rollId: v.optional(v.id("rolls")),
    imageId: v.optional(v.id("images")),
    round: v.optional(v.number()), // combat round tag
    // Spoken narration (TTS): gm messages get audio synthesized post-finalize.
    // audioStatus/audioStorageId are the legacy single-voice fields, retained for
    // messages synthesized before per-speaker voices (docs/adr/0006) shipped.
    audioStatus: v.optional(
      v.union(v.literal("generating"), v.literal("done"), v.literal("failed")),
    ),
    audioStorageId: v.optional(v.id("_storage")),
    // Per-speaker voices: a gm message is split into ordered voiced segments
    // (narrator + tagged NPC dialogue), each synthesized to its own clip and
    // played back in order. Parsed at finalize from the [[Name]]…[[/]] tags.
    audioSegments: v.optional(
      v.array(
        v.object({
          order: v.number(),
          voiceId: v.string(),
          text: v.string(), // TTS-ready line (tags + markdown already stripped)
          audioStatus: v.union(
            v.literal("pending"),
            v.literal("generating"),
            v.literal("done"),
            v.literal("failed"),
          ),
          audioStorageId: v.optional(v.id("_storage")),
        }),
      ),
    ),
  })
    .index("by_campaign", ["campaignId"])
    .index("by_campaign_unprocessed", ["campaignId", "processed"]),

  combats: defineTable({
    campaignId: v.id("campaigns"),
    status: v.union(v.literal("active"), v.literal("ended")),
    round: v.number(),
    activeIndex: v.number(), // pointer into initiative[]
    initiative: v.array(
      v.object({
        kind: v.union(v.literal("pc"), v.literal("monster")),
        refId: v.string(), // characterId or monsterId as string
        name: v.string(),
        total: v.number(),
        dexMod: v.number(), // tiebreaker
      }),
    ),
    // Action economy of the ACTIVE entry; reset on advance
    turnState: v.object({
      movementUsed: v.number(), // feet
      actionUsed: v.boolean(),
      bonusActionUsed: v.boolean(),
      reactionUsed: v.boolean(),
    }),
    map: v.object({
      width: v.number(), // cells, 1 cell = 5 ft, cap 30
      height: v.number(),
      terrain: v.array(v.string()), // rows of: '.' open '#' wall '^' difficult '~' water
      theme: sceneType,
    }),
    outcome: v.optional(v.string()),
  }).index("by_campaign_status", ["campaignId", "status"]),

  monsters: defineTable({
    campaignId: v.id("campaigns"),
    combatId: v.id("combats"),
    srdIndex: v.string(), // 'goblin'
    label: v.string(), // 'Goblin 2' — unique within combat; GM addresses by label
    maxHp: v.number(),
    currentHp: v.number(),
    ac: v.number(),
    speed: v.number(),
    position: v.object({ x: v.number(), y: v.number() }),
    conditions: v.array(condition),
    isDead: v.boolean(),
    // Condensed at spawn from the SRD stat block — combat never re-reads SRD
    stats: v.object({
      abilities: v.object({
        str: v.number(),
        dex: v.number(),
        con: v.number(),
        int: v.number(),
        wis: v.number(),
        cha: v.number(),
      }),
      attacks: v.array(
        v.object({
          name: v.string(),
          attackBonus: v.number(),
          damageDice: v.string(),
          damageType: v.string(),
          reach: v.number(), // feet
          range: v.optional(v.number()), // feet, ranged attacks
        }),
      ),
      saveBonuses: v.any(), // { dex: 4, ... } from SRD proficiencies
      cr: v.number(),
      xp: v.number(),
    }),
  }).index("by_combat", ["combatId"]),

  // The 3D dice animation contract: client physics-simulates, then face-remaps
  // so resting faces equal results[].
  rolls: defineTable({
    campaignId: v.id("campaigns"),
    characterId: v.optional(v.id("characters")),
    actorName: v.string(), // 'Thorin' | 'Goblin 2' | 'GM'
    requestedBy: v.union(v.literal("gm"), v.literal("player"), v.literal("system")),
    purpose: v.string(), // 'attack'|'damage'|'ability_check'|'saving_throw'|'initiative'|'death_save'|'custom'
    context: v.optional(v.string()), // "Stealth check to sneak past the guards"
    skill: v.optional(v.string()),
    ability: v.optional(v.string()),
    advantage: v.union(
      v.literal("normal"),
      v.literal("advantage"),
      v.literal("disadvantage"),
    ),
    dc: v.optional(v.number()), // stripped from public queries until rolled
    visibility: v.union(v.literal("public"), v.literal("secret")),
    status: v.union(v.literal("pending"), v.literal("rolled")),
    rolledAt: v.optional(v.number()), // when the dice actually landed
    notation: v.optional(v.string()), // '1d20+5'
    dice: v.optional(
      v.array(
        v.object({
          sides: v.number(),
          count: v.number(),
          results: v.array(v.number()),
          dropped: v.array(v.number()), // discarded adv/disadv die, rendered dimmed
        }),
      ),
    ),
    modifier: v.optional(v.number()),
    total: v.optional(v.number()),
    success: v.optional(v.boolean()), // vs dc, when dc set
    crit: v.optional(v.union(v.literal("hit"), v.literal("miss"))),
  })
    .index("by_campaign", ["campaignId"])
    .index("by_campaign_status", ["campaignId", "status"]),

  // Conventions: quest.<slug>.status / flag.<slug> / secret.<slug> (GM-only)
  questFlags: defineTable({
    campaignId: v.id("campaigns"),
    key: v.string(),
    value: v.union(v.string(), v.number(), v.boolean()),
    updatedAt: v.number(),
  }).index("by_campaign_key", ["campaignId", "key"]),

  images: defineTable({
    campaignId: v.id("campaigns"),
    requestedByPlayerId: v.id("players"),
    prompt: v.string(),
    safePrompt: v.optional(v.string()), // scenery-only fallback for safety rejections
    locationName: v.string(),
    status: v.union(v.literal("generating"), v.literal("done"), v.literal("failed")),
    storageId: v.optional(v.id("_storage")),
    error: v.optional(v.string()),
  }).index("by_campaign", ["campaignId"]),

  // One generic SRD table: raw records keyed by (category, index slug).
  srd: defineTable({
    category: v.string(), // 'monsters'|'spells'|'equipment'|'magic-items'|'classes'|...
    index: v.string(), // SRD slug; levels use synthetic '{class}-{level}'
    name: v.string(),
    data: v.any(), // raw SRD record, cross-refs stay {index,name,url}
    spellLevel: v.optional(v.number()), // promoted: spells
    cr: v.optional(v.number()), // promoted: monsters
    classIndex: v.optional(v.string()), // promoted: levels/features/subclasses
  })
    .index("by_category_index", ["category", "index"])
    .index("by_category_level", ["category", "spellLevel"])
    .index("by_category_cr", ["category", "cr"])
    .index("by_category_class", ["category", "classIndex"])
    .searchIndex("search_name", {
      searchField: "name",
      filterFields: ["category"],
    }),
});
