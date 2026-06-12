// Session tokens per campaign, keyed by invite code, in localStorage.

const KEY = "emberquill.sessions";

type SessionMap = Record<string, string>; // inviteCode -> sessionToken

function readAll(): SessionMap {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(window.localStorage.getItem(KEY) ?? "{}") as SessionMap;
  } catch {
    return {};
  }
}

export function getSessionToken(inviteCode: string): string | null {
  return readAll()[inviteCode.toUpperCase()] ?? null;
}

export function saveSessionToken(inviteCode: string, token: string): void {
  const all = readAll();
  all[inviteCode.toUpperCase()] = token;
  window.localStorage.setItem(KEY, JSON.stringify(all));
}

export function clearSessionToken(inviteCode: string): void {
  const all = readAll();
  delete all[inviteCode.toUpperCase()];
  window.localStorage.setItem(KEY, JSON.stringify(all));
}

// Sign-out hygiene: on a shared browser, the next account must not inherit
// this one's seats. Claimed seats are recoverable via "Your campaigns".
export function clearAllSessionTokens(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(KEY);
}
