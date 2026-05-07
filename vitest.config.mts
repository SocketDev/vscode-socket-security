/**
 * @fileoverview Vitest config root anchor — re-exports the canonical
 * config under `.config/`. The fleet pattern places configs under
 * `.config/`, but vitest's CLI auto-discovers from the cwd; passing
 * `--config .config/vitest.config.mts` requires editing the
 * fleet-canonical `scripts/test.mts` which is tracked byte-identical
 * across the fleet. A root re-export is the cheapest fleet-safe fix.
 */
export { default } from './.config/vitest.config.mts'
