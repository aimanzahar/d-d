// Account token (one per browser, shared across campaigns) in localStorage.

const KEY = "emberquill.account";

export function getAccountToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(KEY);
}

export function saveAccountToken(token: string): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(KEY, token);
}

export function clearAccountToken(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(KEY);
}
