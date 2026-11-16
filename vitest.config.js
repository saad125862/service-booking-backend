import { defineConfig } from 'vitest/config';

// Integration tests run against the local PostgreSQL from docker compose (`docker compose up -d db`).
export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./tests/setup.js'],
    fileParallelism: false, // tests share one database
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
