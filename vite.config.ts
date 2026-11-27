import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    // Each runtime is its own entry, so that only the SDK in use has to be installed.
    entry: [
      "src/index.ts",
      "src/cli.ts",
      "src/acp.ts",
      "src/agy.ts",
      "src/claude.ts",
      "src/codex.ts",
      "src/opencode.ts",
    ],
    deps: {
      // tsdown <0.23 compatibility: resolve external dependency subpaths.
      // Remove to preserve subpath imports as written (the new default).
      // https://tsdown.dev/options/dependencies#deps-resolvedepsubpath
      resolveDepSubpath: true,
    },
    dts: {
      generator: "tsgo",
    },
    exports: true,
  },
  test: {
    // The mod's tests run in Claude Code: claude plugin test mods/ayaito
    exclude: ["mods/**", "node_modules/**", "dist/**"],
  },
  lint: {
    ignorePatterns: ["mods/**"],
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {
    printWidth: 120,
  },
});
