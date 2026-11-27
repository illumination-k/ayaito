// @ts-check
/** @type {import("@stryker-mutator/api/core").PartialStrykerOptions} */
export default {
  testRunner: "vitest",
  // pnpm keeps the runner out of Stryker's own reach, so load it from here.
  plugins: [import.meta.resolve("@stryker-mutator/vitest-runner")],
  // The CLI's tests run it in a child process, where Stryker cannot switch mutants or see coverage.
  mutate: ["src/**/*.ts", "!src/cli.ts"],
  // Stryker rewrites tsconfig with the TypeScript JS API, which TypeScript 7 no longer has. The
  // rewrite only matters for project references, which this project does not use, so point it at
  // no file to skip it.
  tsconfigFile: "",
  reporters: ["clear-text", "progress", "html", "json"],
  htmlReporter: { fileName: "reports/mutation/index.html" },
  jsonReporter: { fileName: "reports/mutation/mutation.json" },
  incremental: true,
  incrementalFile: "reports/mutation/stryker-incremental.json",
  coverageAnalysis: "perTest",
  timeoutMS: 10000,
  thresholds: { high: 80, low: 60, break: null },
};
