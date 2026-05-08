/**
 * Sync external WASM loader (ESM).
 *
 * Reads `./json.wasm` from disk synchronously at module-load time
 * via fs.readFileSync + new WebAssembly.Module + new
 * WebAssembly.Instance. No async init, no top-level await.
 *
 * Pairs with json.wasm in the same directory. Mirrors the
 * acorn-wasm vendor's loader shape so esbuild bundling, vsce
 * packaging, and runtime resolution all work the same way.
 */

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const wasm = require('./json-bindgen.cjs')

// Span = half-open byte range [start, end) into the source string.
export interface Span {
  start: number
  end: number
}

export type Value =
  | { type: 'object'; members: Member[]; span: Span }
  | { type: 'array'; items: Value[]; span: Span }
  | { type: 'string'; value: string; span: Span }
  | { type: 'number'; value: number; raw: string; span: Span }
  | { type: 'bool'; value: boolean; span: Span }
  | { type: 'null'; span: Span }

export interface StringValue {
  value: string
  span: Span
}

export interface Member {
  key: StringValue
  value: Value
  span: Span
}

export interface ParsedJson {
  root: Value
}

export const parse: (source: string) => ParsedJson = wasm.parse
export const version: () => string = wasm.version
