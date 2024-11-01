import { SocketYml } from '@socketsecurity/config';
import * as vscode from 'vscode'
import { radixMergeReportIssues, SocketReport } from '../data/report';
import { EXTENSION_PREFIX, getDiagnosticSeverity, getWorkspaceFolderURI, sortIssues } from '../util';
import * as https from 'node:https';
import * as consumer from 'node:stream/consumers'
import * as module from 'module'
import { parseExternals, SUPPORTED_LANGUAGES } from './parse-externals';
import { isPythonBuiltin } from '../data/python/builtins';
import { isGoBuiltin } from '../data/go/builtins';
import { getExistingAPIConfig, getAPIConfig, toAuthHeader } from '../data/socket-api-config';
import { sniffForGithubOrgOrUser } from '../data/github';

// @ts-expect-error missing module.isBuiltin
let isNodeBuiltin: (name: string) => boolean = module.isBuiltin ||
    ((builtinModules: string[]) => {
        const builtins = new Set<string>(builtinModules);
        return (name: string) => {
            return builtins.has(name.startsWith('node:') ? name.slice(5) : name);
        };
    })(module.builtinModules);

let isBuiltin = (name: string, eco: string): boolean => {
    if (eco === 'npm') return isNodeBuiltin(name);
    if (eco === 'pypi') return isPythonBuiltin(name);
    if (eco === 'go') return isGoBuiltin(name);
    return false;
}

let isLocalPackage = (name: string, eco: string): boolean => {
    if (eco === 'npm') return name.startsWith('.') || name.startsWith('/')
    if (eco === 'pypi') return name.startsWith('.')
    if (eco === 'go') {
        const parts = name.split('/')
        return parts.some(p => p.startsWith('.')) || !parts[0].includes('.') ||
            !/[a-z0-9][a-z0-9.-]*/.test(parts[0])
    }
    return false;
}
    

