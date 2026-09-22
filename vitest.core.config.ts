import { defineConfig } from "vitest/config";

// Core tests only, for the mutation run. The full config also runs the database tests.
export default defineConfig({
  test: {
    include: ["packages/core/src/**/*.test.ts"],
  },
});
