// Token auth, two kinds (both 32-byte hex held in the client's localStorage):
// sessionToken scopes a player to a campaign; accountToken proves who you are
// across campaigns (accountSessions → users).

import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

export async function requirePlayer(
  ctx: QueryCtx | MutationCtx,
  sessionToken: string,
  campaignId?: Id<"campaigns">,
): Promise<Doc<"players">> {
  const player = await ctx.db
    .query("players")
    .withIndex("by_token", (q) => q.eq("sessionToken", sessionToken))
    .unique();
  if (!player || (campaignId && player.campaignId !== campaignId)) {
    throw new ConvexError({ code: "invalid_session" });
  }
  return player;
}

export async function requireHost(
  ctx: QueryCtx | MutationCtx,
  sessionToken: string,
  campaignId?: Id<"campaigns">,
): Promise<Doc<"players">> {
  const player = await requirePlayer(ctx, sessionToken, campaignId);
  if (!player.isHost) throw new ConvexError({ code: "host_only" });
  return player;
}

// Account sessions expire — a leaked localStorage token is not a forever-key.
export const ACCOUNT_SESSION_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

function sessionExpired(session: Doc<"accountSessions">): boolean {
  return Date.now() - session.createdAt > ACCOUNT_SESSION_MAX_AGE_MS;
}

export async function requireAccount(
  ctx: QueryCtx | MutationCtx,
  accountToken: string,
): Promise<{ session: Doc<"accountSessions">; user: Doc<"users"> }> {
  const session = await ctx.db
    .query("accountSessions")
    .withIndex("by_token", (q) => q.eq("token", accountToken))
    .unique();
  const live = session && !sessionExpired(session);
  const user = live ? await ctx.db.get(session.userId) : null;
  if (!session || !user) throw new ConvexError({ code: "invalid_account" });
  return { session, user };
}

// Best-effort account lookup: silent on missing/stale/invalid tokens.
export async function optionalUserId(
  ctx: QueryCtx | MutationCtx,
  accountToken?: string,
): Promise<Id<"users"> | undefined> {
  if (!accountToken) return undefined;
  const session = await ctx.db
    .query("accountSessions")
    .withIndex("by_token", (q) => q.eq("token", accountToken))
    .unique();
  if (!session || sessionExpired(session)) return undefined;
  return session.userId;
}

export function newToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// Unambiguous alphabet (no 0/O/1/I) for invite codes.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function newInviteCode(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}
