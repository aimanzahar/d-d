// Context assembly for a GM turn: one internal query gathers everything in a
// single consistent snapshot, formatted as compact text blocks.

import { v } from "convex/values";
import { internalQuery } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import { abilityMod, profBonus, type AbilityKey } from "../lib/rules5e";
import { FEATS } from "../srd/feats";

const ABILS: AbilityKey[] = ["str", "dex", "con", "int", "wis", "cha"];

export function condensedCharacter(c: Doc<"characters">): string {
  const mods = ABILS.map(
    (a) => `${a.toUpperCase()} ${abilityMod(c.abilities[a]) >= 0 ? "+" : ""}${abilityMod(c.abilities[a])}`,
  ).join("  ");
  const passivePerception =
    10 +
    abilityMod(c.abilities.wis) +
    (c.proficiencies.skills.includes("perception") ? profBonus(c.level) : 0);
  const slots = c.spellcasting
    ? c.spellcasting.slots
        .map((s, i) => (s.max > 0 ? `L${i + 1} ${s.max - s.used}/${s.max}` : null))
        .filter(Boolean)
        .join(", ")
    : "—";
  const conditions = c.conditions.map((x) => x.name).join(", ") || "—";
  const gear = c.inventory
    .slice(0, 25)
    .map((i) => `${i.name}${i.quantity > 1 ? `×${i.quantity}` : ""}`)
    .join(", ");
  // Feats — so the GM honors ones the engine only approximates or doesn't
  // enforce (Grappler, War Caster, Lucky, Alert).
  const feats = (c.feats ?? []).map((f) => FEATS[f.index]?.name ?? f.index).join(", ");
  return [
    `${c.name} (${c.raceIndex} ${c.classIndex} ${c.level})`,
    `  HP ${c.currentHp}/${c.maxHp}${c.tempHp ? ` (+${c.tempHp} temp)` : ""} | AC ${c.ac} | speed ${c.speed}ft | passive Perception ${passivePerception} | prof +${profBonus(c.level)}`,
    `  ${mods} | saves: ${c.proficiencies.savingThrows.map((s) => s.toUpperCase()).join(", ")}`,
    `  skills: ${c.proficiencies.skills.join(", ") || "—"} | slots: ${slots} | conditions: ${conditions}`,
    ...(feats ? [`  feats: ${feats}`] : []),
    `  gear: ${gear} | ${c.currency.gp} gp${c.notes ? ` | backstory: ${c.notes.slice(0, 600)}` : ""}`,
  ].join("\n");
}

