// GM tool catalog (exploration set) + dispatcher. Tools execute as internal
// mutations/queries; every failure returns a corrective {ok:false, error}
// result so the model self-repairs instead of crashing the turn.

import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalMutation, internalQuery } from "../_generated/server";
import type { ActionCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { findCharacterByName } from "../characterOps";
import { embed, type ToolDef } from "../lib/llm";
import { search } from "../lib/qdrant";

const SCENE_TYPES = [
  "tavern", "forest", "dungeon", "cave", "town", "castle", "road",
  "ship", "mountain", "swamp", "temple", "field", "camp",
];

export const TOOL_DEFS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "roll_dice",
      description:
        "Roll dice for anything you control: NPCs, the environment, random events. Result is shown to players unless visibility='secret'.",
      parameters: {
        type: "object",
        properties: {
          notation: { type: "string", description: "e.g. '2d6+3', '1d20'" },
          purpose: { type: "string", description: "What this roll is for" },
          actorName: { type: "string", description: "Who rolls, e.g. 'Innkeeper Maro' or 'GM'" },
          visibility: { type: "string", enum: ["public", "secret"] },
        },
        required: ["notation", "purpose", "actorName"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "request_player_roll",
      description:
        "Ask a player's character for a d20 roll (check/save). ENDS YOUR TURN — stop narrating after the current sentence and wait for the result.",
      parameters: {
        type: "object",
        properties: {
          characterName: { type: "string" },
          rollType: { type: "string", enum: ["ability_check", "saving_throw", "initiative", "death_save", "custom"] },
          ability: { type: "string", enum: ["str", "dex", "con", "int", "wis", "cha"] },
          skill: {
            type: "string",
            description: "SRD skill index for checks, e.g. 'perception', 'stealth', 'athletics', 'insight', 'persuasion', 'arcana'",
          },
          dc: { type: "integer", description: "Difficulty class — hidden from the player until rolled" },
          advantage: { type: "string", enum: ["normal", "advantage", "disadvantage"] },
          reason: { type: "string", description: "Shown to the player, e.g. 'to sneak past the sleeping guard'" },
        },
        required: ["characterName", "rollType", "reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_hp",
      description: "Apply damage (negative delta) or healing (positive delta) to a character. Engine handles temp HP, dropping to 0, and death rules — narrate from the result.",
      parameters: {
        type: "object",
        properties: {
          characterName: { type: "string" },
          delta: { type: "integer", description: "negative = damage, positive = healing" },
          reason: { type: "string" },
        },
        required: ["characterName", "delta", "reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_condition",
      description: "Add or remove a 5e condition on a character.",
      parameters: {
        type: "object",
        properties: {
          characterName: { type: "string" },
          condition: { type: "string", description: "SRD condition: blinded, charmed, deafened, frightened, grappled, incapacitated, invisible, paralyzed, petrified, poisoned, prone, restrained, stunned, unconscious, exhaustion" },
          action: { type: "string", enum: ["add", "remove"] },
          durationRounds: { type: "integer" },
        },
        required: ["characterName", "condition", "action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "modify_inventory",
      description:
        "Add or remove items and/or gold. Call with action 'remove' whenever a character expends, throws, drinks, gives away, or loses an item (ammunition, potions, thrown daggers); 'add' for loot, purchases, or recovering thrown weapons. Use itemIndex for SRD items when you know it ('longsword'); otherwise itemName alone for custom loot.",
      parameters: {
        type: "object",
        properties: {
          characterName: { type: "string" },
          action: { type: "string", enum: ["add", "remove"] },
          itemIndex: { type: "string", description: "SRD equipment index, optional" },
          itemName: { type: "string" },
          quantity: { type: "integer" },
          goldDelta: { type: "integer", description: "gold change, may be negative" },
        },
        required: ["characterName", "action", "itemName", "quantity"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "award_xp",
      description: "Award experience points, split evenly is NOT applied — amount goes to each named character (or the whole party if none named).",
      parameters: {
        type: "object",
        properties: {
          amount: { type: "integer", description: "XP per character" },
          characterNames: { type: "array", items: { type: "string" } },
          reason: { type: "string" },
        },
        required: ["amount", "reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_quest_flag",
      description: "Set a quest flag. Conventions: quest.<slug>.status = active|completed|failed; flag.<slug> = true/false; secret.<slug> = GM-only notes.",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string" },
          value: { type: ["string", "number", "boolean"] },
        },
        required: ["key", "value"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "change_location",
      description: "Move the party to a new location. Drives the visual scene — choose the closest sceneType.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "e.g. 'The Gilded Flagon'" },
          description: { type: "string", description: "2-3 sentences, present tense" },
          sceneType: { type: "string", enum: SCENE_TYPES },
        },
        required: ["name", "description", "sceneType"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "apply_rest",
      description: "Complete a rest. Long rest: full HP, slots, reduced exhaustion. Use only when the fiction allows an uninterrupted rest.",
      parameters: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["short", "long"] },
          characterNames: { type: "array", items: { type: "string" }, description: "omit for whole party" },
        },
        required: ["type"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "expend_spell_slot",
      description: "Spend a character's spell slot for narrative casting you adjudicated.",
      parameters: {
        type: "object",
        properties: {
          characterName: { type: "string" },
          slotLevel: { type: "integer", minimum: 1, maximum: 9 },
        },
        required: ["characterName", "slotLevel"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "start_combat",
      description:
        "Begin tactical combat. The engine builds the battle map, spawns SRD monsters, rolls EVERYONE's initiative, and reports the order. Use when violence erupts.",
      parameters: {
        type: "object",
        properties: {
          mapPreset: {
            type: "string",
            enum: ["forest_clearing", "dungeon_chamber", "cave_hollow", "road_ambush", "town_square", "open_field"],
            description: "Battlefield; omit to match the current scene",
          },
          monsters: {
            type: "array",
            items: {
              type: "object",
              properties: {
                srdIndex: { type: "string", description: "SRD monster index, e.g. 'goblin', 'wolf', 'skeleton', 'bandit'" },
                count: { type: "integer", minimum: 1, maximum: 8 },
              },
              required: ["srdIndex", "count"],
            },
          },
        },
        required: ["monsters"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "npc_attack",
      description:
        "A monster attacks a character. The engine resolves everything (d20 vs AC with condition modifiers, crits, damage, dropping to 0 HP) — narrate from the returned result.",
      parameters: {
        type: "object",
        properties: {
          attackerLabel: { type: "string", description: "Monster label, e.g. 'Goblin 2'" },
          targetName: { type: "string", description: "Character name" },
          attackName: { type: "string", description: "Attack from its stat block, e.g. 'Scimitar' — omit for its first attack" },
        },
        required: ["attackerLabel", "targetName"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "move_token",
      description: "Move a combatant on the battle map. Monster moves are validated against speed; use forced=true only for shoves/teleports.",
      parameters: {
        type: "object",
        properties: {
          entityType: { type: "string", enum: ["monster", "character"] },
          name: { type: "string" },
          toX: { type: "integer" },
          toY: { type: "integer" },
          forced: { type: "boolean" },
        },
        required: ["entityType", "name", "toX", "toY"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "advance_turn",
      description: "End the current monster's turn. Returns who acts next. NEVER call this on a player's turn — players end their own turns.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "end_combat",
      description: "End the battle when one side is defeated, flees, or surrenders. Then award_xp (the result tells you the defeated XP total).",
      parameters: {
        type: "object",
        properties: {
          outcome: { type: "string", enum: ["victory", "defeat", "fled", "negotiated"] },
          summary: { type: "string", description: "One sentence for the log" },
        },
        required: ["outcome", "summary"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "spawn_monsters",
      description: "Reinforcements join an ongoing combat.",
      parameters: {
        type: "object",
        properties: {
          monsters: {
            type: "array",
            items: {
              type: "object",
              properties: {
                srdIndex: { type: "string" },
                count: { type: "integer", minimum: 1, maximum: 6 },
              },
              required: ["srdIndex", "count"],
            },
          },
        },
        required: ["monsters"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "lookup_srd",
      description: "Fetch an exact SRD record when you need real numbers: a monster stat block, spell, or item.",
      parameters: {
        type: "object",
        properties: {
          category: { type: "string", enum: ["monsters", "spells", "equipment", "magic-items"] },
          index: { type: "string", description: "slug, e.g. 'goblin', 'fireball', 'longsword'" },
        },
        required: ["category", "index"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "lookup_rule",
      description: "Search the 5e rules text when unsure of an exact rule (cover, grappling, concentration, conditions…).",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
  },
];

// --- resolution + tool-specific internal functions -------------------------

export const resolveCharacter = internalQuery({
  args: { campaignId: v.id("campaigns"), name: v.string() },
  handler: async (ctx, args) => {
    const { character, candidates } = await findCharacterByName(ctx, args.campaignId, args.name);
    return character
      ? { ok: true as const, characterId: character._id, name: character.name }
      : {
          ok: false as const,
          error: `No character named '${args.name}'. Party: ${candidates.join(", ")}`,
        };
  },
});

export const toolChangeLocation = internalMutation({
  args: {
    campaignId: v.id("campaigns"),
    name: v.string(),
    description: v.string(),
    sceneType: v.string(),
  },
  handler: async (ctx, args) => {
    if (!SCENE_TYPES.includes(args.sceneType)) {
      return { ok: false, error: `sceneType must be one of: ${SCENE_TYPES.join(", ")}` };
    }
    await ctx.db.patch(args.campaignId, {
      location: {
        name: args.name.slice(0, 80),
        description: args.description.slice(0, 600),
        sceneType: args.sceneType as any,
      },
    });
    return { ok: true, location: args.name };
  },
});

export const getSrdRecord = internalQuery({
  args: { category: v.string(), index: v.string() },
  handler: async (ctx, args) => {
    const doc = await ctx.db
      .query("srd")
      .withIndex("by_category_index", (q) =>
        q.eq("category", args.category).eq("index", args.index.toLowerCase()),
      )
      .unique();
    if (doc) return { ok: true as const, data: doc.data };
    // Fuzzy fallback by name search
    const near = await ctx.db
      .query("srd")
      .withSearchIndex("search_name", (q) =>
        q.search("name", args.index).eq("category", args.category),
      )
      .take(5);
    return {
      ok: false as const,
      error: `No ${args.category} record '${args.index}'.${near.length ? ` Did you mean: ${near.map((n) => n.index).join(", ")}?` : ""}`,
    };
  },
});

export const partyCharacterIds = internalQuery({
  args: { campaignId: v.id("campaigns") },
  handler: async (ctx, args) => {
    const all = await ctx.db
      .query("characters")
      .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
      .collect();
    return all.map((c) => ({ id: c._id, name: c.name }));
  },
});

// --- the dispatcher (runs inside the GM action) -----------------------------

type ToolArgs = Record<string, any>;

async function resolveOrError(
  ctx: ActionCtx,
  campaignId: Id<"campaigns">,
  name: unknown,
): Promise<{ ok: true; characterId: Id<"characters"> } | { ok: false; error: string }> {
  if (typeof name !== "string" || !name.trim()) {
    return { ok: false, error: "characterName is required" };
  }
  const result = await ctx.runQuery(internal.gm.tools.resolveCharacter, {
    campaignId,
    name,
  });
  return result.ok
    ? { ok: true, characterId: result.characterId }
    : { ok: false, error: result.error };
}

export async function dispatchTool(
  ctx: ActionCtx,
  campaignId: Id<"campaigns">,
  toolName: string,
  args: ToolArgs,
): Promise<unknown> {
  switch (toolName) {
    case "roll_dice":
      return await ctx.runMutation(internal.dice.createNotationRoll, {
        campaignId,
        notation: String(args.notation ?? ""),
        actorName: String(args.actorName ?? "GM").slice(0, 40),
        purpose: String(args.purpose ?? "roll").slice(0, 120),
        visibility: args.visibility === "secret" ? "secret" : "public",
      });

    case "request_player_roll": {
      const resolved = await resolveOrError(ctx, campaignId, args.characterName);
      if (!resolved.ok) return resolved;
      const rollType = ["ability_check", "saving_throw", "initiative", "death_save", "custom"].includes(args.rollType)
        ? args.rollType
        : "ability_check";
      return await ctx.runMutation(internal.dice.createPendingRoll, {
        campaignId,
        characterId: resolved.characterId,
        purpose: rollType,
        ability: typeof args.ability === "string" ? args.ability : undefined,
        skill: typeof args.skill === "string" ? args.skill.toLowerCase().replace(/^skill-/, "") : undefined,
        dc: Number.isFinite(args.dc) ? Math.round(args.dc) : undefined,
        advantage: ["advantage", "disadvantage"].includes(args.advantage) ? args.advantage : "normal",
        reason: String(args.reason ?? "the GM calls for a roll").slice(0, 200),
      });
    }

    case "update_hp": {
      const resolved = await resolveOrError(ctx, campaignId, args.characterName);
      if (!resolved.ok) return resolved;
      const delta = Math.round(Number(args.delta));
      if (!Number.isFinite(delta) || delta === 0 || Math.abs(delta) > 500) {
        return { ok: false, error: "delta must be a non-zero integer (negative = damage)" };
      }
      return await ctx.runMutation(internal.characterOps.applyHpDelta, {
        characterId: resolved.characterId,
        delta,
      });
    }

    case "update_condition": {
      const resolved = await resolveOrError(ctx, campaignId, args.characterName);
      if (!resolved.ok) return resolved;
      return await ctx.runMutation(internal.characterOps.setCondition, {
        characterId: resolved.characterId,
        condition: String(args.condition ?? "").toLowerCase(),
        action: args.action === "remove" ? "remove" : "add",
        durationRounds: Number.isFinite(args.durationRounds) ? args.durationRounds : undefined,
      });
    }

    case "modify_inventory": {
      const resolved = await resolveOrError(ctx, campaignId, args.characterName);
      if (!resolved.ok) return resolved;
      return await ctx.runMutation(internal.characterOps.modifyInventory, {
        characterId: resolved.characterId,
        action: args.action === "remove" ? "remove" : "add",
        itemIndex: typeof args.itemIndex === "string" ? args.itemIndex : undefined,
        itemName: String(args.itemName ?? "item").slice(0, 80),
        quantity: Math.max(1, Math.round(Number(args.quantity) || 1)),
        goldDelta: Number.isFinite(args.goldDelta) ? Math.round(args.goldDelta) : undefined,
      });
    }

    case "award_xp": {
      const amount = Math.round(Number(args.amount));
      if (!Number.isFinite(amount) || amount <= 0 || amount > 50000) {
        return { ok: false, error: "amount must be a positive integer" };
      }
      const party = await ctx.runQuery(internal.gm.tools.partyCharacterIds, { campaignId });
      let ids = party.map((p) => p.id);
      if (Array.isArray(args.characterNames) && args.characterNames.length > 0) {
        ids = [];
        for (const name of args.characterNames) {
          const resolved = await resolveOrError(ctx, campaignId, name);
          if (!resolved.ok) return resolved;
          ids.push(resolved.characterId);
        }
      }
      return await ctx.runMutation(internal.characterOps.awardXp, { characterIds: ids, amount });
    }

    case "set_quest_flag": {
      const key = String(args.key ?? "").slice(0, 80);
      if (!/^[a-z0-9_.]+$/.test(key)) {
        return { ok: false, error: "key must be snake_case dotted, e.g. quest.red_comet.status" };
      }
      const value = args.value;
      if (!["string", "number", "boolean"].includes(typeof value)) {
        return { ok: false, error: "value must be string, number, or boolean" };
      }
      return await ctx.runMutation(internal.questFlags.set, { campaignId, key, value });
    }

    case "change_location":
      return await ctx.runMutation(internal.gm.tools.toolChangeLocation, {
        campaignId,
        name: String(args.name ?? "Somewhere"),
        description: String(args.description ?? ""),
        sceneType: String(args.sceneType ?? "field"),
      });

    case "apply_rest": {
      const party = await ctx.runQuery(internal.gm.tools.partyCharacterIds, { campaignId });
      let ids = party.map((p) => p.id);
      if (Array.isArray(args.characterNames) && args.characterNames.length > 0) {
        ids = [];
        for (const name of args.characterNames) {
          const resolved = await resolveOrError(ctx, campaignId, name);
          if (!resolved.ok) return resolved;
          ids.push(resolved.characterId);
        }
      }
      return await ctx.runMutation(internal.characterOps.applyRest, {
        characterIds: ids,
        type: args.type === "short" ? "short" : "long",
      });
    }

    case "expend_spell_slot": {
      const resolved = await resolveOrError(ctx, campaignId, args.characterName);
      if (!resolved.ok) return resolved;
      const slotLevel = Math.round(Number(args.slotLevel));
      if (!Number.isFinite(slotLevel) || slotLevel < 1 || slotLevel > 9) {
        return { ok: false, error: "slotLevel must be 1-9" };
      }
      return await ctx.runMutation(internal.characterOps.expendSlot, {
        characterId: resolved.characterId,
        slotLevel,
      });
    }

    case "start_combat":
      return await ctx.runMutation(internal.combat.toolStartCombat, {
        campaignId,
        mapPreset: typeof args.mapPreset === "string" ? args.mapPreset : undefined,
        monsters: Array.isArray(args.monsters)
          ? args.monsters.map((m: any) => ({
              srdIndex: String(m.srdIndex ?? ""),
              count: Math.max(1, Math.round(Number(m.count) || 1)),
            }))
          : [],
        surprised: Array.isArray(args.surprised) ? args.surprised.map(String) : undefined,
      });

    case "npc_attack":
      return await ctx.runMutation(internal.combat.toolNpcAttack, {
        campaignId,
        attackerLabel: String(args.attackerLabel ?? ""),
        targetName: String(args.targetName ?? ""),
        attackName: typeof args.attackName === "string" ? args.attackName : undefined,
      });

    case "move_token":
      return await ctx.runMutation(internal.combat.toolMoveToken, {
        campaignId,
        entityType: args.entityType === "character" ? "character" : "monster",
        name: String(args.name ?? ""),
        toX: Math.round(Number(args.toX)),
        toY: Math.round(Number(args.toY)),
        forced: args.forced === true,
      });

    case "advance_turn":
      return await ctx.runMutation(internal.combat.toolAdvanceTurn, { campaignId });

    case "end_combat":
      return await ctx.runMutation(internal.combat.toolEndCombat, {
        campaignId,
        outcome: String(args.outcome ?? "victory"),
        summary: String(args.summary ?? "").slice(0, 300),
      });

    case "spawn_monsters":
      return await ctx.runMutation(internal.combat.toolSpawnMonsters, {
        campaignId,
        monsters: Array.isArray(args.monsters)
          ? args.monsters.map((m: any) => ({
              srdIndex: String(m.srdIndex ?? ""),
              count: Math.max(1, Math.round(Number(m.count) || 1)),
            }))
          : [],
      });

    case "lookup_srd":
      return await ctx.runQuery(internal.gm.tools.getSrdRecord, {
        category: String(args.category ?? "monsters"),
        index: String(args.index ?? ""),
      });

    case "lookup_rule": {
      try {
        const [vector] = await embed([String(args.query ?? "")]);
        const hits = await search({ vector, campaignId: "global", kinds: ["rule"], limit: 3 });
        return {
          ok: true,
          rules: hits.map((h) => ({ title: h.payload.title, text: h.payload.text.slice(0, 1200) })),
        };
      } catch (e) {
        return { ok: false, error: "rules lookup unavailable right now — use your judgment" };
      }
    }

    default:
      return { ok: false, error: `Unknown tool '${toolName}'` };
  }
}
