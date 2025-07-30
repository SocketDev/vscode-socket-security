import * as vscode from 'vscode'
import * as parser from '@babel/parser'
import * as babelTypes from '@babel/types'
import * as babelTraverse from '@babel/traverse'
import childProcess from 'node:child_process'
import * as path from 'node:path'
import { text } from 'node:stream/consumers'
import jsonToAST from 'json-to-ast'
import * as toml from 'toml-eslint-parser'
import { getPythonInterpreter } from '../../data/python/interpreter'
import { getGlobPatterns } from '../../data/glob-patterns'
import { traverseTOMLKeys } from '../../util'
import { parseGoMod } from '../../data/go/mod-parser'
import { getGoExecutable } from '../../data/go/executable'
import pythonImportFinder from '../../data/python/import-finder.py'
import { generateNativeGoImportBinary } from '../../data/go/import-finder'
import logger from '../../infra/log'
import { isSupportedLSPLanguageId, PURL_Type, SUPPORTED_LSP_LANGUAGE_IDS_TO_PARSER } from '../languages'

export type ExternalRef = {
    name: string,
    range: vscode.Range
}

function simpurl(eco: PURL_Type, name: string): SimPURL {
    if (eco === 'pypi') {
        name = name.replaceAll('-','_')
    }
    return `pkg:${eco}/${name}`
}
export type SimPURL = `pkg:${PURL_Type}/${string}`
export class ExternalPurlRangeManager {
    externals = new Map<SimPURL, {builtin: boolean, ranges: vscode.Range[]}>();
    add(purl: SimPURL, range: vscode.Range, builtin: boolean = false): void {
        let group = this.externals.get(purl)
        if (!group) {
            group = {builtin, ranges: []}
            this.externals.set(purl, group)
        }
        group.ranges.push(range)
    }
}

function getJSPackageNameFromSpecifier(name: string): string {
    return (
        name.startsWith('@') ?
            name.split('/', 2) :
            name.split('/', 1)
    ).join('/')
}
function getJSPackageNameFromVersionRange(name: string): string {
    return (
        name.startsWith('@') ?
            name.split('@', 3) :
            name.split('@', 2)
    ).join('@')
}
function hydrateJSONRefs(src: string): ExternalRef[] {
    return JSON.parse(src, (key, value) => {
        if (key === 'range') {
            return new vscode.Range(
                new vscode.Position(value.start.line, value.start.character),
                new vscode.Position(value.end.line, value.end.character)
            )
        }
        return value
    })
}


