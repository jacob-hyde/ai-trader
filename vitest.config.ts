import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/src/**/*.test.ts", "apps/**/src/**/*.test.ts", "data/test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      // Only the decision core is held to a threshold. It is pure, so every path is reachable from a test.
      include: ["packages/core/src/**/*.ts"],
      exclude: ["packages/core/src/**/*.test.ts", "packages/core/src/__fixtures__/**"],
      reporter: ["text", "lcov"],
      thresholds: { lines: 100, branches: 100, functions: 100, statements: 100 },
    },
  },
});
