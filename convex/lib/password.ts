// PBKDF2-SHA256 password hashing via crypto.subtle — pure helpers, no ctx.
// 600k iterations measured at ~114ms on this self-hosted backend.

const PBKDF2_ITERATIONS = 600_000;
const SALT_BYTES = 16;
const KEY_BITS = 256;

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function derive(
  password: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    KEY_BITS,
  );
  return new Uint8Array(bits);
}

// "pbkdf2-sha256$<iterations>$<saltB64>$<hashB64>"
export async function hashPassword(password: string): Promise<string> {
  const salt = new Uint8Array(SALT_BYTES);
  crypto.getRandomValues(salt);
  const hash = await derive(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2-sha256$${PBKDF2_ITERATIONS}$${toBase64(salt)}$${toBase64(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iterStr, saltB64, hashB64] = stored.split("$");
  const iterations = Number(iterStr);
  if (scheme !== "pbkdf2-sha256" || !Number.isInteger(iterations) || !saltB64 || !hashB64) {
    return false;
  }
  const expected = fromBase64(hashB64);
  const actual = await derive(password, fromBase64(saltB64), iterations);
  if (actual.length !== expected.length) return false;
  // Constant-time compare: XOR-accumulate, no early exit
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= actual[i] ^ expected[i];
  return diff === 0;
}

// Precomputed hash of a fixed throwaway string. Login verifies against this
// when the email is unknown (or Google-only), so timing never reveals whether
// an account exists.
export const DUMMY_HASH =
  "pbkdf2-sha256$600000$k0GRvj9eI4lbvKLzqKGCzA==$qcYhUnBDUmVhVRGa/yoVLG2U2Mk/aa3pAB8XL1XGkeY=";