export const getContext = internalQuery({
  args: { campaignId: v.id("campaigns") },
  handler: async (ctx, args) => {
    const campaign = await ctx.db.get(args.campaignId);
    if (!campaign) return null;

    const characters = await ctx.db
      .query("characters")
      .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
      .collect();

    const flags = await ctx.db
      .query("questFlags")
      .withIndex("by_campaign_key", (q) => q.eq("campaignId", args.campaignId))
      .collect();

    // World codex (factions / POIs / active quests) — surfaced so the GM reuses
    // existing slugs instead of forking duplicates.
    const [factions, pois, quests] = await Promise.all([
      ctx.db
        .query("factions")
        .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
        .collect(),
      ctx.db
        .query("pois")
        .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
        .collect(),
      ctx.db
        .query("quests")
        .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
        .collect(),
    ]);
    const knownWorldLines: string[] = [];
    if (factions.length) {
      knownWorldLines.push(
        `Factions: ${factions.map((f) => `${f.slug} (${f.name}) — ${f.standing}`).join("; ")}`,
      );
    }
    if (pois.length) {
      knownWorldLines.push(
        `POIs: ${pois
          .map(
            (p) =>
              `${p.slug} (${p.name}, ${p.kind})${p.discovered ? "" : " [rumored]"}${p.isCurrent ? " [HERE]" : ""}`,
          )
          .join("; ")}`,
      );
    }
    const activeQuests = quests.filter((q) => q.status === "active");
    if (activeQuests.length) {
      knownWorldLines.push(
        `Active quests: ${activeQuests.map((q) => `${q.slug} (${q.title})`).join("; ")}`,
      );
    }

    // Combat block: initiative + economy + ASCII battle map for spatial grounding
    let combatBlock = "";
    if (campaign.mode === "combat" && campaign.activeCombatId) {
      const combat = await ctx.db.get(campaign.activeCombatId);
      if (combat?.status === "active") {
        const monsters = await ctx.db
          .query("monsters")
          .withIndex("by_combat", (q) => q.eq("combatId", combat._id))
          .collect();
        const active = combat.initiative[combat.activeIndex];
        const order = combat.initiative
          .map((e, i) => {
            const marker = i === combat.activeIndex ? "▶ " : "";
            if (e.kind === "monster") {
              const m = monsters.find((x) => String(x._id) === e.refId);
              return `${marker}${e.name} (${e.total})${m?.isDead ? " [DEAD]" : ""}`;
            }
            return `${marker}${e.name} (${e.total})`;
          })
          .join(" → ");

        // ASCII map: digits = monsters, letters = PCs (legend below)
        const rows = combat.map.terrain.map((r) => r.split(""));
        const legend: string[] = [];
        monsters.forEach((m, i) => {
          if (m.isDead) return;
          const symbol = String((i + 1) % 10);
          if (rows[m.position.y]?.[m.position.x] !== undefined) {
            rows[m.position.y][m.position.x] = symbol;
          }
          legend.push(
            `${symbol}=${m.label} HP ${m.currentHp}/${m.maxHp} AC ${m.ac} speed ${m.speed} at (${m.position.x},${m.position.y})${m.conditions.length ? " [" + m.conditions.map((c) => c.name).join(",") + "]" : ""}`,
          );
        });
        characters.forEach((c) => {
          if (!c.position) return;
          const symbol = c.name[0].toUpperCase();
          if (rows[c.position.y]?.[c.position.x] !== undefined) {
            rows[c.position.y][c.position.x] = symbol;
          }
          legend.push(`${symbol}=${c.name} at (${c.position.x},${c.position.y})`);
        });

        combatBlock = [
          `\n# COMBAT STATE — round ${combat.round}, current turn: ▶ ${active?.name} (${active?.kind})`,
          `Initiative: ${order}`,
          `Turn economy: movement used ${combat.turnState.movementUsed} ft, action ${combat.turnState.actionUsed ? "SPENT" : "available"}`,
          `Map ${combat.map.width}x${combat.map.height} (1 cell = 5 ft, '#' wall, '^'/'~' difficult):`,
          rows.map((r) => r.join("")).join("\n"),
          `Legend: ${legend.join(" | ")}`,
        ].join("\n");
      }
    }

    // Unprocessed batch = the queue (cap 10 per turn)
    const unprocessed = await ctx.db
      .query("messages")
      .withIndex("by_campaign_unprocessed", (q) =>
        q.eq("campaignId", args.campaignId).eq("processed", false),
      )
      .take(10);

    // Recent transcript, newest first → reversed to chronological.
    // grok-4.3 has a 500K-class context window — a deep history window with
    // near-full messages costs little and keeps the GM's continuity sharp.
    const recent = await ctx.db
      .query("messages")
      .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
      .order("desc")
      .take(120);
    const history = recent
      .reverse()
      .filter((m) => !unprocessed.some((u) => u._id === m._id))
      .map((m) => {
        const speaker =
          m.kind === "gm" ? "GM" : m.kind === "system" ? "SYSTEM" : m.characterName ?? "?";
        const content = m.kind === "gm" ? m.content.slice(0, 4000) : m.content.slice(0, 2000);
        return `${speaker}${m.ooc ? " (table talk)" : ""}: ${content}`;
      });

    const newActions = unprocessed.map((m) => {
      const speaker = m.kind === "system" ? "SYSTEM" : m.characterName ?? "?";
      return `${speaker}: ${m.content.slice(0, 2000)}`;
    });

    const contextBlock = [
      `# CAMPAIGN: ${campaign.name}`,
      `Premise: ${campaign.premise}`,
      campaign.summary ? `\n# STORY SO FAR\n${campaign.summary}` : "",
      `\n# CURRENT SCENE`,
      `Location: ${campaign.location.name} (${campaign.location.sceneType})`,
      campaign.location.description,
      `\n# PARTY`,
      characters.map(condensedCharacter).join("\n"),
      combatBlock,
      flags.length
        ? `\n# QUEST FLAGS\n${flags.map((f) => `${f.key} = ${JSON.stringify(f.value)}`).join("\n")}`
        : "",
      knownWorldLines.length
        ? `\n# KNOWN WORLD (reuse these exact slugs; do not fork new ones)\n${knownWorldLines.join("\n")}`
        : "",
      history.length ? `\n# RECENT TRANSCRIPT\n${history.join("\n")}` : "",
      `\n# NEW PLAYER ACTIONS (respond to these)\n${newActions.join("\n") || "(none — continue the scene)"}`,
    ]
      .filter(Boolean)
      .join("\n");

    return {
      contextBlock,
      unprocessedIds: unprocessed.map((m) => m._id),
      mode: campaign.mode,
      locationName: campaign.location.name,
      characterNames: characters.map((c) => c.name),
      newActionsText: newActions.join("\n"),
    };
  },
});
