import { SocketYml } from '@socketsecurity/config';
import * as acorn from 'acorn'
import * as acornTypes from "ast-types";
import * as vscode from 'vscode'
import { SocketReport } from '../data/report';
import { shouldShowIssue, sortIssues } from '../util';

// TODO: cache by detecting open editors and closing
export function activate(
    context: vscode.ExtensionContext,
    reports: ReturnType<(typeof import('../data/report'))['activate']>,
    socketConfig: Awaited<ReturnType<(typeof import('../data/socket-yaml'))['activate']>>
) {
    let srcToHoversAndCount = new Map<string, {
        refCount: number,
        hovers: Array<vscode.Hover>
    }>()
    let urlToSrc = new Map<string, string>()
    // vscode.workspace.onDidOpenTextDocument(e => {
        
    // })
    vscode.workspace.onDidChangeTextDocument(e => {
        let savedUrlSrc = urlToSrc.get(e.document.fileName)
        if (savedUrlSrc === undefined) {
            return
        }
        deref(savedUrlSrc)
    })
    vscode.workspace.onDidCloseTextDocument(e => {
        let savedUrlSrc = urlToSrc.get(e.fileName)
        if (savedUrlSrc === undefined) {
            return
        }
        deref(savedUrlSrc)
    })
    function deref(src: string) {
        let hoversAndCount = srcToHoversAndCount.get(src)
        if (hoversAndCount) {
            if (hoversAndCount.refCount === 1) {
                srcToHoversAndCount.delete(src)
            } else {
                hoversAndCount.refCount--;
            }
        }
    }
    function refAndParseIfNeeded(src: string, socketReport: SocketReport, socketYamlConfig: SocketYml) {
        let hoversAndCount = srcToHoversAndCount.get(src)
        if (hoversAndCount) {
            hoversAndCount.refCount++
        } else {
            const ast = acorn.parse(
                src,
                {
                    ecmaVersion: 'latest',
                    allowImportExportEverywhere: true,
                    locations: true
                }
            )
            let hovers: Array<vscode.Hover> = []

            function addHoverOnTopLiteral(node: acornTypes.namedTypes.Node, name: string) {
                if (/^[\.\/]/u.test(name)) {
                    return
                }
                name = (
                    name.startsWith('@') ?
                    name.split('/', 2) :
                    name.split('/', 1)
                ).join('/')
                const loc = node.loc
                if (!loc) return
                if (!socketReport) return
                let relevantIssues = []
                for (const issue of socketReport.issues) {
                    if (issue.value.locations.find(l => {
                        return l.type === 'npm' && l.value.package === name
                    })) {
                        if (shouldShowIssue(issue.type, issue.value.severity, socketYamlConfig)) {
                            relevantIssues.push(issue)
                        }
                    }
                }
                if (relevantIssues.length === 0) {
                    return;
                }
                const startPos: vscode.Position = new vscode.Position(loc.start.line - 1, loc.start.column)
                const endPos: vscode.Position = new vscode.Position(loc.end.line - 1, loc.end.column)
                const range = new vscode.Range(startPos, endPos)
                const viz = new vscode.MarkdownString(`
Socket Security Summary for <a href="https://socket.dev/npm/package/${name}">${name} $(link-external)</a>:

Severity | Type | Description
-------- | ---- | -----------
${relevantIssues.sort((a, b) => sortIssues({
                    severity: a.value.severity,
                    type: a.type
                }, {
                    severity: b.value.severity,
                    type: b.type
                })).map(issue => {
                    return `${issue.value.severity} | ${issue.type} | ${issue.value.description}`
                }).join('\n')
                    }
`, true);
                viz.supportHtml = true
                hovers.push(new vscode.Hover(viz, range))
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
            function constFor(node: acornTypes.ASTNode): DYNAMIC_VALUE | (() => PRIMITIVE) {
                if (acornTypes.namedTypes.TemplateLiteral.check(node)) {
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
                } else if (acornTypes.namedTypes.BigIntLiteral.check(node)) {
                    return () => BigInt(node.value)
                } else if (acornTypes.namedTypes.Literal.check(node)) {
                    const { value } = node
                    if (value && typeof value === 'object') {
                        // regexp literal
                        return kDYNAMIC_VALUE
                    }
                    return () => value
                } else if (acornTypes.namedTypes.BinaryExpression.check(node)) {
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
                } else if (acornTypes.namedTypes.UnaryExpression.check(node)) {
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
                } else if (acornTypes.namedTypes.ParenthesizedExpression.check(node)) {
                    return constFor(node.expression)
                } else if (acornTypes.namedTypes.AwaitExpression.check(node)) {
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
            acornTypes.visit(ast, {
                visitImportDeclaration(path) {
                    addHoverOnTopLiteral(path.node.source, `${path.node.source.value}`)
                    return false
                },
                visitImportExpression(path) {
                    const { node } = path
                    let constantArg = constFor(node.source)
                    if (constantArg !== kDYNAMIC_VALUE) {
                        addHoverOnTopLiteral(node, `${constantArg()}`)
                    }
                    this.traverse(path)
                },
                visitCallExpression(path) {
                    const { node } = path
                    const { callee } = node
                    if (node.arguments.length > 0) {
                        if (acornTypes.namedTypes.Identifier.check(callee) && callee.name === 'require') {
                            const { arguments: [firstArg] } = node
                            let constantArg = constFor(firstArg)
                            if (constantArg !== kDYNAMIC_VALUE) {
                                addHoverOnTopLiteral(node, `${constantArg()}`)
                            }
                        }
                    }
                    this.traverse(path)
                }
            })
            srcToHoversAndCount.set(src, {
                refCount: 1,
                hovers
            })
        }
    }
    context.subscriptions.push(vscode.languages.registerHoverProvider('javascript', {
        provideHover(document, position, token) {
            const socketReportData = reports.effectiveReportForUri(document.uri)
            if (socketReportData.defaulted) {
                return
            }
            const socketReport = socketReportData.data
            const socketYamlConfig = socketConfig.effectiveConfigForUri(document.uri).data
            const src = document.getText()
            let existingSrc = urlToSrc.get(document.fileName)
            if (existingSrc !== undefined) {
                // changed
                if (existingSrc !== src) {
                    deref(src);
                    refAndParseIfNeeded(src, socketReport, socketYamlConfig);
                } else {
                    // unchanged src, changed setting?
                }
            } else {
                // new
                refAndParseIfNeeded(src, socketReport, socketYamlConfig);
            }
            urlToSrc.set(document.fileName, src)
            let cachedHoversAndCount = srcToHoversAndCount.get(src)
            if (cachedHoversAndCount) {
                let { hovers } = cachedHoversAndCount
                if (hovers.length) {
                    for (const hover of hovers) {
                        if (hover.range?.contains(position)) {
                            return hover
                        }
                    }
                }
            }
            return undefined
        }
    }));
}