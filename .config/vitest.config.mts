/**
 * @fileoverview Vitest configuration.
 */
import process from 'node:process'

import { defineConfig } from 'vitest/config'

const isCoverageEnabled =
  process.env.COVERAGE === 'true' ||
  process.argv.some(arg => arg.includes('coverage'))

export default defineConfig({
  test: {
    deps: {
      interopDefault: false,
    },
    globals: false,
    environment: 'node',
    include: ['test/**/*.test.{js,ts,mjs,mts,cjs}'],
    reporters: ['default'],
    pool: 'threads',
    poolOptions: {
      threads: {
        singleThread: isCoverageEnabled,
        maxThreads: isCoverageEnabled ? 1 : 16,
        minThreads: isCoverageEnabled ? 1 : 2,
        isolate: false,
        useAtomics: true,
      },
    },
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
