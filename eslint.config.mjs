import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  // Convex functions run server-side: React hook rules don't apply (helpers
  // like `useAction` are turn-state utilities, not hooks), and the untyped
  // SRD JSON payloads make `any` the honest type there.
  {
    files: ["convex/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "react-hooks/rules-of-hooks": "off",
    },
  },
]);

export default eslintConfig;
