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
    exclude: ["mods/**", "node_modules/**", "dist/**", ".stryker-tmp/**", "reports/**"],
    coverage: {
      provider: "v8",
      include: ["src/**"],
      // The CLI's tests run it in a child process, which v8 coverage does not see.
      exclude: ["src/cli.ts"],
      reporter: ["text", "html"],
      reportsDirectory: "reports/coverage",
    },
  },
  lint: {
    ignorePatterns: ["mods/**", "dist/**", ".stryker-tmp/**", "reports/**"],
    options: {
      typeAware: true,
      typeCheck: true,
      // Warnings fail CI too, so none pile up unnoticed.
      denyWarnings: true,
    },
    plugins: ["eslint", "typescript", "unicorn", "oxc", "import", "node", "promise", "vitest"],
    categories: {
      correctness: "error",
      suspicious: "error",
      perf: "error",
    },
    rules: {
      curly: ["error", "multi-line"],
      eqeqeq: ["error", "smart"],
      "no-console": "error",
      "no-var": "error",
      "prefer-const": "error",
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "import/no-cycle": "error",
      "import/no-duplicates": "error",
      "unicorn/prefer-node-protocol": "error",
      "typescript/consistent-type-imports": "error",
      "typescript/ban-ts-comment": ["error", { "ts-expect-error": "allow-with-description" }],
      "typescript/no-deprecated": "error",
      "typescript/no-floating-promises": "error",
      "typescript/no-misused-promises": "error",
      "typescript/await-thenable": "error",
      "typescript/switch-exhaustiveness-check": ["error", { considerDefaultExhaustiveForUnions: true }],
      "typescript/prefer-optional-chain": "error",
      "typescript/no-unnecessary-type-assertion": "error",
      // Awaiting in a loop is how a graph runs its steps one after another.
      "no-await-in-loop": "off",
      // Shadowing an outer name is common and harmless in small closures.
      "no-shadow": "off",
      // Runtimes cast SDK events and parsed JSON at the boundary; a guard for each would be noise.
      "typescript/no-unsafe-type-assertion": "off",
      // Helpers defined next to their one use read better than hoisted ones.
      "unicorn/consistent-function-scoping": "off",
      // TypeScript already checks every path returns; this one misreads exhaustive switches.
      "typescript/consistent-return": "off",
      // A `then` that only does work, with a `catch` after it, is clearer without a dummy return.
      "promise/always-return": "off",
    },
    overrides: [
      {
        // The CLI talks to the terminal.
        files: ["src/cli.ts"],
        rules: { "no-console": "off" },
      },
    ],
  },
  fmt: {
    ignorePatterns: [".stryker-tmp/**", "reports/**"],
    printWidth: 120,
  },
});
