/**
 * @fileoverview Centralized path resolution for vscode-socket-security.
 *
 * Source of truth for every build/test/runtime path. Per the fleet
 * `1 path, 1 reference` rule — every other module imports from here
 * instead of constructing paths inline.
 *
 * Layout follows the socket-btm canonical pattern:
 *   build/<mode>/<platform-arch>/out/<artifact>
 *
 * For this repo specifically, the bundled output is platform-agnostic
 * (esbuild emits a single CommonJS file that runs in whatever Node
 * VSCode provides — the only platform-fork inputs are the embedded
 * WASM binaries which esbuild includes via --loader:.wasm=binary).
 * We still expose getBuildPaths(mode, platformArch) for fleet
 * compatibility; consumers that don't care about platform can call
 * it with a fixed sentinel like 'any'.
 *
 * VSCode marketplace publishing expects `main: ./out/main.js` per
 * package.json. The canonical build output therefore lands at
 * `./out/main.js` directly (no platform/mode subtree) — same place
 * as before this refactor — but `BUILD_ROOT` and `getBuildPaths`
 * are still defined so future build steps (e.g. per-platform sfw
 * shims, signed VSIX outputs) can branch the layout without
 * inventing path conventions ad-hoc.
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Package root: scripts/../
export const PACKAGE_ROOT = path.resolve(__dirname, '..')

// Build roots.
//
// OUT_DIR is the canonical bundle output that VSCode loads at runtime
// (package.json `main` resolves here). Always non-platform-specific
// because the bundled CommonJS is portable.
//
// BUILD_ROOT is a staging area for any per-mode / per-platform
// intermediates (test fixtures, signed VSIX archives, etc.) that get
// produced during dev or CI. Empty today; reserved for future use.
export const OUT_DIR = path.join(PACKAGE_ROOT, 'out')
export const BUILD_ROOT = path.join(PACKAGE_ROOT, 'build')

// Source roots.
export const SRC_DIR = path.join(PACKAGE_ROOT, 'src')
export const VENDOR_DIR = path.join(PACKAGE_ROOT, 'vendor')

// Top-level artifact paths.
export const MAIN_BUNDLE = path.join(OUT_DIR, 'main.js')
export const MAIN_BUNDLE_SOURCEMAP = path.join(OUT_DIR, 'main.js.map')

// Source entrypoints.
export const EXTENSION_ENTRY = path.join(SRC_DIR, 'extension.ts')

/**
 * Build paths for a specific (mode, platform-arch) tuple.
 *
 * @param buildMode  'dev' | 'prod' (determines minify, debug toggles)
 * @param platformArch  e.g. 'darwin-arm64', 'linux-x64', 'win32-x64'.
 *                       Use 'any' when the artifact is platform-agnostic.
 *
 * Returns an object whose keys mirror the socket-btm canonical:
 *   buildDir         build/<mode>/<platformArch>
 *   outputFinalDir   build/<mode>/<platformArch>/out/Final
 *   outputFinalFile  the bundled JS output
 *
 * For vscode-socket-security the `out/Final/main.js` mirror is
 * documentation only — the real shipped path is OUT_DIR/main.js (so
 * vsce packaging finds it). Per-mode build trees are reserved for
 * future use.
 */
export function getBuildPaths(
  buildMode: 'dev' | 'prod',
  platformArch: string,
): {
  buildDir: string
  outputFinalDir: string
  outputFinalFile: string
} {
  if (!buildMode) {
    throw new Error('buildMode is required for getBuildPaths()')
  }
  if (!platformArch) {
    throw new Error('platformArch is required for getBuildPaths()')
  }
  const buildDir = path.join(BUILD_ROOT, buildMode, platformArch)
  const outputFinalDir = path.join(buildDir, 'out', 'Final')
  return {
    buildDir,
    outputFinalDir,
    outputFinalFile: path.join(outputFinalDir, 'main.js'),
  }
}
