import * as vscode from 'vscode';
import * as parser from '@babel/parser'
import * as astTypes from "ast-types";
import path from 'node:path';
import jsonToAST from 'json-to-ast';

type ExternalRef = {
    name: string,
    range: vscode.Range,
    prioritize?: boolean
}

export const SUPPORTED_LANGUAGES: Record<string, string> = {
    javascript: 'npm',
    javascriptreact: 'npm',
    typescript: 'npm',
    typescriptreact: 'npm',
    python: 'pypi'
}

function getPackageNameFromSpecifier(name: string): string {
    return (
        name.startsWith('@') ?
        name.split('/', 2) :
        name.split('/', 1)
    ).join('/');
}
function getPackageNameFromVersionRange(name: string): string {
    return (
        name.startsWith('@') ?
        name.split('@', 3) :
        name.split('@', 2)
    ).join('@');
}
export function parseExternals(doc: Pick<vscode.TextDocument, 'getText' | 'languageId' | 'fileName'>): Iterable<ExternalRef> | null {
    const src = doc.getText();
    const results: Array<ExternalRef> = []
    if (SUPPORTED_LANGUAGES[doc.languageId] === 'npm') {
        let ast
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
        } catch {
            return null
        }
        function addResult(node: astTypes.namedTypes.Node, specifier: string) {
            if (/^[\.\/]/u.test(specifier)) {
                return
            }
            const pkgName = getPackageNameFromSpecifier(specifier)
            const loc = node.loc
            if (!loc) return
            const startPos: vscode.Position = new vscode.Position(loc.start.line - 1, loc.start.column)
            const endPos: vscode.Position = new vscode.Position(loc.end.line - 1, loc.end.column)
            const range = new vscode.Range(startPos, endPos)
            results.push({
                range,
                name: pkgName
            })
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
        function constFor(node: astTypes.ASTNode): DYNAMIC_VALUE | (() => PRIMITIVE) {
            if (astTypes.namedTypes.TemplateLiteral.check(node)) {
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
            } else if (astTypes.namedTypes.BigIntLiteral.check(node)) {
                return () => BigInt(node.value)
            } else if (astTypes.namedTypes.Literal.check(node)) {
                const { value } = node
                if (value && typeof value === 'object') {
                    // regexp literal
                    return kDYNAMIC_VALUE
                }
                return () => value
            } else if (astTypes.namedTypes.BinaryExpression.check(node)) {
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
            } else if (astTypes.namedTypes.UnaryExpression.check(node)) {
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
            } else if (astTypes.namedTypes.ParenthesizedExpression.check(node)) {
                return constFor(node.expression)
            } else if (astTypes.namedTypes.AwaitExpression.check(node)) {
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
        astTypes.visit(ast, {
            visitImportDeclaration(path) {
                addResult(path.node.source, `${path.node.source.value}`)
                return false
            },
            visitImportExpression(path) {
                const { node } = path
                let constantArg = constFor(node.source)
                if (constantArg !== kDYNAMIC_VALUE) {
                    addResult(node, `${constantArg()}`)
                }
                this.traverse(path)
            },
            visitCallExpression(path) {
                const { node } = path
                const { callee } = node
                if (node.arguments.length > 0) {
                    if (astTypes.namedTypes.Identifier.check(callee) && callee.name === 'require') {
                        const { arguments: [firstArg] } = node
                        let constantArg = constFor(firstArg)
                        if (constantArg !== kDYNAMIC_VALUE) {
                            addResult(node, `${constantArg()}`)
                        }
                    } else if (astTypes.namedTypes.Import.check(callee)) {
                        const { arguments: [firstArg] } = node
                        let constantArg = constFor(firstArg)
                        if (constantArg !== kDYNAMIC_VALUE) {
                            addResult(node, `${constantArg()}`)
                        }
                    }
                }
                this.traverse(path)
            }
        })
    } else if (SUPPORTED_LANGUAGES[doc.languageId] === 'pypi') {
        
    } else if (path.basename(doc.fileName) === 'package.json') {
        const pkg = jsonToAST(src, {
            loc: true
        })
        if (pkg.type !== 'Object') {
            return [];
        }
        for (const pkgField of pkg.children) {
            if (pkgField.key.value === 'dependencies' ||
                pkgField.key.value === 'devDependencies' ||
                pkgField.key.value === 'peerDependencies' ||
                pkgField.key.value === 'optionalDependencies'
            ) {
                if (pkgField.value.type === 'Object') {
                    for (const v of pkgField.value.children) {
                        const { loc } = v;
                        if (loc) {
                            results.push({
                                name: v.key.value,
                                range: rangeForJSONAstLoc(loc),
                                prioritize: true
                            })
                        }
                    }
                }
            }
            if (pkgField.key.value === 'bundledDependencies') {
                if (pkgField.value.type === 'Array') {
                    for (const node of pkgField.value.children) {
                        if (node.type === 'Literal' && typeof node.value === 'string') {
                            const {loc} = node
                            if (loc) {
                                results.push({
                                    name: node.value,
                                    range: rangeForJSONAstLoc(loc)
                                })
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
    }
    return results
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
function parsePkgOverrideExternals(node: jsonToAST.ObjectNode, results: Array<ExternalRef>, contextualName?: string): void {
    for (const child of node.children) {
        let pkgName: string | undefined
        if (child.key.value === '.') {
            if (contextualName) {
                pkgName = contextualName
            }
        } else {
            pkgName = getPackageNameFromVersionRange(child.key.value);
        }
        if (pkgName) {
            const { loc } = child.value.type === 'Literal' ? child : child.key
            if (loc) {
                results.push({
                    range: rangeForJSONAstLoc(loc),
                    name: pkgName
                })
            }
        }
        const { value } = child
        if (value.type === 'Object') {
            parsePkgOverrideExternals(value, results, pkgName ?? contextualName)
        } else if (value.type === 'Literal') {
            if (typeof value.value === 'string') {
                if (value.value.startsWith('$')) {
                    const { loc } = value;
                    if (loc) {
                        results.push({
                            range: rangeForJSONAstLoc(loc),
                            name: value.value.slice(1)
                        })
                    }
                }
            }
        }
    }
}
