import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Many tests run ffmpeg on real clips; on a busy machine 5 s is too tight (npm publish runs the whole suite).
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // A few workers: ffmpeg is already parallel, and a worker per core starves it.
    maxWorkers: 2,
  },
});
