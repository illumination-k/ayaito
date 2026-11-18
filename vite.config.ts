import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    // Each runtime is its own entry, so that only the SDK in use has to be installed.
    entry: ["src/index.ts", "src/acp.ts", "src/claude.ts", "src/codex.ts", "src/opencode.ts"],
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
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {
    printWidth: 120,
  },
});
