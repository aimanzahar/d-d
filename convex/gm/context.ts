// Context assembly for a GM turn: one internal query gathers everything in a
// single consistent snapshot, formatted as compact text blocks.

import { v } from "convex/values";
import { internalQuery } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import { abilityMod, profBonus, type AbilityKey } from "../lib/rules5e";

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
    .slice(0, 10)
    .map((i) => `${i.name}${i.quantity > 1 ? `×${i.quantity}` : ""}`)
    .join(", ");
  return [
    `${c.name} (${c.raceIndex} ${c.classIndex} ${c.level})`,
    `  HP ${c.currentHp}/${c.maxHp}${c.tempHp ? ` (+${c.tempHp} temp)` : ""} | AC ${c.ac} | speed ${c.speed}ft | passive Perception ${passivePerception} | prof +${profBonus(c.level)}`,
    `  ${mods} | saves: ${c.proficiencies.savingThrows.map((s) => s.toUpperCase()).join(", ")}`,
    `  skills: ${c.proficiencies.skills.join(", ") || "—"} | slots: ${slots} | conditions: ${conditions}`,
    `  gear: ${gear} | ${c.currency.gp} gp${c.notes ? ` | backstory: ${c.notes.slice(0, 160)}` : ""}`,
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

    // Unprocessed batch = the queue (cap 10 per turn)
    const unprocessed = await ctx.db
      .query("messages")
      .withIndex("by_campaign_unprocessed", (q) =>
        q.eq("campaignId", args.campaignId).eq("processed", false),
      )
      .take(10);

    // Recent transcript, newest first → reversed to chronological
    const recent = await ctx.db
      .query("messages")
      .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
      .order("desc")
      .take(20);
    const history = recent
      .reverse()
      .filter((m) => !unprocessed.some((u) => u._id === m._id))
      .map((m) => {
        const speaker =
          m.kind === "gm" ? "GM" : m.kind === "system" ? "SYSTEM" : m.characterName ?? "?";
        const content = m.kind === "gm" ? m.content.slice(0, 800) : m.content.slice(0, 400);
        return `${speaker}${m.ooc ? " (table talk)" : ""}: ${content}`;
      });

    const newActions = unprocessed.map((m) => {
      const speaker = m.kind === "system" ? "SYSTEM" : m.characterName ?? "?";
      return `${speaker}: ${m.content.slice(0, 600)}`;
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
      flags.length
        ? `\n# QUEST FLAGS\n${flags.map((f) => `${f.key} = ${JSON.stringify(f.value)}`).join("\n")}`
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
