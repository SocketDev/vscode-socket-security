/**
 * Sync external WASM loader (ESM) for the TOML parser.
 *
 * Reads `./toml.wasm` from disk synchronously at module-load time
 * via fs.readFileSync + new WebAssembly.Module + new
 * WebAssembly.Instance. No async init, no top-level await.
 *
 * Mirrors vendor/acorn-wasm and vendor/json-wasm so esbuild
 * bundling, vsce packaging, and runtime resolution all behave the
 * same way.
 */

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const wasm = require('./toml-bindgen.cjs')

// Span = half-open byte range [start, end) into the source string.
export interface Span {
  start: number
  end: number
}

export type Value =
  | { type: 'table'; members: Member[]; span: Span }
  | { type: 'array'; items: Value[]; span: Span }
  | { type: 'string'; value: string; span: Span }
  | { type: 'integer'; value: number; raw: string; span: Span }
  | { type: 'float'; value: number; raw: string; span: Span }
  | { type: 'bool'; value: boolean; span: Span }
  | { type: 'datetime'; raw: string; span: Span }

export interface StringValue {
  value: string
  span: Span
}

export interface Member {
  key: StringValue
  value: Value
  span: Span
}

export interface ParsedToml {
  root: Value
}

export const parse: (source: string) => ParsedToml = wasm.parse
export const version: () => string = wasm.version

// -- Helpers that callers in vscode-socket-security need --
// Two adapter functions that replace the two toml-eslint-parser
// surfaces previously used:
//   1. traverseTomlKeys: visitor that gives a `(path, span)` per key
//      — same shape as the old `traverseTOMLKeys`.
//   2. getStaticValue: convert a Value subtree to plain JS, the same
//      way `getStaticTOMLValue` did.

export interface TomlKeyVisit {
  /** Dotted path from root to this key. */
  path: ReadonlyArray<string | number>
  /** Span covering the key. */
  keySpan: Span
  /** Span covering the whole key+value entry — i.e. the Member's span. */
  entrySpan: Span
  /** The value bound to the key. */
  value: Value
}

/**
 * Walk every key-value pair in the document. For each leaf or table
 * key, invoke `cb` with the dotted path and the surrounding spans.
 * Equivalent to the old `traverseTOMLKeys` helper in util.ts.
 *
 * Why we visit table headers AND inline entries: callers want to
 * highlight both `[tool.poetry.dependencies]\nfoo = "1"` (header
 * keys) and `foo = "1"` inside it. The old toml-eslint-parser
 * traversal did the same thing; we match it.
 */
export function traverseTomlKeys(
  parsed: ParsedToml,
  cb: (visit: TomlKeyVisit) => void,
): void {
  if (parsed.root.type !== 'table') {
    return
  }
  walkMembers(parsed.root.members, [], cb)
}

function walkMembers(
  members: Member[],
  parentPath: ReadonlyArray<string | number>,
  cb: (visit: TomlKeyVisit) => void,
): void {
  for (const m of members) {
    const path = [...parentPath, m.key.value]
    cb({
      path,
      keySpan: m.key.span,
      entrySpan: m.span,
      value: m.value,
    })
    if (m.value.type === 'table') {
      walkMembers(m.value.members, path, cb)
    } else if (m.value.type === 'array') {
      // Array indices become path segments — matches what the old
      // traverseTOMLKeys produced for arrays of tables.
      for (let i = 0; i < m.value.items.length; i++) {
        const item = m.value.items[i]
        if (item && item.type === 'table') {
          walkMembers(item.members, [...path, i], cb)
        }
      }
    }
  }
}

/**
 * Convert a parsed TOML Value to a plain JS object — the same shape
 * `getStaticTOMLValue` returned from toml-eslint-parser. Loses
 * spans; useful when you just want to read a config value.
 */
export function getStaticValue(value: Value): unknown {
  switch (value.type) {
    case 'table': {
      const obj: Record<string, unknown> = {}
      for (const m of value.members) {
        obj[m.key.value] = getStaticValue(m.value)
      }
      return obj
    }
    case 'array':
      return value.items.map(getStaticValue)
    case 'string':
    case 'integer':
    case 'float':
    case 'bool':
      return value.value
    case 'datetime':
      // Surface the raw source slice (e.g. "1979-05-27T07:32:00Z"),
      // matching toml-eslint-parser's behavior of stringifying
      // datetimes.
      return value.raw
  }
}

/** Same shape as getStaticValue but takes the whole ParsedToml. */
export function getStaticParsed(parsed: ParsedToml): unknown {
  return getStaticValue(parsed.root)
}
