// Shims for insecure contexts (plain-HTTP LAN testing). Browsers gate
// crypto.randomUUID and navigator.clipboard behind secure contexts; the
// presence component needs the former on every lobby/play screen.
// Imported for its side effect at the top of ConvexClientProvider.

if (typeof window !== "undefined" && typeof window.crypto?.randomUUID !== "function") {
  // crypto.getRandomValues IS available in insecure contexts — build a v4 UUID
  (window.crypto as Crypto & { randomUUID: () => string }).randomUUID = () => {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
    return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}` as `${string}-${string}-${string}-${string}-${string}`;
  };
}

// Clipboard write with a legacy fallback for insecure contexts.
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand("copy");
    textarea.remove();
    return ok;
  } catch {
    return false;
  }
}
