import type { NextConfig } from "next";

// Served behind the shared gateway at /ember (project.a.pinggy.link/ember).
// Inlined at build time — plain <img>/CSS asset paths use lib/basePath.ts.
const basePath = "/ember";

const nextConfig: NextConfig = {
  // Self-contained server bundle for the Docker image
  output: "standalone",
  basePath,
  env: { NEXT_PUBLIC_BASE_PATH: basePath },
  async redirects() {
    return [
      // Courtesy hop for direct (non-gateway) visits to the container root
      { source: "/", destination: basePath, basePath: false, permanent: false },
    ];
  },
};

export default nextConfig;
