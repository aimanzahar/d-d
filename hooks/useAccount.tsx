"use client";

import { useMutation, useQuery } from "convex/react";
import { createContext, useContext, useEffect, useSyncExternalStore, type ReactNode } from "react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { clearAccountToken, getAccountToken, saveAccountToken } from "@/lib/account";
import { clearAllSessionTokens } from "@/lib/session";

export type Account = {
  // undefined = pre-hydration (localStorage unread); null = signed out
  accountToken: string | null | undefined;
  // undefined = loading; null = signed out
  me: { userId: Id<"users">; name: string; email: string; image?: string } | null | undefined;
  signIn: (token: string) => void;
  signOut: () => void;
};

const AccountContext = createContext<Account | null>(null);

// localStorage is the source of truth; this notifier tells useSyncExternalStore
// to re-read it after we change the stored token.
const listeners = new Set<() => void>();
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function notify() {
  for (const listener of listeners) listener();
}
// undefined = server snapshot (localStorage unreadable); null = no token stored
function getServerSnapshot(): string | null | undefined {
  return undefined;
}

export function AccountProvider({ children }: { children: ReactNode }) {
  const token = useSyncExternalStore(subscribe, getAccountToken, getServerSnapshot);

  const me = useQuery(api.accounts.me, token ? { accountToken: token } : "skip");
  const logout = useMutation(api.accounts.logout);

  // Stale self-heal: the server no longer honors the stored token, so drop it.
  useEffect(() => {
    if (token && me === null) {
      clearAccountToken();
      notify();
    }
  }, [token, me]);

  const account: Account = {
    accountToken: token,
    me: token ? me : token === undefined ? undefined : null,
    signIn: (t: string) => {
      saveAccountToken(t);
      notify();
    },
    signOut: () => {
      if (token) void logout({ accountToken: token });
      clearAccountToken();
      // Shared-browser hygiene: the next account must not inherit this one's
      // campaign seats; claimed seats are recoverable via "Your campaigns".
      clearAllSessionTokens();
      notify();
    },
  };

  return <AccountContext.Provider value={account}>{children}</AccountContext.Provider>;
}

export function useAccount(): Account {
  const account = useContext(AccountContext);
  if (!account) throw new Error("useAccount must be used inside <AccountProvider>");
  return account;
}