export async function parseExternals(doc: vscode.TextDocument): Promise<Map<SimPURL, {builtin: boolean, ranges: vscode.Range[]}> | null> {
    const languageId = doc.languageId
    const src = doc.getText()
    const results = new ExternalPurlRangeManager()
    const basename = path.basename(doc.fileName)
    const globPatterns = await getGlobPatterns()
    const pep508RE = /(?<=^\s*)([A-Z0-9]|[A-Z0-9][A-Z0-9._-]*[A-Z0-9])(?=<|!|>|~|=|@|\(|\[|;|\s|$)/i
    if (path.matchesGlob(basename, globPatterns.npm.packagejson.pattern)) {
        const pkg = jsonToAST(src, {
            loc: true
        })
        if (pkg.type !== 'Object') {
            return null
        }

        for (const pkgField of pkg.children) {
            if (pkgField.key.value === 'dependencies' ||
                pkgField.key.value === 'devDependencies' ||
                pkgField.key.value === 'peerDependencies' ||
                pkgField.key.value === 'optionalDependencies'
            ) {
                if (pkgField.value.type === 'Object') {
                    for (const v of pkgField.value.children) {
                        const { loc } = v
                        if (loc) {
                            results.add(simpurl(
                                'npm',
                                v.key.value,
                            ),
                                rangeForJSONAstLoc(loc)
                            )
                        }
                    }
                }
            }
            if (pkgField.key.value === 'bundledDependencies') {
                if (pkgField.value.type === 'Array') {
                    for (const node of pkgField.value.children) {
                        if (node.type === 'Literal' && typeof node.value === 'string') {
                            const { loc } = node
                            if (loc) {
                                results.add(simpurl(
                                    'npm',
                                    node.value),
                                    rangeForJSONAstLoc(loc)
                                )
                            }
                        }
                    }
                }
            }
            if (pkgField.key.value === 'overrides') {
                if (pkgField.value.type === 'Object') {
                    parsePkgOverrideExternals(pkgField.value, results)
                }
            }

        }
    } else if (path.matchesGlob(basename, globPatterns.pypi.pyproject.pattern)) {
        let parsed: toml.AST.TOMLProgram
        try {
            parsed = toml.parseTOML(src)
        } catch (err) {
            return null
        }
        traverseTOMLKeys(parsed, (key, path) => {
            const dep = path.length === 2 &&
                path[0] === 'project' &&
                path[1] === 'dependencies'
            const optionalDep = path.length === 3 &&
                path[0] === 'project' &&
                path[2] === 'optional-dependencies' &&
                typeof path[3] === 'string'
            const inPoetry = path.length > 2 &&
                path[0] === 'tool' &&
                path[1] === 'poetry'
            const oldPoetryDep = inPoetry && path.length === 4 &&
                ['dependencies', 'dev-dependencies'].includes(path[2] as string)
            const groupPoetryDep = inPoetry && path.length === 6 &&
                path[2] === 'group' &&
                path[4] === 'dependencies'
            if ((oldPoetryDep || groupPoetryDep) && typeof path[path.length - 1] === 'string') {
                const loc = key.parent.type === 'TOMLTable' ? key.loc : key.parent.loc
                results.add(simpurl('pypi', path[path.length - 1] as string),
                    new vscode.Range(
                        new vscode.Position(loc.start.line - 1, loc.start.column),
                        new vscode.Position(loc.end.line - 1, loc.end.column)
                    )
                )
            } else if (
                (dep || optionalDep) &&
                key.parent.type === 'TOMLKeyValue' &&
                key.parent.value.type === 'TOMLArray'
            ) {
                for (const depNode of key.parent.value.elements) {
                    if (depNode.type !== 'TOMLValue' || depNode.kind !== 'string') continue
                    const match = pep508RE.exec(depNode.value)
                    if (!match) continue
                    results.add(simpurl(
                        'pypi',
                        match[1]
                    ),
                        new vscode.Range(
                            new vscode.Position(depNode.loc.start.line - 1, depNode.loc.start.column),
                            new vscode.Position(depNode.loc.end.line - 1, depNode.loc.end.column)
                        ))
                }
            }
        })
    } else if (path.matchesGlob(basename, globPatterns.pypi.pipfile.pattern)) {
        let parsed: toml.AST.TOMLProgram
        try {
            parsed = toml.parseTOML(src)
        } catch (err) {
            return null
        }
        traverseTOMLKeys(parsed, (key, path) => {
            if (
                path.length === 2 &&
                ['packages', 'dev-packages'].includes(path[0] as string) &&
                typeof path[1] === 'string'
            ) {
                const loc = key.parent.type === 'TOMLTable' ? key.loc : key.parent.loc
                results.add(simpurl('pypi',
                    path[1] as string
                ),
                    new vscode.Range(
                        new vscode.Position(loc.start.line - 1, loc.start.column),
                        new vscode.Position(loc.end.line - 1, loc.end.column)
                    )
                )
            }
        })
    } else if (path.matchesGlob(basename, globPatterns.pypi.requirements.pattern)) {
        const commentRE = /(\s|^)#.*/
        const lines = src.split('\n').map(line => line.replace(commentRE, ''))
        for (let i = 0; i < lines.length; ++i) {
            const line = lines[i]
            const match = pep508RE.exec(line)
            if (match) {
                results.add(simpurl('pypi',
                    match[1]),
                    new vscode.Range(
                        new vscode.Position(i, match.index),
                        new vscode.Position(i, match.index + line.length)
                    )
                )
            }
        }
    } else if (path.matchesGlob(basename, globPatterns.golang.gomod.pattern)) {
        const parsed = await parseGoMod(src)
        if (!parsed) return null

        const exclusions: Set<string> = new Set()
        for (const exclude of parsed.Exclude ?? []) {
            exclusions.add(exclude.Mod.Path)
        }

        for (const req of parsed.Require ?? []) {
            if (exclusions.has(req.Mod.Path)) continue
            results.add(simpurl('golang',
                req.Mod.Path),
                new vscode.Range(
                    new vscode.Position(req.Syntax.Start.Line - 1, req.Syntax.Start.LineRune - 1),
                    new vscode.Position(req.Syntax.End.Line - 1, req.Syntax.End.LineRune - 1),
                )
            )
        }

        for (const repl of parsed.Replace ?? []) {
            if (exclusions.has(repl.New.Path)) continue
            results.add(simpurl('golang',
                repl.New.Path),
                // TODO: can we get just the new part?
                new vscode.Range(
                    new vscode.Position(repl.Syntax.Start.Line - 1, repl.Syntax.Start.LineRune - 1),
                    new vscode.Position(repl.Syntax.End.Line - 1, repl.Syntax.End.LineRune - 1),
                )
            )
        }
    } else if (isSupportedLSPLanguageId(languageId)) {
        if (SUPPORTED_LSP_LANGUAGE_IDS_TO_PARSER[languageId] === 'npm') {
            let ast: babelTypes.File
            try {
                ast = parser.parse(
                    src,
                    {
                        allowAwaitOutsideFunction: true,
                        allowImportExportEverywhere: true,
                        allowReturnOutsideFunction: true,
                        errorRecovery: true,
                        plugins: [
                            'jsx',
                            'typescript',
                            'decorators'
                        ],
                    }
                )
            } catch (e) {
                return null
            }
            function addResult(node: babelTypes.Node, specifier: string) {
                if (/^[\.\/]/u.test(specifier)) {
                    return
                }
                const pkgName = getJSPackageNameFromSpecifier(specifier)
                const loc = node.loc
                if (!loc) return
                const startPos: vscode.Position = new vscode.Position(loc.start.line - 1, loc.start.column)
                const endPos: vscode.Position = new vscode.Position(loc.end.line - 1, loc.end.column)
                const range = new vscode.Range(startPos, endPos)
                results.add(simpurl('npm', pkgName), range)
            }
            const kDYNAMIC_VALUE: unique symbol = Symbol('dynamic_value')
            type DYNAMIC_VALUE = typeof kDYNAMIC_VALUE
            type PRIMITIVE = bigint | boolean | null | number | string | undefined
            /**
             * Lazy evaluator for finding out if something is constant at compile time
             * 
             * Used to deal w/ some things like require('@babel/${'traverse'}') generated code
             * 
             * Does not support compile time symbols (well known ones)
             * Does not support regexp symbols
             * Does not support array literals
             * Does not support object literals
             *
             * @returns a function to compute the value (may be non-trivial cost)
             */
            function constFor(node: babelTypes.Node): DYNAMIC_VALUE | (() => PRIMITIVE) {
                if (babelTypes.isTemplateLiteral(node)) {
                    if (node.quasis.length === 1) {
                        return () => node.quasis[0].value.cooked
                    } else {
                        let constExps: Array<Exclude<ReturnType<typeof constFor>, DYNAMIC_VALUE>> = []
                        for (const exp of node.expressions) {
                            let constExp = constFor(exp)
                            if (constExp === kDYNAMIC_VALUE) {
                                return kDYNAMIC_VALUE
                            }
                            constExps.push(constExp)
                        }
                        return () => {
                            let result = ''
                            let i
                            for (i = 0; i < node.quasis.length - 1; i++) {
                                result += `${node.quasis[i].value.cooked}${constExps[i]()}`
                            }
                            return `${result}${node.quasis[i].value.cooked}`
                        }
                    }
                } else if (babelTypes.isBigIntLiteral(node)) {
                    return () => BigInt(node.value)
                } else if (babelTypes.isLiteral(node)) {
                    let value = babelTypes.isRegExpLiteral(node) ? new RegExp(
                        node.pattern,
                        node.flags
                    ) : babelTypes.isNullLiteral(node) ? null : node.value
                    if (value && typeof value === 'object') {
                        // regexp literal
                        return kDYNAMIC_VALUE
                    }
                    return () => value
                } else if (babelTypes.isBinaryExpression(node)) {
                    const left = constFor(node.left)
                    if (left === kDYNAMIC_VALUE) {
                        return kDYNAMIC_VALUE
                    }
                    const right = constFor(node.right)
                    if (right === kDYNAMIC_VALUE) {
                        return kDYNAMIC_VALUE
                    }
                    let { operator } = node
                    if (operator === 'in' || operator === 'instanceof') {
                        return kDYNAMIC_VALUE
                    }
                    if (operator === '|>') {
                        return kDYNAMIC_VALUE
                    }
                    // lots of TS unhappy with odd but valid coercions
                    return {
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
                        '**': () => left() ** right()
                    }[operator]
                } else if (babelTypes.isUnaryExpression(node)) {
                    const arg = constFor(node.argument)
                    if (arg === kDYNAMIC_VALUE) {
                        return kDYNAMIC_VALUE
                    }
                    const { operator } = node
                    if (operator === 'delete') {
                        return kDYNAMIC_VALUE
                    }
                    if (operator === 'void') {
                        return () => undefined
                    }
                    if (operator === 'throw') {
                        return kDYNAMIC_VALUE
                    }
                    return {
                        // @ts-expect-error
                        '-': () => -arg(),
                        // @ts-expect-error
                        '+': () => +arg(),
                        '!': () => !arg(),
                        // @ts-expect-error
                        '~': () => ~arg(),
                        'typeof': () => typeof arg(),
                    }[operator]
                } else if (babelTypes.isParenthesizedExpression(node)) {
                    return constFor(node.expression)
                } else if (babelTypes.isAwaitExpression(node)) {
                    if (!node.argument) {
                        // WTF
                        return kDYNAMIC_VALUE
                    }
                    const arg = constFor(node.argument)
                    if (arg === kDYNAMIC_VALUE) {
                        return kDYNAMIC_VALUE
                    }
                    return arg
                }
                return kDYNAMIC_VALUE
            }
            babelTraverse.default(ast, {
                ImportDeclaration(path) {
                    addResult(path.node.source, `${path.node.source.value}`)
                    path.skip()
                },
                ImportExpression(path) {
                    const { node } = path
                    let constantArg = constFor(node.source)
                    if (constantArg !== kDYNAMIC_VALUE) {
                        addResult(node, `${constantArg()}`)
                    }
                },
                CallExpression(path) {
                    const { node } = path
                    const { callee } = node
                    if (node.arguments.length > 0) {
                        path.is
                        if (babelTypes.isIdentifier(callee, {
                            name: 'require'
                        })) {
                            const { arguments: [firstArg] } = node
                            let constantArg = constFor(firstArg)
                            if (constantArg !== kDYNAMIC_VALUE) {
                                addResult(node, `${constantArg()}`)
                            }
                        } else if (babelTypes.isImport(callee)) {
                            const { arguments: [firstArg] } = node
                            let constantArg = constFor(firstArg)
                            if (constantArg !== kDYNAMIC_VALUE) {
                                addResult(node, `${constantArg()}`)
                            }
                        }
                    }
                }
            })
        } else if (SUPPORTED_LSP_LANGUAGE_IDS_TO_PARSER[languageId] === 'pypi') {
            const pythonInterpreter = await getPythonInterpreter(doc)
            if (pythonInterpreter) {
                const proc = childProcess.spawn(pythonInterpreter.execPath, ['-c', pythonImportFinder])
                proc.stdin.end(src)
                const output = await text(proc.stdout)
                const stderr = await text(proc.stderr)
                if (!output) return null
                const refs = hydrateJSONRefs(output)
                for (const ref of refs) {
                    results.add(simpurl('pypi', ref.name), ref.range)
                }
            } else {
                // fallback for web/whenever Python interpreter not available
                const pyImportRE = /(?<=(?:^|\n)\s*)(?:import\s+(.+?)|from\s+(.+?)\s+import.+?)(?=\s*(?:$|\n))/g
                const pyDynamicImportRE = /(?:__import__|import_module)\((?:"""(.+?)"""|'''(.+?)'''|"(.+?)"|'(.+?)'|)\)/g
                let charInd = 0
                const lineChars = src.split('\n').map(line => charInd += line.length + 1)
                let match: RegExpExecArray | null = null
                for (let nl = 0; match = pyImportRE.exec(src);) {
                    while (lineChars[nl] <= match.index) ++nl
                    const names = match[1] ? match[1].split(',').map(v => v.trim()) : [match[2]]
                    const startLine = nl, startCol = match.index - (nl && lineChars[nl - 1])
                    while (lineChars[nl] <= match.index + match[0].length) ++nl
                    const endLine = nl, endCol = match.index - (nl && lineChars[nl - 1])
                    const range = new vscode.Range(startLine, startCol, endLine, endCol)
                    for (const name of names) {
                        results.add(simpurl('pypi', name.split('.')[0]), range)
                    }
                }
                for (let nl = 0; match = pyDynamicImportRE.exec(src);) {
                    while (lineChars[nl] <= match.index) ++nl
                    const name = match[1] || match[2] || match[3] || match[4]
                    const startLine = nl, startCol = match.index - (nl && lineChars[nl - 1])
                    while (lineChars[nl] <= match.index + match[0].length) ++nl
                    const endLine = nl, endCol = match.index - (nl && lineChars[nl - 1])
                    const range = new vscode.Range(startLine, startCol, endLine, endCol)
                    results.add(simpurl('pypi', name.split('.')[0]), range)
                }
            }
        } else if (SUPPORTED_LSP_LANGUAGE_IDS_TO_PARSER[languageId] === 'golang') {
            const goExecutable = await getGoExecutable()
            if (goExecutable) {
                const importFinderBin = await generateNativeGoImportBinary(goExecutable.execPath)
                const proc = childProcess.spawn(importFinderBin)
                proc.stdin.end(src)
                const output = await text(proc.stdout)
                if (!output) return null
                const refs = hydrateJSONRefs(output)
                for (const ref of refs) {
                    results.add(simpurl('golang', ref.name), ref.range)
                }
            } else {
                const goImportRE = /(?<=(?:^|\n)\s*?)(import\s*(?:\s[^\s\("`]+\s*)?)("|`)([^\s"`]+)("|`)(?=\s*?(?:$|\n))/g
                const goImportBlockStartRE = /(?<=(?:^|\n)\s*?)import\s*\(/g
                const goImportBlockRE = /(;|\n|\()(\s*(?:\s[^\s\("`]+\s*)?)("|`)([^\s"`]+)("|`)\s*?(?:;|\n|\))/y
                let charInd = 0
                const lineChars = src.split('\n').map(line => charInd += line.length + 1)
                let match: RegExpExecArray | null = null
                for (let nl = 0; match = goImportRE.exec(src);) {
                    while (lineChars[nl] <= match.index) ++nl
                    const name = match[3]
                    const line = nl
                    const startCol = match.index - (nl && lineChars[nl - 1]) + (match[1] || '').length
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
                for (let nl = 0; match = goImportBlockStartRE.exec(src);) {
                    goImportBlockRE.lastIndex = match.index + match[0].length - 1
                    for (let imMatch: RegExpExecArray | null = null; imMatch = goImportBlockRE.exec(src);) {
                        const name = imMatch[4]
                        const imInd = imMatch.index + (imMatch[1] || '').length + (imMatch[2] || '').length
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
                        goImportBlockRE.lastIndex = goImportBlockStartRE.lastIndex = imMatch.index + imMatch[0].length - 1
                    }
                    goImportBlockStartRE.lastIndex += 1
                }
            }
        }
    } else {
        return null
    }
    return results.externals
}
function rangeForJSONAstLoc(loc: Required<jsonToAST.ValueNode>['loc']): vscode.Range {
    return new vscode.Range(
        new vscode.Position(
            loc.start.line - 1,
            loc.start.column - 1
        ),
        new vscode.Position(
            loc.end.line - 1,
            loc.end.column - 1
        )
    )
}
function parsePkgOverrideExternals(node: jsonToAST.ObjectNode, results: ExternalPurlRangeManager, contextualName?: string): void {
    for (const child of node.children) {
        let pkgName: string | undefined
        if (child.key.value === '.') {
            if (contextualName) {
                pkgName = contextualName
            }
        } else {
            pkgName = getJSPackageNameFromVersionRange(child.key.value)
        }
        if (pkgName) {
            const { loc } = child.value.type === 'Literal' ? child : child.key
            if (loc) {
                results.add(simpurl(
                    'npm', pkgName),
                    rangeForJSONAstLoc(loc)
                )
            }
        }
        const { value } = child
        if (value.type === 'Object') {
            parsePkgOverrideExternals(value, results, pkgName ?? contextualName)
        } else if (value.type === 'Literal') {
            if (typeof value.value === 'string') {
                if (value.value.startsWith('$')) {
                    const { loc } = value
                    if (loc) {
                        results.add(simpurl('npm',
                            value.value.slice(1)),
                            rangeForJSONAstLoc(loc)
                        )
                    }
                }
            }
        }
    }
}
