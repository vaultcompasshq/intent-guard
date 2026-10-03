import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["examples/**/*.test.ts", "scripts/tests/**/*.test.mjs"],
    // Most tests here spawn git and node; the 5 s default fails them on a
    // loaded machine without anything being wrong.
    testTimeout: 15000,
  },
});
