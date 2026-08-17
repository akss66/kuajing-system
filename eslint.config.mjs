import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTypeScript,
  globalIgnores([
    ".agents/**",
    ".claude/**",
    ".codex/**",
    ".codex-temp/**",
    ".grok/**",
    ".impeccable/**",
    ".next/**",
    ".worktrees/**",
    "coverage/**",
    "playwright-report/**",
    "test-results/**",
  ]),
]);
