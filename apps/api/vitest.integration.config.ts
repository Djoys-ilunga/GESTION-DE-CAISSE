import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    setupFiles: ['test/integration/isolate-throttle.ts'],
    include: ['test/integration/*.spec.ts'],
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
