// Qdrant REST access via plain fetch (no js-client: avoids its port-6333
// default on proxied https URLs). Smoke-tested against the live instance.

import { EMBEDDING_DIM } from "./llm";

export const COLLECTION = "dnd_memory";

export type MemoryKind = "scene" | "npc" | "lore" | "rule";

export type MemoryPayload = {
  campaignId: string; // Convex campaign id, or 'global' for SRD rules
  kind: MemoryKind;
  text: string;
  title?: string;
  createdAt: number; // epoch ms — integer index enables scroll order_by
};

function headers(): Record<string, string> {
  const key = process.env.QDRANT_API_KEY;
  if (!key) throw new Error("Missing env var QDRANT_API_KEY");
  return { "api-key": key, "Content-Type": "application/json" };
}

function base(): string {
  const url = process.env.QDRANT_URL;
  if (!url) throw new Error("Missing env var QDRANT_URL");
  return url;
}

async function request(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${base()}${path}`, { ...init, headers: headers() });
  const text = await res.text();
  if (!res.ok) throw new Error(`Qdrant ${res.status} ${path}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

// Creates the collection + payload indexes if missing. Idempotent.
export async function ensureCollection(): Promise<{ created: boolean }> {
  const existing = await fetch(`${base()}/collections/${COLLECTION}`, {
    headers: headers(),
  });
  if (existing.ok) return { created: false };

  await request(`/collections/${COLLECTION}`, {
    method: "PUT",
    body: JSON.stringify({
      vectors: { size: EMBEDDING_DIM, distance: "Cosine" },
    }),
  });
  await request(`/collections/${COLLECTION}/index`, {
    method: "PUT",
    body: JSON.stringify({
      field_name: "campaignId",
      field_schema: { type: "keyword", is_tenant: true },
    }),
  });
  await request(`/collections/${COLLECTION}/index`, {
    method: "PUT",
    body: JSON.stringify({ field_name: "kind", field_schema: { type: "keyword" } }),
  });
  await request(`/collections/${COLLECTION}/index`, {
    method: "PUT",
    body: JSON.stringify({ field_name: "createdAt", field_schema: { type: "integer" } }),
  });
  return { created: true };
}

export async function upsertPoints(
  points: { id: string; vector: number[]; payload: MemoryPayload }[],
): Promise<void> {
  if (points.length === 0) return;
  await request(`/collections/${COLLECTION}/points?wait=true`, {
    method: "PUT",
    body: JSON.stringify({ points }),
  });
}

export type SearchHit = { id: string; score: number; payload: MemoryPayload };

export async function search(opts: {
  vector: number[];
  campaignId: string;
  kinds?: MemoryKind[];
  limit: number;
}): Promise<SearchHit[]> {
  const must: unknown[] = [{ key: "campaignId", match: { value: opts.campaignId } }];
  if (opts.kinds && opts.kinds.length > 0) {
    must.push({ key: "kind", match: { any: opts.kinds } });
  }
  const json = await request(`/collections/${COLLECTION}/points/query`, {
    method: "POST",
    body: JSON.stringify({
      query: opts.vector,
      filter: { must },
      limit: opts.limit,
      with_payload: true,
    }),
  });
  return (json.result?.points ?? []).map((p: any) => ({
    id: String(p.id),
    score: p.score,
    payload: p.payload as MemoryPayload,
  }));
}

// Most-recent memories by createdAt (requires the integer payload index).
export async function recent(opts: {
  campaignId: string;
  kind: MemoryKind;
  limit: number;
}): Promise<SearchHit[]> {
  const json = await request(`/collections/${COLLECTION}/points/scroll`, {
    method: "POST",
    body: JSON.stringify({
      filter: {
        must: [
          { key: "campaignId", match: { value: opts.campaignId } },
          { key: "kind", match: { value: opts.kind } },
        ],
      },
      order_by: { key: "createdAt", direction: "desc" },
      limit: opts.limit,
      with_payload: true,
    }),
  });
  return (json.result?.points ?? []).map((p: any) => ({
    id: String(p.id),
    score: 0,
    payload: p.payload as MemoryPayload,
  }));
}

export async function deleteByFilter(filter: {
  campaignId: string;
  kind?: MemoryKind;
}): Promise<void> {
  const must: unknown[] = [{ key: "campaignId", match: { value: filter.campaignId } }];
  if (filter.kind) must.push({ key: "kind", match: { value: filter.kind } });
  await request(`/collections/${COLLECTION}/points/delete?wait=true`, {
    method: "POST",
    body: JSON.stringify({ filter: { must } }),
  });
}
