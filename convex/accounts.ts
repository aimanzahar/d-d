// Accounts: email+password and Google sign-in. Hashing/JWT verification runs
// in actions (crypto.subtle, fetch); the database work happens in internal
// functions. Public reads degrade gracefully — a stale accountToken yields
// null/[] rather than an error — while mutations throw invalid_account.

import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  type MutationCtx,
  query,
  type QueryCtx,
} from "./_generated/server";
import {
  ACCOUNT_SESSION_MAX_AGE_MS,
  newToken,
  optionalUserId,
  requireAccount,
} from "./lib/auth";
import { verifyGoogleIdToken } from "./lib/googleToken";
import { DUMMY_HASH, hashPassword, verifyPassword } from "./lib/password";

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_FAILED_LOGINS = 10;
const LOCKOUT_MS = 15 * 60_000;

// ── Actions (validate + hash/verify, then hand off to internal functions) ──

export const register = action({
  args: { email: v.string(), password: v.string(), name: v.string() },
  handler: async (ctx, args): Promise<{ accountToken: string }> => {
    const email = args.email.trim().toLowerCase();
    if (!email || email.length > 254 || !EMAIL_SHAPE.test(email)) {
      throw new ConvexError({ code: "invalid_email" });
    }
    if (args.password.length < 8 || args.password.length > 100) {
      throw new ConvexError({ code: "weak_password" });
    }
    const name = args.name.trim();
    if (!name || name.length > 24) throw new ConvexError({ code: "missing_fields" });

    const passwordHash = await hashPassword(args.password);
    const accountToken: string = await ctx.runMutation(
      internal.accounts.createUserAndSession,
      { email, name, passwordHash },
    );
    return { accountToken };
  },
});

export const login = action({
  args: { email: v.string(), password: v.string() },
  handler: async (ctx, args): Promise<{ accountToken: string }> => {
    const email = args.email.trim().toLowerCase();
    // Lockout gate + attempt counting happen atomically in one mutation BEFORE
    // the expensive verify — concurrent bursts can't race past the cap.
    try {
      await ctx.runMutation(internal.accounts.preflightLogin, { email });
    } catch (e) {
      // burn the PBKDF2 cost so a locked account answers as slowly as a miss
      await verifyPassword(args.password, DUMMY_HASH);
      throw e;
    }
    const user: Doc<"users"> | null = await ctx.runQuery(internal.accounts.getUserByEmail, {
      email,
    });
    if (!user || !user.passwordHash) {
      // Unknown email or Google-only account: burn the same PBKDF2 cost and
      // throw the same error so neither timing nor message reveals existence.
      await verifyPassword(args.password, DUMMY_HASH);
      throw new ConvexError({ code: "invalid_credentials" });
    }
    if (!(await verifyPassword(args.password, user.passwordHash))) {
      throw new ConvexError({ code: "invalid_credentials" }); // preflight already counted it
    }
    const accountToken: string = await ctx.runMutation(internal.accounts.createSession, {
      userId: user._id,
    });
    return { accountToken };
  },
});

export const googleSignIn = action({
  args: { credential: v.string() },
  handler: async (ctx, args): Promise<{ accountToken: string }> => {
    const clientId = process.env.AUTH_GOOGLE_ID;
    if (!clientId) throw new ConvexError({ code: "google_invalid" });
    const profile = await verifyGoogleIdToken(args.credential, clientId);
    // Only verified emails may link to (or create) an account by address
    if (!profile.emailVerified) throw new ConvexError({ code: "google_invalid" });
    const accountToken: string = await ctx.runMutation(internal.accounts.upsertGoogleUser, {
      sub: profile.sub,
      email: profile.email.trim().toLowerCase(),
      name: profile.name,
      picture: profile.picture,
    });
    return { accountToken };
  },
});

// ── Internal plumbing ──

// The ONLY place passwordHash crosses a function boundary — never expose it
// from a public query.
export const getUserByEmail = internalQuery({
  args: { email: v.string() },
  handler: async (ctx, args): Promise<Doc<"users"> | null> => {
    return await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", args.email))
      .unique();
  },
});

async function insertSession(ctx: MutationCtx, userId: Id<"users">): Promise<string> {
  const token = newToken();
  await ctx.db.insert("accountSessions", { userId, token, createdAt: Date.now() });
  // Successful auth clears the lockout bookkeeping
  await ctx.db.patch(userId, { failedLogins: undefined, lockedUntil: undefined });
  return token;
}

