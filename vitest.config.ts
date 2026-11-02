import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    clearMocks: true,
    // Real Postgres for DB tests: template DB built once, one clone per worker.
    globalSetup: ['tests/setup/global.ts'],
    setupFiles: ['tests/setup/worker-db.ts'],
  },
})
