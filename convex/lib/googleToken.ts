// Manual Google ID-token (JWT) verification — no SDK. Fetches Google's JWKS,
// verifies the RS256 signature with crypto.subtle, then checks the claims.
// Every failure collapses to ConvexError({ code: "google_invalid" }) and the
// credential is never logged.

import { ConvexError } from "convex/values";

const JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const MAX_JWKS_TTL_MS = 60 * 60 * 1000; // cap Cache-Control max-age at 1h
const CLOCK_SKEW_S = 60;

type GoogleJwk = JsonWebKey & { kid?: string };

// Module-level JWKS cache, honoring Cache-Control max-age
let jwksCache: { keys: GoogleJwk[]; expiresAt: number } | null = null;
// Throttles attacker-controlled kid-miss refetches (and floors the TTL below)
let lastJwksFetchAt = 0;
const MIN_JWKS_TTL_MS = 5 * 60 * 1000;
const ROTATION_REFETCH_MIN_INTERVAL_MS = 60 * 1000;

export type GoogleProfile = {
  sub: string;
  email: string;
  emailVerified: boolean;
  name?: string;
  picture?: string;
};

function fail(): never {
  throw new ConvexError({ code: "google_invalid" });
}

function base64urlToBytes(part: string): Uint8Array<ArrayBuffer> {
  const b64 =
    part.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (part.length % 4)) % 4);
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeJsonPart(part: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(base64urlToBytes(part)));
}

async function fetchJwks(): Promise<GoogleJwk[]> {
  const res = await fetch(JWKS_URL);
  if (!res.ok) fail();
  const body = (await res.json()) as { keys?: GoogleJwk[] };
  if (!Array.isArray(body.keys)) fail();
  const maxAge = /max-age=(\d+)/.exec(res.headers.get("cache-control") ?? "");
  const ttlMs = Math.min(
    Math.max(maxAge ? Number(maxAge[1]) * 1000 : 0, MIN_JWKS_TTL_MS),
    MAX_JWKS_TTL_MS,
  );
  lastJwksFetchAt = Date.now();
  jwksCache = { keys: body.keys, expiresAt: Date.now() + ttlMs };
  return body.keys;
}

async function getJwk(kid: string): Promise<GoogleJwk> {
  let keys =
    jwksCache && jwksCache.expiresAt > Date.now() ? jwksCache.keys : await fetchJwks();
  let jwk = keys.find((k) => k.kid === kid);
  if (!jwk && Date.now() - lastJwksFetchAt > ROTATION_REFETCH_MIN_INTERVAL_MS) {
    // Key rotation: refetch once on a kid miss — but kid is attacker-supplied,
    // so a recent fetch means the miss is bogus, not a rotation.
    keys = await fetchJwks();
    jwk = keys.find((k) => k.kid === kid);
  }
  if (!jwk) fail();
  return jwk;
}

export async function verifyGoogleIdToken(
  credential: string,
  clientId: string,
): Promise<GoogleProfile> {
  try {
    return await verify(credential, clientId);
  } catch {
    fail(); // collapse parse/crypto errors — never leak (or log) the credential
  }
}

async function verify(credential: string, clientId: string): Promise<GoogleProfile> {
  const parts = credential.split(".");
  if (parts.length !== 3) fail();
  const [headerB64, payloadB64, signatureB64] = parts;

  const header = decodeJsonPart(headerB64);
  if (header.alg !== "RS256" || typeof header.kid !== "string") fail();

  const key = await crypto.subtle.importKey(
    "jwk",
    await getJwk(header.kid),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    base64urlToBytes(signatureB64),
    new TextEncoder().encode(`${headerB64}.${payloadB64}`),
  );
  if (!valid) fail();

  const payload = decodeJsonPart(payloadB64);
  if (payload.iss !== "https://accounts.google.com" && payload.iss !== "accounts.google.com") {
    fail();
  }
  if (payload.aud !== clientId) fail();
  if (typeof payload.exp !== "number" || payload.exp <= Date.now() / 1000 - CLOCK_SKEW_S) {
    fail();
  }
  if (typeof payload.sub !== "string" || typeof payload.email !== "string") fail();

  return {
    sub: payload.sub,
    email: payload.email,
    emailVerified: payload.email_verified === true || payload.email_verified === "true",
    name: typeof payload.name === "string" ? payload.name : undefined,
    picture: typeof payload.picture === "string" ? payload.picture : undefined,
  };
}