export const createUserAndSession = internalMutation({
  args: { email: v.string(), name: v.string(), passwordHash: v.string() },
  handler: async (ctx, args): Promise<string> => {
    // Atomic recheck: the action hashed outside this transaction, so another
    // register/googleSignIn may have claimed the email in the meantime.
    const holder = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", args.email))
      .unique();
    // One code regardless of how the holder signs in — auth method is not
    // something an unauthenticated caller should learn.
    if (holder) throw new ConvexError({ code: "email_in_use" });
    const userId = await ctx.db.insert("users", {
      email: args.email,
      name: args.name,
      passwordHash: args.passwordHash,
    });
    return await insertSession(ctx, userId);
  },
});

export const upsertGoogleUser = internalMutation({
  args: {
    sub: v.string(),
    email: v.string(),
    name: v.optional(v.string()),
    picture: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<string> => {
    const bySub = await ctx.db
      .query("users")
      .withIndex("by_googleSub", (q) => q.eq("googleSub", args.sub))
      .unique();
    if (bySub) return await insertSession(ctx, bySub._id);

    const byEmail = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", args.email))
      .unique();
    if (byEmail) {
      // Already bound to a DIFFERENT Google identity: sub is the immutable
      // key — never re-bind by email (recycled addresses would hijack it).
      if (byEmail.googleSub && byEmail.googleSub !== args.sub) {
        throw new ConvexError({ code: "google_invalid" });
      }
      // Google verified email ownership; a password on this address never
      // was (no email-verification flow exists). Evict the password and its
      // sessions so a squatter who pre-registered the victim's email can't
      // keep a backdoor into the account (pre-hijack defense).
      if (byEmail.passwordHash) {
        const sessions = await ctx.db
          .query("accountSessions")
          .withIndex("by_user", (q) => q.eq("userId", byEmail._id))
          .collect();
        for (const s of sessions) await ctx.db.delete(s._id);
      }
      await ctx.db.patch(byEmail._id, {
        googleSub: args.sub,
        passwordHash: undefined,
        image: args.picture ?? byEmail.image,
      });
      return await insertSession(ctx, byEmail._id);
    }

    const name = (args.name ?? args.email.split("@")[0]).trim().slice(0, 24) || "Adventurer";
    const userId = await ctx.db.insert("users", {
      email: args.email,
      name,
      googleSub: args.sub,
      image: args.picture,
    });
    return await insertSession(ctx, userId);
  },
});

// Serialized lockout gate: counts the attempt and throws when over the cap,
// all in one transaction, so concurrent login bursts can't outrun the limit.
// A successful login resets the counter via insertSession.
export const preflightLogin = internalMutation({
  args: { email: v.string() },
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", args.email))
      .unique();
    if (!user) return; // unknown email — the action burns a dummy verify
    if (user.lockedUntil && user.lockedUntil > Date.now()) {
      throw new ConvexError({ code: "account_locked" });
    }
    const failed = (user.failedLogins ?? 0) + 1;
    if (failed > MAX_FAILED_LOGINS) {
      await ctx.db.patch(user._id, { failedLogins: 0, lockedUntil: Date.now() + LOCKOUT_MS });
      throw new ConvexError({ code: "account_locked" });
    }
    await ctx.db.patch(user._id, { failedLogins: failed });
  },
});

export const createSession = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, args): Promise<string> => insertSession(ctx, args.userId),
});

// ── Public reads (null/[] on stale tokens — never throw) ──

async function sessionUser(
  ctx: QueryCtx,
  accountToken: string,
): Promise<Doc<"users"> | null> {
  const session = await ctx.db
    .query("accountSessions")
    .withIndex("by_token", (q) => q.eq("token", accountToken))
    .unique();
  if (!session || Date.now() - session.createdAt > ACCOUNT_SESSION_MAX_AGE_MS) return null;
  return await ctx.db.get(session.userId);
}

// Daily cron sweep — expired account sessions are dead weight.
export const pruneExpiredSessions = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - ACCOUNT_SESSION_MAX_AGE_MS;
    const expired = (await ctx.db.query("accountSessions").collect()).filter(
      (s) => s.createdAt < cutoff,
    );
    for (const s of expired) await ctx.db.delete(s._id);
    return expired.length;
  },
});

