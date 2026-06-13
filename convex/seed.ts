import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { embed } from "./lib/llm";
import { ensureCollection, deleteByFilter, upsertPoints } from "./lib/qdrant";
import { VARIANT_RECORDS } from "./srd/variants";

const RAW = "https://raw.githubusercontent.com/5e-bits/5e-database/main/src/2014/en";

// DB-seeded categories. Tiny reference files live in srd/static.ts instead;
// Rules/Rule-Sections prose goes to Qdrant only.
const CATEGORIES: Record<string, string> = {
  monsters: "5e-SRD-Monsters.json",
  spells: "5e-SRD-Spells.json",
  equipment: "5e-SRD-Equipment.json",
  "magic-items": "5e-SRD-Magic-Items.json",
  classes: "5e-SRD-Classes.json",
  subclasses: "5e-SRD-Subclasses.json",
  races: "5e-SRD-Races.json",
  subraces: "5e-SRD-Subraces.json",
  traits: "5e-SRD-Traits.json",
  levels: "5e-SRD-Levels.json",
  features: "5e-SRD-Features.json",
  backgrounds: "5e-SRD-Backgrounds.json",
  feats: "5e-SRD-Feats.json",
  proficiencies: "5e-SRD-Proficiencies.json",
  "equipment-categories": "5e-SRD-Equipment-Categories.json",
};

type SeedRecord = {
  category: string;
  index: string;
  name: string;
  data: unknown;
  spellLevel?: number;
  cr?: number;
  classIndex?: string;
};

function toSeedRecord(category: string, rec: any): SeedRecord {
  const out: SeedRecord = {
    category,
    // Levels records carry their own index ('wizard-3'); everything else too.
    index: String(rec.index ?? `${rec.class?.index}-${rec.level}`),
    name: String(rec.name ?? rec.index ?? "unnamed"),
    data: rec,
  };
  if (category === "spells" && typeof rec.level === "number") out.spellLevel = rec.level;
  if (category === "monsters" && typeof rec.challenge_rating === "number") {
    out.cr = rec.challenge_rating;
  }
  if (["levels", "features", "subclasses"].includes(category) && rec.class?.index) {
    out.classIndex = rec.class.index;
  }
  return out;
}

// npx convex run seed:runSrdSeed       (all categories)
// npx convex run seed:runSrdSeed '{"categories":["spells"]}'
export const runSrdSeed = internalAction({
  args: { categories: v.optional(v.array(v.string())) },
  handler: async (ctx, args) => {
    const wanted = args.categories ?? Object.keys(CATEGORIES);
    const summary: Record<string, number> = {};
    for (const category of wanted) {
      const file = CATEGORIES[category];
      if (!file) throw new Error(`Unknown category '${category}'`);
      const res = await fetch(`${RAW}/${file}`);
      if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
      const records: any[] = await res.json();
      const seedRecords = records.map((r) => toSeedRecord(category, r));
      for (let i = 0; i < seedRecords.length; i += 100) {
        await ctx.runMutation(internal.seed.upsertSrdBatch, {
          records: seedRecords.slice(i, i + 100),
        });
      }
      summary[category] = seedRecords.length;
      console.log(`seeded ${category}: ${seedRecords.length}`);
    }
    return summary;
  },
});

