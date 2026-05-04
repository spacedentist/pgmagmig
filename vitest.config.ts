import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 30000,
    dir: "test",
    passWithNoTests: true,
  },
});