export const me = query({
  args: { accountToken: v.string() },
  handler: async (ctx, args) => {
    const user = await sessionUser(ctx, args.accountToken);
    if (!user) return null;
    return { userId: user._id, name: user.name, email: user.email, image: user.image };
  },
});

// Every campaign this account holds a seat in, for the landing-page shelf.
export const myCampaigns = query({
  args: { accountToken: v.string() },
  handler: async (ctx, args) => {
    const user = await sessionUser(ctx, args.accountToken);
    if (!user) return [];
    const players = await ctx.db
      .query("players")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();
    const rows = [];
    for (const p of players) {
      const campaign = await ctx.db.get(p.campaignId);
      if (!campaign) continue;
      const character = p.characterId ? await ctx.db.get(p.characterId) : null;
      rows.push({
        inviteCode: campaign.inviteCode,
        campaignName: campaign.name,
        campaignStatus: campaign.status,
        nickname: p.nickname,
        isHost: p.isHost,
        characterName: character?.name ?? null,
        characterLevel: character?.level ?? null,
        lastSeenAt: p.lastSeenAt,
      });
    }
    return rows;
  },
});

// Does this account already hold a seat in the campaign behind inviteCode?
export const playerInCampaign = query({
  args: { accountToken: v.string(), inviteCode: v.string() },
  handler: async (ctx, args) => {
    const user = await sessionUser(ctx, args.accountToken);
    if (!user) return null;
    const campaign = await ctx.db
      .query("campaigns")
      .withIndex("by_inviteCode", (q) =>
        q.eq("inviteCode", args.inviteCode.trim().toUpperCase()),
      )
      .unique();
    if (!campaign) return null;
    const players = await ctx.db
      .query("players")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();
    const player = players.find((p) => p.campaignId === campaign._id);
    if (!player) return null;
    const character = player.characterId ? await ctx.db.get(player.characterId) : null;
    return {
      nickname: player.nickname,
      isHost: player.isHost,
      characterName: character?.name ?? null,
      campaignStatus: campaign.status,
    };
  },
});

// ── Mutations ──

// Hand back the existing player sessionToken for a campaign this account
// already belongs to (no rotation — other devices stay signed in).
export const rejoinCampaign = mutation({
  args: { accountToken: v.string(), inviteCode: v.string() },
  handler: async (ctx, args) => {
    const { user } = await requireAccount(ctx, args.accountToken);
    const campaign = await ctx.db
      .query("campaigns")
      .withIndex("by_inviteCode", (q) =>
        q.eq("inviteCode", args.inviteCode.trim().toUpperCase()),
      )
      .unique();
    if (!campaign) throw new ConvexError({ code: "campaign_not_found" });
    const players = await ctx.db
      .query("players")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();
    const player = players.find((p) => p.campaignId === campaign._id);
    if (!player) throw new ConvexError({ code: "not_a_member" });
    await ctx.db.patch(player._id, { lastSeenAt: Date.now() });
    return { inviteCode: campaign.inviteCode, sessionToken: player.sessionToken };
  },
});

// Attach a pre-accounts (legacy) player to this account. Never throws: the
// claim is opportunistic and the caller just moves on either way.
export const claimPlayer = mutation({
  args: { sessionToken: v.string(), accountToken: v.string() },
  handler: async (ctx, args): Promise<{ claimed: boolean }> => {
    const userId = await optionalUserId(ctx, args.accountToken);
    if (!userId) return { claimed: false };
    const player = await ctx.db
      .query("players")
      .withIndex("by_token", (q) => q.eq("sessionToken", args.sessionToken))
      .unique();
    if (!player) return { claimed: false };
    if (player.userId) return { claimed: player.userId === userId };
    const mine = await ctx.db
      .query("players")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    // One seat per campaign per account
    if (mine.some((p) => p.campaignId === player.campaignId)) return { claimed: false };
    await ctx.db.patch(player._id, { userId });
    return { claimed: true };
  },
});

export const logout = mutation({
  args: { accountToken: v.string() },
  handler: async (ctx, args) => {
    const session = await ctx.db
      .query("accountSessions")
      .withIndex("by_token", (q) => q.eq("token", args.accountToken))
      .unique();
    if (session) await ctx.db.delete(session._id);
    return null;
  },
});
