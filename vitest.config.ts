import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["examples/**/*.test.ts", "scripts/tests/**/*.test.mjs"],
  },
});