export const upsertSrdBatch = internalMutation({
  args: {
    records: v.array(
      v.object({
        category: v.string(),
        index: v.string(),
        name: v.string(),
        data: v.any(),
        spellLevel: v.optional(v.number()),
        cr: v.optional(v.number()),
        classIndex: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    for (const rec of args.records) {
      const existing = await ctx.db
        .query("srd")
        .withIndex("by_category_index", (q) =>
          q.eq("category", rec.category).eq("index", rec.index),
        )
        .unique();
      if (existing) {
        await ctx.db.patch(existing._id, rec);
      } else {
        await ctx.db.insert("srd", rec);
      }
    }
  },
});

// Seeds the curated non-SRD variant races/subraces + their traits (Drow,
// Variant Human, Custom Lineage). Idempotent (distinct indexes, upsert by
// category+index) and additive — run AFTER runSrdSeed so the base races exist.
// Never wipe the whole srd table or these are lost (see ADR 0002).
//   npx convex run seed:seedVariants
export const seedVariants = internalMutation({
  args: {},
  handler: async (ctx) => {
    for (const rec of VARIANT_RECORDS) {
      const existing = await ctx.db
        .query("srd")
        .withIndex("by_category_index", (q) =>
          q.eq("category", rec.category).eq("index", rec.index),
        )
        .unique();
      if (existing) await ctx.db.patch(existing._id, rec);
      else await ctx.db.insert("srd", rec);
    }
    return { seeded: VARIANT_RECORDS.length };
  },
});

export const stats = internalQuery({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("srd").collect();
    const counts: Record<string, number> = {};
    for (const doc of all) counts[doc.category] = (counts[doc.category] ?? 0) + 1;
    return { total: all.length, counts };
  },
});

// npx convex run seed:ensureQdrant
export const ensureQdrant = internalAction({
  args: {},
  handler: async () => ensureCollection(),
});

// --- Rules → Qdrant -------------------------------------------------------

// Splits markdown prose into chunks of ≤maxChars, preferring ## heading
// boundaries, then paragraph boundaries.
function chunkMarkdown(title: string, text: string, maxChars = 3200): { title: string; text: string }[] {
  const sections = text.split(/\n(?=## )/);
  const chunks: { title: string; text: string }[] = [];
  for (const section of sections) {
    const headingMatch = section.match(/^##\s+(.+)/);
    const sectionTitle = headingMatch ? `${title} — ${headingMatch[1].trim()}` : title;
    if (section.length <= maxChars) {
      chunks.push({ title: sectionTitle, text: section.trim() });
      continue;
    }
    let current = "";
    for (const para of section.split(/\n\n+/)) {
      if (current.length + para.length + 2 > maxChars && current) {
        chunks.push({ title: sectionTitle, text: current.trim() });
        current = "";
      }
      current += para + "\n\n";
    }
    if (current.trim()) chunks.push({ title: sectionTitle, text: current.trim() });
  }
  return chunks.filter((c) => c.text.length > 40);
}

// npx convex run seed:seedRulesToQdrant
// Idempotent: wipes {campaignId:'global', kind:'rule'} and re-seeds.
export const seedRulesToQdrant = internalAction({
  args: {},
  handler: async () => {
    await ensureCollection();

    const sources: { title: string; text: string }[] = [];

    const ruleSections: any[] = await (await fetch(`${RAW}/5e-SRD-Rule-Sections.json`)).json();
    for (const rs of ruleSections) sources.push({ title: rs.name, text: rs.desc });

    const rules: any[] = await (await fetch(`${RAW}/5e-SRD-Rules.json`)).json();
    for (const r of rules) sources.push({ title: r.name, text: r.desc });

    const conditions: any[] = await (await fetch(`${RAW}/5e-SRD-Conditions.json`)).json();
    for (const c of conditions) {
      sources.push({ title: `Condition: ${c.name}`, text: c.desc.join("\n") });
    }

    const chunks = sources.flatMap((s) => chunkMarkdown(s.title, s.text));
    console.log(`embedding ${chunks.length} rule chunks`);

    await deleteByFilter({ campaignId: "global", kind: "rule" });

    let upserted = 0;
    for (let i = 0; i < chunks.length; i += 32) {
      const batch = chunks.slice(i, i + 32);
      const vectors = await embed(batch.map((c) => `${c.title}\n${c.text}`));
      await upsertPoints(
        batch.map((c, j) => ({
          id: crypto.randomUUID(),
          vector: vectors[j],
          payload: {
            campaignId: "global",
            kind: "rule" as const,
            title: c.title,
            text: c.text,
            createdAt: Date.now(),
          },
        })),
      );
      upserted += batch.length;
      console.log(`upserted ${upserted}/${chunks.length}`);
    }
    return { chunks: chunks.length };
  },
});
