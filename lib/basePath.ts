// next/link and routing get the basePath for free; plain <img> srcs and CSS
// url() values do not — route static asset paths through here.
export function withBasePath(path: string): string {
  return `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}${path}`;
}
