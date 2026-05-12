/**
 * @fileoverview Canonical minimal test runner for socket-* repos.
 *
 * Scope modes:
 *   (default)   Run tests covering files modified in the working tree vs HEAD.
 *   --staged    Run tests covering files in the git index (pre-commit hook).
 *   --all       Run the full test suite.
 *
 * Flags:
 *   --quiet     Suppress progress output.
 *
 * Scope-to-tests mapping (adapt per repo layout):
 *   - Changed test files run themselves.
 *   - Changed source files under `packages/<pkg>/src/` run the sibling
 *     `packages/<pkg>/test/` folder. Non-workspace repos can adapt the
 *     resolveTestPatterns() function to their layout (e.g. single src/ +
 *     test/ at root, or tests colocated with source).
 *   - Config / infrastructure changes escalate to the full suite.
 *
 * This is the minimal zero-dependency reference implementation. Larger repos
 * (socket-registry, socket-sdk-js, socket-packageurl-js, etc.) use a richer
 * version; this one keeps the same CLI contract so pre-commit hooks and CI
 * work identically across repos.
 */

import { execFileSync, execSync } from 'node:child_process'
import type { ExecSyncOptions } from 'node:child_process'
import { existsSync } from 'node:fs'
import process from 'node:process'
import { getDefaultLogger } from '@socketsecurity/lib/logger'

const logger = getDefaultLogger()

const args = process.argv.slice(2)
const mode: 'staged' | 'all' | 'modified' = args.includes('--all')
  ? 'all'
  : args.includes('--staged')
    ? 'staged'
    : 'modified'
const quiet = args.includes('--quiet') || args.includes('--silent')
const stdio: ExecSyncOptions['stdio'] = quiet ? 'pipe' : 'inherit'

// Paths that, when changed, force the full suite to run.
const ESCALATION_PATTERNS = [
  /^\.config\//,
  /^scripts\//,
  /^pnpm-lock\.yaml$/,
  /^tsconfig.*\.json$/,
  /^\.oxlintrc\.json$/,
  /^\.oxfmtrc\.json$/,
  /^vitest\.config\.(js|mjs|mts|ts)$/,
  /^package\.json$/,
  /^lockstep\.schema\.json$/,
]

export function getModifiedFiles(): string[] {
  return gitFiles('git diff --name-only --diff-filter=ACMR HEAD')
}

export function getStagedFiles(): string[] {
  return gitFiles('git diff --cached --name-only --diff-filter=ACMR')
}

export function gitFiles(command: string): string[] {
  try {
    const out = execSync(command, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return out
      .split('\n')
      .map(s => s.trim())
      .filter(s => s.length > 0)
  } catch {
    return []
  }
}

export function log(msg: string): void {
  if (!quiet) {
    logger.log(msg)
  }
}

/**
 * Map changed files to vitest test patterns.
 *
 * Default implementation handles two common layouts:
 *   - pnpm workspace: packages/<pkg>/src/... → packages/<pkg>/test
 *   - single repo:    src/... → test
 * Adapt to your repo's layout if different.
 */
export function resolveTestPatterns(files: string[]): string[] {
  const patterns = new Set<string>()
  for (let i = 0, { length } = files; i < length; i += 1) {
    const f = files[i]
    // Test file itself.
    if (/\.test\.(m?[jt]s)$/.test(f)) {
      patterns.add(f)
      continue
    }
    // Workspace source file. Only emit the pattern if the test dir exists;
    // packages without a test/ directory are skipped rather than making
    // vitest error on an unknown pattern.
    const wsMatch = f.match(/^(packages\/[^/]+)\/src\//)
    if (wsMatch && existsSync(`${wsMatch[1]}/test`)) {
      patterns.add(`${wsMatch[1]}/test`)
      continue
    }
    // Single-repo source file.
    if (f.startsWith('src/') && existsSync('test')) {
      patterns.add('test')
    }
  }
  return [...patterns]
}

export function runAll(): number {
  log('Test scope: all')
  try {
    execSync('pnpm exec vitest run', { stdio })
    log('All tests passed')
    return 0
  } catch {
    log('Tests failed')
    return 1
  }
}

export function runPatterns(patterns: string[]): number {
  if (patterns.length === 0) {
    log('No tests to run; skipping.')
    return 0
  }
  log(`Test scope: ${mode} (${patterns.length} pattern(s))`)
  // --passWithNoTests: if a pattern produces zero matches (e.g. a freshly
  // added package with an empty test dir, or a source change that doesn't
  // touch any testable code), vitest treats it as success rather than a
  // "no test files found" error. Scoped-by-default runs shouldn't fail
  // just because the change didn't happen to touch a testable file.
  try {
    execFileSync(
      'pnpm',
      ['exec', 'vitest', 'run', '--passWithNoTests', ...patterns],
      { stdio },
    )
    log('All tests passed')
    return 0
  } catch {
    log('Tests failed')
    return 1
  }
}

export function shouldEscalate(files: string[]): boolean {
  for (let i = 0, { length } = files; i < length; i += 1) {
    const f = files[i]
    for (
      let j = 0, { length: patternsLength } = ESCALATION_PATTERNS;
      j < patternsLength;
      j += 1
    ) {
      const pattern = ESCALATION_PATTERNS[j]
      if (pattern.test(f)) {
        return true
      }
    }
  }
  return false
}

function main(): void {
  if (mode === 'all') {
    process.exitCode = runAll()
    return
  }

  const files = mode === 'staged' ? getStagedFiles() : getModifiedFiles()

  if (files.length === 0) {
    log(`No ${mode} files; skipping tests.`)
    return
  }

  if (shouldEscalate(files)) {
    log('Config files changed; escalating to full test suite.')
    process.exitCode = runAll()
    return
  }

  const patterns = resolveTestPatterns(files)
  process.exitCode = runPatterns(patterns)
}

main()
