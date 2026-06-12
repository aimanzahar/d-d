"use client";

import { useAction } from "convex/react";
import { ConvexError } from "convex/values";
import Script from "next/script";
import { useEffect, useRef, useState } from "react";
import { api } from "@/convex/_generated/api";
import { useAccount } from "@/hooks/useAccount";

// Just enough of the GSI surface for a rendered button — no One Tap.
declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (config: {
            client_id: string;
            callback: (response: { credential: string }) => void;
          }) => void;
          renderButton: (
            parent: HTMLElement,
            options: {
              theme?: string;
              size?: string;
              text?: string;
              shape?: string;
              width?: number;
            },
          ) => void;
        };
      };
    };
  }
}

// "Continue with Google" button. Renders nothing when no client id is
// configured; errors surface through `onError` when given, inline otherwise.
export function GoogleButton({ onError }: { onError?: (msg: string) => void }) {
  const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
  const googleSignIn = useAction(api.accounts.googleSignIn);
  const { signIn } = useAccount();
  const divRef = useRef<HTMLDivElement>(null);
  const [blocked, setBlocked] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  async function handle(credential: string) {
    try {
      const result = await googleSignIn({ credential });
      signIn(result.accountToken);
    } catch (e) {
      const code = e instanceof ConvexError ? (e.data as { code?: string })?.code : undefined;
      const msg =
        code === "google_invalid"
          ? "Google's seal could not be verified. Try again."
          : "The weave faltered. Try again.";
      if (onError) onError(msg);
      else setLocalError(msg);
    }
  }

  // GSI's callback is registered once per mount (in onReady) — route it
  // through a ref so it always sees the latest closure.
  const handleRef = useRef(handle);
  useEffect(() => {
    handleRef.current = handle;
  });

  if (!clientId) return null;

  // next/script dedupes by src, but onReady fires on every mount of this
  // component — re-initializing and re-rendering the button each time is
  // exactly what GSI needs after the card unmounts and comes back.
  function init() {
    if (!clientId || !window.google || !divRef.current) return;
    window.google.accounts.id.initialize({
      client_id: clientId,
      callback: (response) => void handleRef.current(response.credential),
    });
    window.google.accounts.id.renderButton(divRef.current, {
      theme: "filled_black",
      size: "large",
      text: "continue_with",
      shape: "rectangular",
      // size to the card so the GSI iframe never overflows small phones (GIS caps at 400)
      width: Math.min(divRef.current.offsetWidth || 300, 400),
    });
  }

  return (
    <div className="flex flex-col items-center gap-2">
      {/* onLoad too: if this instance mounted while the script was still in
          flight (previous instance unmounted), onReady fires into the dead
          instance — onLoad is what reaches the live one. Double init is
          harmless: GIS just re-renders into the same div. */}
      <Script
        src="https://accounts.google.com/gsi/client"
        strategy="afterInteractive"
        onReady={init}
        onLoad={init}
        onError={() => setBlocked(true)}
      />
      {blocked ? (
        <p className="font-narrative italic text-xs text-parchment-dim">
          Google&apos;s gate is blocked &mdash; use email instead.
        </p>
      ) : (
        <div ref={divRef} className="min-h-[44px]" />
      )}
      {!onError && localError && (
        <p className="font-narrative italic text-xs text-blood" role="alert">
          {localError}
        </p>
      )}
    </div>
  );
}