// TODO: cache by detecting open editors and closing
export function activate(
    context: vscode.ExtensionContext,
    reports: Awaited<ReturnType<(typeof import('../data/report'))['activate']>>,
    socketConfig: Awaited<ReturnType<(typeof import('../data/socket-yaml'))['activate']>>,
    editorConfig: ReturnType<typeof import('../data/editor-config')['activate']>
) {
    let errorDecoration = vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        after: {
            margin: '0 0 0 2rem',
            contentIconPath: vscode.Uri.file(context.asAbsolutePath('logo-red.svg')),
            width: '12px',
            height: '12px',
        },
    });
    let warningDecoration = vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        after: {
            margin: '0 0 0 2rem',
            contentIconPath: vscode.Uri.file(context.asAbsolutePath('logo-yellow.svg')),
            width: '12px',
            height: '12px',
        },
    });
    let informativeDecoration = vscode.window.createTextEditorDecorationType({});
    let srcToHoversAndCount = new Map<vscode.TextDocument['fileName'], {
        refCount: number,
        hovers: Array<vscode.Hover>
    }>()
    let urlToSrc = new Map<string, string>()
    // vscode.workspace.onDidOpenTextDocument(e => {
        
    // })
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(e => {
            if (e.document.uri.scheme !== 'file') return;
            decorateEditors()
        })
    )
    context.subscriptions.push(
        vscode.workspace.onDidCloseTextDocument(e => {
            deref(e)
        })
    )
    function deref(doc: vscode.TextDocument) {
        let hoversAndCount = srcToHoversAndCount.get(doc.fileName);
        if (hoversAndCount) {
            if (hoversAndCount.refCount === 1) {
                srcToHoversAndCount.delete(doc.fileName);
                urlToSrc.delete(doc.fileName);
            } else {
                hoversAndCount.refCount--;
            }
        }
    }
    type PackageScore = {
        score: {
           depscore: number
        },
        metrics: {
            linesOfCode?: number,
            dependencyCount?: number,
            devDependencyCount?: number,
            transitiveDependencyCount?: number,
        }
    }
    const depscoreCache = new Map<string, {
        expires: number,
        score: Promise<PackageScore>
    }>()
    function getDepscore(pkgName: string, eco: string, signal: AbortSignal): Promise<PackageScore> {
        if (signal.aborted) {
            return Promise.reject('Aborted');
        }
        if (['go', 'golang', 'pypi'].includes(eco)) {
            // TODO: implement PyPI depscores in backend
            return Promise.reject('Python depscores unavailable');
        }
        const cacheKey = `${eco}.${pkgName}`
        const existing = depscoreCache.get(cacheKey)
        const time = Date.now();
        if (existing && time < existing.expires) {
            return existing.score;
        }
        const score = new Promise<PackageScore>(async (f, r) => {
            const apiConfig = await getAPIConfig()
            if (!apiConfig) {
                return
            }
            const req = https.request(`https://socket.dev/api/${eco}/package-info/score?name=${pkgName}`, {
                method: 'POST',
                headers: {
                    'content-type': 'json',
                    'authorization': toAuthHeader(apiConfig.apiKey)
                }
            });
            function cleanupReq() {
                try {
                    req.destroy();
                } catch {
                }
                r(Promise.reject('Aborted'));
            }
            signal.addEventListener('abort', cleanupReq);
            req.end(JSON.stringify({
                components: [
                    purl: `pkg:${eco}/${pkgName}`
                ]
            }));
            req.on('error', r);
            req.on('response', (res) => {
                signal.removeEventListener('abort', cleanupReq);
                function cleanupRes() {
                    try {
                        res.destroy();
                    } catch {
                    }
                    r(Promise.reject('Aborted'));
                }
                signal.addEventListener('abort', cleanupRes);
                if (res.statusCode === 200) {
                    consumer.json(res).then((obj: any) => {
                        signal.removeEventListener('abort', cleanupRes);
                        f(obj as PackageScore);
                    }).catch(e => {
                        r(e);
                    })
                }
            })
        });
        depscoreCache.set(cacheKey, {
            // 10minute cache
            expires: time + 10 * 60 * 1000,
            score
        });
        return score;
    }
    async function refAndParseIfNeeded(doc: vscode.TextDocument, socketReport: SocketReport, socketYamlConfig: SocketYml) {
        const eco = SUPPORTED_LANGUAGES[doc.languageId]
        // const src = doc.getText()
        let hoversAndCount = srcToHoversAndCount.get(doc.fileName)
        if (hoversAndCount) {
            hoversAndCount.refCount++
        } else {
            if (!socketReport) return
            let hovers: Array<vscode.Hover> = []
            const externals = await parseExternals(doc)
            if (!externals) {
                return
            }
            const apiConf = await getExistingAPIConfig()
            if (!apiConf) {
                return
            }
            const folderURI = getWorkspaceFolderURI(doc.uri)
            const ghOrg = folderURI && await sniffForGithubOrgOrUser(folderURI)
            const issueRules = apiConf.orgRules.find(org => org.name === ghOrg)?.issueRules ||
                apiConf.defaultRules
            const issues = radixMergeReportIssues(socketReport)
            const ecoIssues = issues.get(eco)
            for (const {name, range} of externals) {
                const pkgIssues = ecoIssues?.get(name)
                if (!pkgIssues || pkgIssues.size === 0) {
                    continue
                }
                type IssueTableEntry = {
                    type: string,
                    severity: string,
                    description: string
                }
                const relevantIssues: IssueTableEntry[] = []
                const irrelevantIssues: IssueTableEntry[] = []
                for (const [severity, types] of pkgIssues) {
                    for (const [type, descriptions] of types) {
                        for (const description of descriptions) {
                            if (getDiagnosticSeverity(type, severity, apiConf.enforcedRules, issueRules, socketYamlConfig) != null) {
                                relevantIssues.push({
                                    type,
                                    severity,
                                    description
                                })
                            } else {
                                irrelevantIssues.push({
                                    type,
                                    severity,
                                    description
                                })
                            }
                        }
                    }
                }
                if (relevantIssues.length === 0 && irrelevantIssues.length === 0) {
                    continue
                }
                let vizMarkdown = `Socket Security Summary for <a href="https://socket.dev/${eco}/package/${name}">${name} $(link-external)</a>:\n`
                function issueTable(issues: IssueTableEntry[]) {
                    return `\n
Severity | Type | Description
-------- | ---- | -----------
${issues.sort((a, b) => sortIssues({
                    severity: a.severity,
                    type: a.type
                }, {
                    severity: b.severity,
                    type: b.type
                })).map(issue => {
                    return `${issue.severity} | ${issue.type} | ${issue.description}`
                }).join('\n')
}\n`
                } 
                if (relevantIssues.length > 0) {
                    vizMarkdown += issueTable(relevantIssues);
                }
                if (irrelevantIssues.length > 0) {
                    vizMarkdown += `<details><summary>Hidden Issues</summary>${issueTable(irrelevantIssues)}</details>\n`;
                }
                const viz = new vscode.MarkdownString(vizMarkdown, true)
                viz.supportHtml = true
                hovers.push(new vscode.Hover(viz, range))
            }

            srcToHoversAndCount.set(doc.fileName, {
                refCount: 1,
                hovers
            })
        }
    }
    const hoverProvider: vscode.HoverProvider = {
        async provideHover(document, position, token) {
            const socketReportData = reports.effectiveReportForUri(document.uri)
            const socketReport = socketReportData.data
            const socketYamlConfig = socketConfig.effectiveConfigForUri(document.uri).data
            const src = document.getText()
            let existingSrc = urlToSrc.get(document.fileName)
            if (existingSrc !== undefined) {
                // changed
                if (existingSrc !== src) {
                    deref(document);
                    await refAndParseIfNeeded(document, socketReport, socketYamlConfig);
                } else {
                    // unchanged src, changed setting?
                }
            } else {
                // new
                await refAndParseIfNeeded(document, socketReport, socketYamlConfig);
            }
            urlToSrc.set(document.fileName, src)
            let cachedHoversAndCount = srcToHoversAndCount.get(document.fileName)
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
    };
    for (const languageId in SUPPORTED_LANGUAGES) {
        context.subscriptions.push(vscode.languages.registerHoverProvider(languageId, hoverProvider));
    }
    let currentDecorateEditors: AbortController = new AbortController()
    editorConfig.onDependentConfig(
        [
            `${EXTENSION_PREFIX}.warnOverlayThreshold`,
            `${EXTENSION_PREFIX}.errorOverlayThreshold`
        ], () => {
            decorateEditors()
        }
    );
    async function decorateEditor(e: vscode.TextEditor, abortSignal: AbortSignal) {
        const eco = SUPPORTED_LANGUAGES[e.document.languageId];
        if (!eco) return

        const informativeDecorations: Array<vscode.DecorationOptions> = [];
        const warningDecorations: Array<vscode.DecorationOptions> = [];
        const errorDecorations: Array<vscode.DecorationOptions> = [];

        const externals = await parseExternals(e.document)
        e.setDecorations(informativeDecoration, informativeDecorations);
        e.setDecorations(errorDecoration, errorDecorations);
        e.setDecorations(warningDecoration, warningDecorations);
        if (!externals) {
            return
        }
        for (const {name, range} of externals) {
            if (isBuiltin(name, eco)) {
                const deco: vscode.DecorationOptions = {
                    range,
                    hoverMessage: `Socket Security skipped for builtin module`
                }
                informativeDecorations.push(deco);
                e.setDecorations(informativeDecoration, informativeDecorations)
                continue;
            }
            if (isLocalPackage(name, eco)) {
                continue
            }
            getDepscore(name, eco, abortSignal).then(score => {
                if (abortSignal.aborted) {
                    return;
                }
                const { score: { depscore }} = score
                const depscoreStr = (depscore * 100).toFixed(0)
                const hoverMessage = new vscode.MarkdownString(`
Socket Security for [${name} $(link-external)](https://socket.dev/${eco}/package/${name}): ${depscoreStr}
                
<table>
${score.metrics.linesOfCode == null ? '' : `<tr>
<td> Lines of Code </td>
<td> ${score.metrics.linesOfCode} </td>
</tr>`}
${score.metrics.dependencyCount == null ? '' :`<tr>
<td> Dependencies </td>
<td> ${score.metrics.dependencyCount} </td>
</tr>`}
${score.metrics.devDependencyCount == null ? '' :`<tr>
<td> Dev Dependencies </td>
<td> ${score.metrics.devDependencyCount} </td>
</tr>`}
${score.metrics.transitiveDependencyCount == null ? '' :`<tr>
<td> Transitive Dependencies </td>
<td> ${score.metrics.transitiveDependencyCount} </td>
</tr>`}
</table>
`, true)
                hoverMessage.supportHtml = true
                const deco: vscode.DecorationOptions = {
                    range,
                    hoverMessage
                }
                const [
                    warnOverlayThreshold,
                    errorOverlayThreshold
                ] = editorConfig.getConfigValues<[number, number]>([
                    `${EXTENSION_PREFIX}.warnOverlayThreshold`,
                    `${EXTENSION_PREFIX}.errorOverlayThreshold`
                ]);
                let decoType = null
                let decoPool = null
                // have to scale, API is 0-1 Config/UX uses 0-100
                const depscoreScaledToConfig = depscore * 100
                if (depscoreScaledToConfig < errorOverlayThreshold) {
                    decoType = errorDecoration
                    decoPool = errorDecorations
                } else if (depscoreScaledToConfig < warnOverlayThreshold) {
                    decoType = warningDecoration
                    decoPool = warningDecorations
                }
                if (!decoType || !decoPool) {
                    decoType = informativeDecoration;
                    decoPool = informativeDecorations;
                }
                decoPool.push(deco);
                e.setDecorations(decoType, decoPool);
            }, err => {})
        }
    }
    function decorateEditors() {
        currentDecorateEditors.abort();
        currentDecorateEditors = new AbortController();
        const abortSignal = currentDecorateEditors.signal;
        for (const e of vscode.window.visibleTextEditors) {
            decorateEditor(e, abortSignal);
        }
    }
    context.subscriptions.push(vscode.window.onDidChangeVisibleTextEditors(() => {
        decorateEditors();
    }))
    decorateEditors();
}
