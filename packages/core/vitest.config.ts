import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Many tests spawn git; the 5 s default fails them on a loaded machine.
    testTimeout: 15000,
  },
});
