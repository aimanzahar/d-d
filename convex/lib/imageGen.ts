// Single source of truth for talking to the image-generation gateway. The model
// (IMAGE_MODEL in lib/llm.ts) is qwen-image-2.0 — switched from gpt-image-2 for
// ~7x speed (see docs). qwen returns the image as data[0].url (gpt-image returned
// data[0].b64_json) and rejects the OpenAI quality/format params, so we send a
// minimal payload and parse BOTH response shapes. Stores the bytes in Convex
// storage and returns the storageId; throws on no-data so callers can run their
// own safePrompt retry.
import type { ActionCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { IMAGE_MODEL } from "./llm";

export async function generateAndStoreImage(
  ctx: ActionCtx,
  prompt: string,
  size: string,
): Promise<Id<"_storage">> {
  const res = await fetch(`${process.env.LLM_BASE_URL}/images/generations`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.LLM_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: IMAGE_MODEL,
      prompt: prompt.slice(0, 980),
      n: 1,
      size,
    }),
  });
  const json = await res.json();
  const d = json?.data?.[0];

  let bytes: Uint8Array<ArrayBuffer>;
  let contentType = "image/png";
  if (d?.b64_json) {
    bytes = Uint8Array.from(atob(d.b64_json), (c) => c.charCodeAt(0)) as Uint8Array<ArrayBuffer>;
  } else if (d?.url) {
    // qwen (and most non-OpenAI models) return a hosted URL. A default client UA
    // can be 403'd by the CDN, so send a browser-like one.
    const img = await fetch(d.url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!img.ok) throw new Error(`image download failed: ${img.status}`);
    contentType = img.headers.get("content-type") ?? "image/png";
    bytes = new Uint8Array(await img.arrayBuffer()) as Uint8Array<ArrayBuffer>;
  } else {
    throw new Error(`no image data: ${JSON.stringify(json).slice(0, 220)}`);
  }
  return await ctx.storage.store(new Blob([bytes], { type: contentType }));
}
