"use client";

import { useAction } from "convex/react";
import { ConvexError } from "convex/values";
import { useState } from "react";
import { api } from "@/convex/_generated/api";
import { useAccount } from "@/hooks/useAccount";
import { GoogleButton } from "@/components/landing/GoogleButton";
import { Button } from "@/components/ui/Button";
import { Label, TextInput } from "@/components/ui/Field";
import { OrnateRule } from "@/components/ui/OrnateRule";
import { Panel } from "@/components/ui/Panel";

const ERRORS: Record<string, string> = {
  invalid_email: "That address is not one the ravens can find.",
  weak_password: "Your secret word must be at least 8 characters.",
  email_in_use:
    "That address is already bound to another ledger — sign in, or enter through Google's gate.",
  invalid_credentials: "The ledger shows no such match.",
  account_locked: "Too many failed attempts — the ledger seals itself for a quarter hour.",
  google_invalid: "Google's seal could not be verified. Try again.",
};

function errorMessage(e: unknown): string {
  if (e instanceof ConvexError) {
    const code = (e.data as { code?: string })?.code;
    if (code && ERRORS[code]) return ERRORS[code];
  }
  return "The weave faltered. Try again.";
}

type Tab = "signin" | "register";

// Inline auth panel: email/password sign-in and registration, plus Google.
export function AuthCard({ className = "" }: { className?: string }) {
  const { signIn } = useAccount();
  const login = useAction(api.accounts.login);
  const register = useAction(api.accounts.register);

  const [tab, setTab] = useState<Tab>("signin");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const invalid = !email.trim() || !password || (tab === "register" && !name.trim());

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || invalid) return;
    setBusy(true);
    setError(null);
    try {
      const result =
        tab === "signin"
          ? await login({ email, password })
          : await register({ email, password, name });
      // No setBusy(false) on success — signing in swaps this card away
      signIn(result.accountToken);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Panel className={`max-w-md mx-auto w-full ${className}`} innerClassName="p-7">
      <div className="flex gap-6 mb-6">
        {(
          [
            ["signin", "Sign in"],
            ["register", "Register"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => {
              setTab(key);
              setError(null);
            }}
            className={`font-display text-[0.7rem] tracking-[0.22em] uppercase pb-1 border-b transition-colors cursor-pointer ${
              tab === key
                ? "text-gold border-gold-dim"
                : "text-parchment-faint border-transparent hover:text-parchment-dim"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        {tab === "register" && (
          <label className="block">
            <Label>Your name</Label>
            <TextInput
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="What the table calls you"
              maxLength={24}
              autoComplete="nickname"
            />
          </label>
        )}
        <label className="block">
          <Label>Email</Label>
          <TextInput
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Where the ravens find you"
            maxLength={254}
            autoComplete="email"
          />
        </label>
        <label className="block">
          <Label>Password</Label>
          <TextInput
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="At least 8 characters"
            maxLength={100}
            autoComplete={tab === "signin" ? "current-password" : "new-password"}
          />
        </label>
        <Button
          type="submit"
          variant="ember"
          size="lg"
          className="w-full"
          disabled={busy || invalid}
        >
          {tab === "signin" ? "Open the ledger" : "Bind your name"}
        </Button>
      </form>

      {error && (
        <p className="mt-4 font-narrative italic text-sm text-blood" role="alert">
          {error}
        </p>
      )}

      <OrnateRule className="my-6" />
      <GoogleButton onError={setError} />
      <p className="font-narrative italic text-xs text-parchment-dim text-center mt-3">
        or enter through Google&apos;s gate
      </p>
    </Panel>
  );
}
