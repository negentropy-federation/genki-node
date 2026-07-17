import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Git clone + validation fixtures regularly exceed the default 5s under
    // full-suite parallelism on a busy machine.
    testTimeout: 30_000
  }
});
