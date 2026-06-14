import { defineConfig } from "vitest/config";

// Minimal runner for the pure, dependency-light modules (e.g. convex/gm/voices.ts).
// Not wired to Next/React — these tests import plain TS with no JSX or convex server deps.
export default defineConfig({
  test: {
    include: ["**/*.test.ts"],
    exclude: ["node_modules/**", ".next/**"],
  },
});
