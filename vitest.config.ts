import { randomBytes } from 'node:crypto'
import { defineConfig } from 'vitest/config'

// Unique per test run so concurrent runs (several agents/terminals) never share
// or drop each other's databases. Inherited by the worker processes.
process.env.LUMA_TEST_RUN ??= randomBytes(4).toString('hex')

export default defineConfig({
  test: {
    environment: 'node',
    clearMocks: true,
    // Real Postgres for DB tests: template DB built once, one clone per worker.
    globalSetup: ['tests/setup/global.ts'],
    setupFiles: ['tests/setup/worker-db.ts'],
  },
})
