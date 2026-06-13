// Client mirror of convex/images.ts publicStorageUrl. The self-hosted Convex
// origin (CONVEX_CLOUD_ORIGIN) is a LAN address, so storage URLs — including the
// upload URL from generateUploadUrl — are rewritten onto the public proxy origin
// before the browser uses them.
export function publicStorageUrl(url: string): string {
  try {
    const u = new URL(url);
    return `https://convex.zahar.my${u.pathname}${u.search}`;
  } catch {
    return url;
  }
}
