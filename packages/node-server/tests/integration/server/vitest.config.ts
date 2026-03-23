import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/server-integration/server-api.test.ts'],
    fileParallelism: false,
    minWorkers: 1,
    maxWorkers: 1,
    testTimeout: 10_000,
    hookTimeout: 10_000,
  },
});