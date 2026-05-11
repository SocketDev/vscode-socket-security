import * as vscode from 'vscode'
import { parse as acornParse, simple as acornSimple } from 'acorn-wasm'
import childProcess from 'node:child_process'
import * as path from 'node:path'
import { text } from 'node:stream/consumers'
import {
  parse as parseJson,
  type Span as JsonSpan,
  type Value as JsonValue,
} from 'json-wasm'
import {
  parse as parseToml,
  traverseTomlKeys,
  type ParsedToml,
} from 'toml-wasm'
import { getPythonInterpreter } from '../../data/python/interpreter'
import { getGlobPatterns } from '../../data/glob-patterns'
import { parseGoMod } from '../../data/go/mod-parser'
import { getGoExecutable } from '../../data/go/executable'
import pythonImportFinder from '../../data/python/import-finder.py'
import { generateNativeGoImportBinary } from '../../data/go/import-finder'
import logger from '../../infra/log'
import {
  isSupportedLSPLanguageId,
  PURL_Type,
  SUPPORTED_LSP_LANGUAGE_IDS_TO_PARSER,
} from '../languages'

export type ExternalRef = {
  name: string
  range: vscode.Range
}

export type SimPURL = `pkg:${PURL_Type}/${string}`
export class ExternalPurlRangeManager {
  externals = new Map<SimPURL, { builtin: boolean; ranges: vscode.Range[] }>()
  add(purl: SimPURL, range: vscode.Range, builtin: boolean = false): void {
    let group = this.externals.get(purl)
    if (!group) {
      group = { builtin, ranges: [] }
      this.externals.set(purl, group)
    }
    group.ranges.push(range)
  }
}

// json-wasm emits byte-range spans rather than (line, column). Build
// a sorted line-start table once per document so converting any span
// to a vscode.Range is O(log n) per lookup, at O(n) construction
// cost — much cheaper than re-walking the source per node.
export function buildLineTable(src: string): number[] {
  const lines: number[] = [0]
  for (let i = 0, n = src.length; i < n; i++) {
    if (src.charCodeAt(i) === 10 /* \n */) {
      lines.push(i + 1)
    }
  }
  return lines
}

export function getJSPackageNameFromSpecifier(name: string): string {
  return (name.startsWith('@') ? name.split('/', 2) : name.split('/', 1)).join(
    '/',
  )
}
export function getJSPackageNameFromVersionRange(name: string): string {
  return (name.startsWith('@') ? name.split('@', 3) : name.split('@', 2)).join(
    '@',
  )
}
export function hydrateJSONRefs(src: string): ExternalRef[] {
  return JSON.parse(src, (key, value) => {
    if (key === 'range') {
      return new vscode.Range(
        new vscode.Position(value.start.line, value.start.character),
        new vscode.Position(value.end.line, value.end.character),
      )
    }
    return value
  })
}

export function offsetToPosition(
  offset: number,
  lineTable: number[],
): vscode.Position {
  // Binary search for the largest line-start <= offset.
  let lo = 0
  let hi = lineTable.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1
    if (lineTable[mid] <= offset) {
      lo = mid
    } else {
      hi = mid - 1
    }
  }
  return new vscode.Position(lo, offset - lineTable[lo])
}

export async function parseExternals(
  doc: vscode.TextDocument,
): Promise<
  Map<SimPURL, { builtin: boolean; ranges: vscode.Range[] }> | undefined
