"use client";

import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect } from "react";
import { saveSessionToken } from "@/lib/session";

// Token-recovery landing: the host reissues a link /c/CODE/restore?t=TOKEN,
// we stash it and bounce to the lobby (the gate validates it there).
function RestoreInner() {
  const params = useParams<{ code: string }>();
  const search = useSearchParams();
  const router = useRouter();

  useEffect(() => {
    const code = (params.code ?? "").toUpperCase();
    const token = search.get("t");
    if (token) saveSessionToken(code, token);
    router.replace(`/c/${code}/lobby`);
  }, [params.code, search, router]);

  return (
    <p className="flex-1 flex items-center justify-center font-display text-xs tracking-[0.4em] uppercase text-parchment-dim animate-flicker">
      Restoring your seat
    </p>
  );
}

export default function RestorePage() {
  return (
    <Suspense fallback={null}>
      <RestoreInner />
    </Suspense>
  );
}
