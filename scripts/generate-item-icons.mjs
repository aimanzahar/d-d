// One-off icon factory: generates a consistent fantasy inventory icon for every
// SRD equipment item via the gateway image API, downscaled to 128px webp.
// Resumable: existing files are skipped.
//
// Usage:
//   npx convex run smoke:listEquipment > /tmp/equipment.json
//   LLM_BASE_URL=$(npx convex env get LLM_BASE_URL) \
//   LLM_API_KEY=$(npx convex env get LLM_API_KEY) \
//   node scripts/generate-item-icons.mjs /tmp/equipment.json

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const BASE = process.env.LLM_BASE_URL;
const KEY = process.env.LLM_API_KEY;
if (!BASE || !KEY) {
  console.error("Set LLM_BASE_URL and LLM_API_KEY (npx convex env get ...)");
  process.exit(1);
}

const listPath = process.argv[2];
if (!listPath) {
  console.error("Usage: node scripts/generate-item-icons.mjs <equipment.json>");
  process.exit(1);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "public", "icons", "items");
mkdirSync(outDir, { recursive: true });

/** @type {{index: string, name: string}[]} */
const items = JSON.parse(readFileSync(listPath, "utf8"));
// Generic fallback icon for GM-invented custom loot with no keyword match
items.unshift({ index: "_fallback", name: "a small mysterious cloth sack, tied shut" });

const CONCURRENCY = 5;
const STYLE =
  "Fantasy RPG game inventory icon. Single object centered, fills most of the frame, " +
  "viewed at a 3/4 angle, on a plain very dark slate background (#14101f). Painterly " +
  "digital art, warm candlelight rim-lighting, faint gold accents. No text, no border, " +
  "no hands, no people, no watermark.";

async function generateOne({ index, name }) {
  const out = join(outDir, `${index}.webp`);
  if (existsSync(out)) return "skip";
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${BASE}/images/generations`, {
        method: "POST",
        headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gpt-image-2",
          prompt: `${STYLE} The object: ${name}.`,
          n: 1,
          size: "1024x1024",
          quality: "low",
          format: "png",
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
      const json = await res.json();
      const b64 = json.data?.[0]?.b64_json;
      if (!b64) throw new Error(`no image data: ${JSON.stringify(json).slice(0, 160)}`);
      const png = Buffer.from(b64, "base64");
      const webp = await sharp(png).resize(128, 128).webp({ quality: 82 }).toBuffer();
      writeFileSync(out, webp);
      return "ok";
    } catch (e) {
      if (attempt === 2) {
        console.error(`FAIL ${index}: ${String(e).slice(0, 200)}`);
        return "fail";
      }
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
}

let done = 0;
let failed = 0;
let skipped = 0;
const queue = [...items];
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    for (;;) {
      const item = queue.shift();
      if (!item) return;
      const result = await generateOne(item);
      if (result === "fail") failed++;
      else if (result === "skip") skipped++;
      done++;
      if (done % 10 === 0 || done === items.length) {
        console.log(`${done}/${items.length} (skipped ${skipped}, failed ${failed})`);
      }
    }
  }),
);
console.log(`DONE: ${items.length} total, ${skipped} skipped, ${failed} failed`);
process.exit(failed > 0 ? 2 : 0);