> {
  const languageId = doc.languageId
  const src = doc.getText()
  const results = new ExternalPurlRangeManager()
  const basename = path.basename(doc.fileName)
  const globPatterns = await getGlobPatterns()
  const pep508RE =
    /(?<=^\s*)([A-Z0-9]|[A-Z0-9][A-Z0-9._-]*[A-Z0-9])(?=<|!|>|~|=|@|\(|\[|;|\s|$)/i
  if (path.matchesGlob(basename, globPatterns.npm.packagejson.pattern)) {
    let pkg: JsonValue
    try {
      pkg = parseJson(src).root
    } catch {
      return undefined
    }
    if (pkg.type !== 'object') {
      return undefined
    }
    const lineTable = buildLineTable(src)

    for (const pkgField of pkg.members) {
      if (
        pkgField.key.value === 'dependencies' ||
        pkgField.key.value === 'devDependencies' ||
        pkgField.key.value === 'peerDependencies' ||
        pkgField.key.value === 'optionalDependencies'
      ) {
        if (pkgField.value.type === 'object') {
          for (const v of pkgField.value.members) {
            results.add(
              simpurl('npm', v.key.value),
              spanToRange(v.span, lineTable),
            )
          }
        }
      }
      if (pkgField.key.value === 'bundledDependencies') {
        if (pkgField.value.type === 'array') {
          for (const node of pkgField.value.items) {
            if (node.type === 'string') {
              results.add(
                simpurl('npm', node.value),
                spanToRange(node.span, lineTable),
              )
            }
          }
        }
      }
      if (pkgField.key.value === 'overrides') {
        if (pkgField.value.type === 'object') {
          parsePkgOverrideExternals(pkgField.value, lineTable, results)
        }
      }
    }
  } else if (path.matchesGlob(basename, globPatterns.pypi.pyproject.pattern)) {
    let parsed: ParsedToml
    try {
      parsed = parseToml(src)
    } catch {
      return undefined
    }
    const lineTable = buildLineTable(src)
    traverseTomlKeys(parsed, ({ path, entrySpan, value }) => {
      const isDepsArray =
        path.length === 2 && path[0] === 'project' && path[1] === 'dependencies'
      const isOptionalDepsArray =
        path.length === 3 &&
        path[0] === 'project' &&
        path[1] === 'optional-dependencies' &&
        typeof path[2] === 'string'
      const inPoetry =
        path.length > 2 && path[0] === 'tool' && path[1] === 'poetry'
      const isOldPoetryDep =
        inPoetry &&
        path.length === 4 &&
        ['dependencies', 'dev-dependencies'].includes(path[2] as string)
      const isGroupPoetryDep =
        inPoetry &&
        path.length === 6 &&
        path[2] === 'group' &&
        path[4] === 'dependencies'
      if (
        (isOldPoetryDep || isGroupPoetryDep) &&
        typeof path[path.length - 1] === 'string'
      ) {
        results.add(
          simpurl('pypi', path[path.length - 1] as string),
          spanToRange(entrySpan, lineTable),
        )
      } else if (
        (isDepsArray || isOptionalDepsArray) &&
        value.type === 'array'
      ) {
        for (const depNode of value.items) {
          if (depNode.type !== 'string') {
            continue
          }
          const match = pep508RE.exec(depNode.value)
          if (!match) {
            continue
          }
          results.add(
            simpurl('pypi', match[1]),
            spanToRange(depNode.span, lineTable),
          )
        }
      }
    })
  } else if (path.matchesGlob(basename, globPatterns.pypi.pipfile.pattern)) {
    let parsed: ParsedToml
    try {
      parsed = parseToml(src)
    } catch {
      return undefined
    }
    const lineTable = buildLineTable(src)
    traverseTomlKeys(parsed, ({ path, entrySpan }) => {
      if (
        path.length === 2 &&
        ['packages', 'dev-packages'].includes(path[0] as string) &&
        typeof path[1] === 'string'
      ) {
        results.add(
          simpurl('pypi', path[1] as string),
          spanToRange(entrySpan, lineTable),
        )
      }
    })
  } else if (
    path.matchesGlob(basename, globPatterns.pypi.requirements.pattern)
  ) {
    const commentRE = /(\s|^)#.*/
    const lines = src.split('\n').map(line => line.replace(commentRE, ''))
    for (let i = 0; i < lines.length; ++i) {
      const line = lines[i]
      const match = pep508RE.exec(line)
      if (match) {
        results.add(
          simpurl('pypi', match[1]),
          new vscode.Range(
            new vscode.Position(i, match.index),
            new vscode.Position(i, match.index + line.length),
          ),
        )
      }
    }
  } else if (path.matchesGlob(basename, globPatterns.golang.gomod.pattern)) {
    const parsed = await parseGoMod(src)
    if (!parsed) return undefined

    const exclusions: Set<string> = new Set()
    for (const exclude of parsed.Exclude ?? []) {
      exclusions.add(exclude.Mod.Path)
    }

    for (const req of parsed.Require ?? []) {
      if (exclusions.has(req.Mod.Path)) continue
      results.add(
        simpurl('golang', req.Mod.Path),
        new vscode.Range(
          new vscode.Position(
            req.Syntax.Start.Line - 1,
            req.Syntax.Start.LineRune - 1,
          ),
          new vscode.Position(
            req.Syntax.End.Line - 1,
            req.Syntax.End.LineRune - 1,
          ),
        ),
      )
    }

    for (const repl of parsed.Replace ?? []) {
      if (exclusions.has(repl.New.Path)) continue
      results.add(
        simpurl('golang', repl.New.Path),
        new vscode.Range(
          new vscode.Position(
            repl.Syntax.Start.Line - 1,
            repl.Syntax.Start.LineRune - 1,
          ),
          new vscode.Position(
            repl.Syntax.End.Line - 1,
            repl.Syntax.End.LineRune - 1,
          ),
        ),
      )
    }
  } else if (isSupportedLSPLanguageId(languageId)) {
    if (SUPPORTED_LSP_LANGUAGE_IDS_TO_PARSER[languageId] === 'npm') {
      // ESTree-shape AST node from acorn-wasm. Untyped because the
      // wasm bindings hand back plain JS objects; we discriminate via
      // node.type literals, the same way ESTree consumers do.
      type AcornNode = {
        type: string
        start: number
        end: number
        // type-specific extras tagged at use sites:
        [k: string]: unknown
      }
      // acorn-wasm doesn't surface line/column locations on AST nodes;
      // we get byte offsets only. Build a one-time newline index over
      // the source so offset→{line, column} is O(log n) per lookup.
      const newlineOffsets: number[] = [0]
      for (let i = 0; i < src.length; i += 1) {
        if (src.charCodeAt(i) === 10 /* \n */) {
          newlineOffsets.push(i + 1)
        }
      }
      function offsetToPosition(offset: number): vscode.Position {
        // Binary search for the largest newline-start ≤ offset.
        let lo = 0
        let hi = newlineOffsets.length - 1
        while (lo < hi) {
          const mid = (lo + hi + 1) >>> 1
          if (newlineOffsets[mid]! <= offset) lo = mid
          else hi = mid - 1
        }
        return new vscode.Position(lo, offset - newlineOffsets[lo]!)
      }
      function addResult(node: AcornNode, specifier: string) {
        if (/^[./]/u.test(specifier)) {
          return
        }
        const pkgName = getJSPackageNameFromSpecifier(specifier)
        const range = new vscode.Range(
          offsetToPosition(node.start),
          offsetToPosition(node.end),
        )
        results.add(simpurl('npm', pkgName), range)
      }
      // Sanity-parse upfront so a syntax error produces a null result
      // (matches the previous behavior of bailing on parser.parse throw).
      // acorn-wasm's `simple` parses internally too, but doesn't bubble
      // a typed error in a way the visitor pattern can handle cleanly.
      try {
        acornParse(src, { sourceType: 'module', ecmaVersion: 'latest' })
      } catch {
        return undefined
      }
      const kDYNAMIC_VALUE: unique symbol = Symbol('dynamic_value')
      type DYNAMIC_VALUE = typeof kDYNAMIC_VALUE
      type PRIMITIVE = bigint | boolean | null | number | string | undefined
      /**
       * Lazy evaluator for finding out if something is constant at
       * compile time. Used to recover string specifiers from things
       * like `require(`@babel/${'traverse'}`)` (constant template +
       * BinaryExpression concat etc.).
       *
       * Does not support compile-time symbols, regexp results, array
       * literals, or object literals — anything that returns a fresh
       * object is treated as DYNAMIC.
       *
       * @returns a function to compute the value (may be non-trivial cost)
       */
      function constFor(node: AcornNode): DYNAMIC_VALUE | (() => PRIMITIVE) {
        if (node.type === 'TemplateLiteral') {
          const quasis = node['quasis'] as Array<{
            value: { cooked?: string; raw: string }
          }>
          const expressions = node['expressions'] as AcornNode[]
          if (quasis.length === 1) {
            return () => quasis[0]!.value.cooked ?? quasis[0]!.value.raw
          }
          const constExps: Array<
            Exclude<ReturnType<typeof constFor>, DYNAMIC_VALUE>
          > = []
          for (const exp of expressions) {
            const constExp = constFor(exp)
            if (constExp === kDYNAMIC_VALUE) {
              return kDYNAMIC_VALUE
            }
            constExps.push(constExp)
          }
          return () => {
            let result = ''
            let i
            for (i = 0; i < quasis.length - 1; i += 1) {
              const cooked = quasis[i]!.value.cooked ?? quasis[i]!.value.raw
              result += `${cooked}${constExps[i]!()}`
            }
            const lastCooked = quasis[i]!.value.cooked ?? quasis[i]!.value.raw
            return `${result}${lastCooked}`
          }
        } else if (node.type === 'Literal') {
          // ESTree's `Literal` covers string, number, boolean, null,
          // bigint, regexp. acorn-wasm exposes:
          //   - regexp:   node.regex = { pattern, flags }, value = null/RegExp
          //   - bigint:   node.bigint = "<digits>", value = bigint
          //   - null:     value = null, raw = "null"
          //   - the rest: value = the literal value
          if ('regex' in node) {
            // RegExp literal — produces an object, treated as dynamic.
            return kDYNAMIC_VALUE
          }
          if ('bigint' in node) {
            const bigintStr = node['bigint'] as string
            return () => BigInt(bigintStr)
          }
          const value = node['value'] as PRIMITIVE
          return () => value
        } else if (node.type === 'BinaryExpression') {
          const left = constFor(node['left'] as AcornNode)
          if (left === kDYNAMIC_VALUE) {
            return kDYNAMIC_VALUE
          }
          const right = constFor(node['right'] as AcornNode)
          if (right === kDYNAMIC_VALUE) {
            return kDYNAMIC_VALUE
          }
          const operator = node['operator'] as string
          if (operator === 'in' || operator === 'instanceof') {
            return kDYNAMIC_VALUE
          }
          if (operator === '|>') {
            return kDYNAMIC_VALUE
          }
          // lots of TS unhappy with odd but valid coercions
          return (
            {
              '==': () => left() == right(),
              '!=': () => left() != right(),
              '===': () => left() === right(),
              '!==': () => left() !== right(),
              // @ts-expect-error
              '<': () => left() < right(),
              // @ts-expect-error
              '<=': () => left() <= right(),
              // @ts-expect-error
              '>': () => left() > right(),
              // @ts-expect-error
              '>=': () => left() >= right(),
              // @ts-expect-error
              '<<': () => left() << right(),
              // @ts-expect-error
              '>>': () => left() >> right(),
              // @ts-expect-error
              '>>>': () => left() >>> right(),
              // @ts-expect-error
              '+': () => left() + right(),
              // @ts-expect-error
              '-': () => left() - right(),
              // @ts-expect-error
              '*': () => left() * right(),
              // @ts-expect-error
              '/': () => left() / right(),
              // @ts-expect-error
              '%': () => left() % right(),
              // @ts-expect-error
              '&': () => left() & right(),
              // @ts-expect-error
              '|': () => left() | right(),
              // @ts-expect-error
              '^': () => left() ^ right(),
              // @ts-expect-error
              '**': () => left() ** right(),
            }[operator] ?? kDYNAMIC_VALUE
          )
        } else if (node.type === 'UnaryExpression') {
          const arg = constFor(node['argument'] as AcornNode)
          if (arg === kDYNAMIC_VALUE) {
            return kDYNAMIC_VALUE
          }
          const operator = node['operator'] as string
          if (operator === 'delete') {
            return kDYNAMIC_VALUE
          }
          if (operator === 'void') {
            return () => undefined
          }
          if (operator === 'throw') {
            return kDYNAMIC_VALUE
          }
          return (
            {
              // @ts-expect-error
              '-': () => -arg(),
              // @ts-expect-error
              '+': () => +arg(),
              '!': () => !arg(),
              // @ts-expect-error
              '~': () => ~arg(),
              typeof: () => typeof arg(),
            }[operator] ?? kDYNAMIC_VALUE
          )
        } else if (node.type === 'ParenthesizedExpression') {
          // ESTree doesn't always emit ParenthesizedExpression — most
          // parsers strip parens. Acorn does the same by default;
          // present here defensively in case of a future preserve-paren
          // option.
          return constFor(node['expression'] as AcornNode)
        } else if (node.type === 'AwaitExpression') {
          const argument = node['argument'] as AcornNode | undefined
          if (!argument) {
            return kDYNAMIC_VALUE
          }
          const arg = constFor(argument)
          if (arg === kDYNAMIC_VALUE) {
            return kDYNAMIC_VALUE
          }
          return arg
        }
        return kDYNAMIC_VALUE
      }
      // acorn-walk's `simple` walker passes the AST node directly (no
      // path wrapper). It doesn't expose path.skip() — but we don't
      // need it: ImportDeclaration's `source` is a Literal that the
      // walker would visit anyway, and we end up adding the same
      // result twice if we don't dedup. Deduping happens upstream in
      // ExternalPurlRangeManager.add() via the Range list (no Set
      // semantics, so duplicates DO leak — preserves prior behavior
      // because babel had `path.skip()` only on ImportDeclaration).
      acornSimple(
        src,
        {
          ImportDeclaration(node: AcornNode) {
            const source = node['source'] as AcornNode & { value: string }
            addResult(source, `${source.value}`)
          },
          ImportExpression(node: AcornNode) {
            const constantArg = constFor(node['source'] as AcornNode)
            if (constantArg !== kDYNAMIC_VALUE) {
              addResult(node, `${constantArg()}`)
            }
          },
          CallExpression(node: AcornNode) {
            const callee = node['callee'] as AcornNode & { name?: string }
            const args = node['arguments'] as AcornNode[]
            if (args.length === 0) return
            const isRequire =
              callee.type === 'Identifier' && callee.name === 'require'
            // In ESTree, dynamic `import(x)` is normally an
            // ImportExpression node (handled above), but acorn-wasm
            // emits some shapes as CallExpression with callee.type ===
            // 'Import'. Defensive: handle both surface shapes.
            const isDynamicImport = callee.type === 'Import'
            if (isRequire || isDynamicImport) {
              const firstArg = args[0]!
              const constantArg = constFor(firstArg)
              if (constantArg !== kDYNAMIC_VALUE) {
                addResult(node, `${constantArg()}`)
              }
            }
          },
        },
        { sourceType: 'module', ecmaVersion: 'latest' },
      )
    } else if (SUPPORTED_LSP_LANGUAGE_IDS_TO_PARSER[languageId] === 'pypi') {
      const pythonInterpreter = await getPythonInterpreter(doc)
      if (pythonInterpreter) {
        const proc = childProcess.spawn(pythonInterpreter.execPath, [
          '-c',
          pythonImportFinder,
        ])
        proc.stdin.end(src)
        const output = await text(proc.stdout)
        const stderr = await text(proc.stderr)
        if (!output) return undefined
        const refs = hydrateJSONRefs(output)
        for (const ref of refs) {
          results.add(simpurl('pypi', ref.name), ref.range)
        }
      } else {
        // fallback for web/whenever Python interpreter not available
        const pyImportRE =
          /(?<=(?:^|\n)\s*)(?:import\s+(.+?)|from\s+(.+?)\s+import.+?)(?=\s*(?:$|\n))/g
        const pyDynamicImportRE =
          /(?:__import__|import_module)\((?:"""(.+?)"""|'''(.+?)'''|"(.+?)"|'(.+?)'|)\)/g
        let charInd = 0
        const lineChars = src
          .split('\n')
          .map(line => (charInd += line.length + 1))
        let match: RegExpExecArray | null = null
        for (let nl = 0; (match = pyImportRE.exec(src)); ) {
          while (lineChars[nl] <= match.index) ++nl
          const names = match[1]
            ? match[1].split(',').map(v => v.trim())
            : [match[2]]
          const startLine = nl,
            startCol = match.index - (nl && lineChars[nl - 1])
          while (lineChars[nl] <= match.index + match[0].length) ++nl
          const endLine = nl,
            endCol = match.index - (nl && lineChars[nl - 1])
          const range = new vscode.Range(startLine, startCol, endLine, endCol)
          for (const name of names) {
            results.add(simpurl('pypi', name.split('.')[0]), range)
          }
        }
        for (let nl = 0; (match = pyDynamicImportRE.exec(src)); ) {
          while (lineChars[nl] <= match.index) ++nl
          const name = match[1] || match[2] || match[3] || match[4]
          const startLine = nl,
            startCol = match.index - (nl && lineChars[nl - 1])
          while (lineChars[nl] <= match.index + match[0].length) ++nl
          const endLine = nl,
            endCol = match.index - (nl && lineChars[nl - 1])
          const range = new vscode.Range(startLine, startCol, endLine, endCol)
          results.add(simpurl('pypi', name.split('.')[0]), range)
        }
      }
    } else if (SUPPORTED_LSP_LANGUAGE_IDS_TO_PARSER[languageId] === 'golang') {
      const goExecutable = await getGoExecutable()
      if (goExecutable) {
        const importFinderBin = await generateNativeGoImportBinary(
          goExecutable.execPath,
        )
        const proc = childProcess.spawn(importFinderBin)
        proc.stdin.end(src)
        const output = await text(proc.stdout)
        if (!output) return undefined
        const refs = hydrateJSONRefs(output)
        for (const ref of refs) {
          results.add(simpurl('golang', ref.name), ref.range)
        }
      } else {
        const goImportRE =
          /(?<=(?:^|\n)\s*?)(import\s*(?:\s[^\s("`]+\s*)?)("|`)([^\s"`]+)("|`)(?=\s*?(?:$|\n))/g
        const goImportBlockStartRE = /(?<=(?:^|\n)\s*?)import\s*\(/g
        const goImportBlockRE =
          /(;|\n|\()(\s*(?:\s[^\s("`]+\s*)?)("|`)([^\s"`]+)("|`)\s*?(?:;|\n|\))/y
        let charInd = 0
        const lineChars = src
          .split('\n')
          .map(line => (charInd += line.length + 1))
        let match: RegExpExecArray | null = null
        for (let nl = 0; (match = goImportRE.exec(src)); ) {
          while (lineChars[nl] <= match.index) ++nl
          const name = match[3]
          const line = nl
          const startCol =
            match.index - (nl && lineChars[nl - 1]) + (match[1] || '').length
          const endCol = startCol + name.length + 2

          const range = new vscode.Range(line, startCol, line, endCol)
          let realName = name
          if (match[2] === '"' && match[4] === '"') {
            try {
              realName = JSON.parse(`"${realName}"`)
            } catch (err) {
              // just use original
            }
          }
          results.add(simpurl('golang', realName), range)
        }
        for (let nl = 0; (match = goImportBlockStartRE.exec(src)); ) {
          goImportBlockRE.lastIndex = match.index + match[0].length - 1
          for (
            let imMatch: RegExpExecArray | null = null;
            (imMatch = goImportBlockRE.exec(src));
          ) {
            const name = imMatch[4]
            const imInd =
              imMatch.index +
              (imMatch[1] || '').length +
              (imMatch[2] || '').length
            while (lineChars[nl] <= imInd) ++nl
            const startCol = imInd - (nl && lineChars[nl - 1])
            const line = nl
            const endCol = startCol + name.length + 2
            const range = new vscode.Range(line, startCol, line, endCol)
            let realName = name

            if (imMatch[3] === '"' && imMatch[5] === '"') {
              try {
                realName = JSON.parse(`"${realName}"`)
              } catch (err) {
                // just use original
              }
            }

            results.add(simpurl('golang', realName), range)
            goImportBlockRE.lastIndex = goImportBlockStartRE.lastIndex =
              imMatch.index + imMatch[0].length - 1
          }
          goImportBlockStartRE.lastIndex += 1
        }
      }
    }
  } else {
    return undefined
  }
  return results.externals
}
export function parsePkgOverrideExternals(
  node: Extract<JsonValue, { type: 'object' }>,
  lineTable: number[],
  results: ExternalPurlRangeManager,
  contextualName?: string,
): void {
  for (const child of node.members) {
    let pkgName: string | undefined
    if (child.key.value === '.') {
      if (contextualName) {
        pkgName = contextualName
      }
    } else {
      pkgName = getJSPackageNameFromVersionRange(child.key.value)
    }
    if (pkgName) {
      // Highlight the whole `key: value` pair when the value is a
      // scalar; just the key when it's a nested object (the inner
      // object's children get their own ranges via recursion).
      const span: JsonSpan =
        child.value.type === 'string' ? child.span : child.key.span
      results.add(simpurl('npm', pkgName), spanToRange(span, lineTable))
    }
    const { value } = child
    if (value.type === 'object') {
      parsePkgOverrideExternals(
        value,
        lineTable,
        results,
        pkgName ?? contextualName,
      )
    } else if (value.type === 'string') {
      if (value.value.startsWith('$')) {
        results.add(
          simpurl('npm', value.value.slice(1)),
          spanToRange(value.span, lineTable),
        )
      }
    }
  }
}

export function simpurl(eco: PURL_Type, name: string): SimPURL {
  if (eco === 'pypi') {
    name = name.replaceAll('-', '_')
  }
  return `pkg:${eco}/${name}`
}

export function spanToRange(span: JsonSpan, lineTable: number[]): vscode.Range {
  return new vscode.Range(
    offsetToPosition(span.start, lineTable),
    offsetToPosition(span.end, lineTable),
  )
}
