/**
 * @fileoverview Vitest configuration.
 */
import process from 'node:process'

import { defineConfig } from 'vitest/config'

const isCoverageEnabled =
  process.env.COVERAGE === 'true' ||
  process.argv.some(arg => arg.includes('coverage'))

// oxlint-disable-next-line socket/no-default-export -- vitest config requires a default export.
export default defineConfig({
  test: {
    deps: {
      interopDefault: false,
    },
    globals: false,
    environment: 'node',
    // Disable workspace-project discovery — pnpm-workspace.yaml lists
    // .claude/hooks/* as workspace packages so they get treated as
    // their own vitest projects, but those tests use node:test and
    // are run by the hooks themselves, not by this repo's vitest.
    projects: [{ test: { include: ['test/**/*.test.{js,ts,mjs,mts,cjs}'] } }],
    include: ['test/**/*.test.{js,ts,mjs,mts,cjs}'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/out/**',
      '**/.cache/**',
      '**/.claude/**',
    ],
    reporters: ['default'],
    // Vitest 4 moved poolOptions.threads.* to top-level. Keeping
    // single-threaded under coverage for deterministic v8 instrumentation.
    pool: 'threads',
    isolate: false,
    maxWorkers: isCoverageEnabled ? 1 : 16,
    minWorkers: isCoverageEnabled ? 1 : 2,
    testTimeout: 10_000,
    hookTimeout: 10_000,
    bail: process.env.CI ? 1 : 0,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov', 'clover'],
      exclude: [
        '**/*.config.*',
        '**/node_modules/**',
        '**/[.]**',
        '**/*.d.ts',
        '**/virtual:*',
        'coverage/**',
        'dist/**',
        'scripts/**',
        'test/**',
      ],
      all: true,
      clean: true,
      skipFull: false,
    },
  },
})
