import * as vscode from 'vscode';
import { radixMergeReportIssues } from '../data/report';
import { EXTENSION_PREFIX, shouldShowIssue, sortIssues } from '../util';
import * as https from 'node:https';
import * as consumer from 'node:stream/consumers';
import * as module from 'module';
import { parseExternals, SUPPORTED_LANGUAGE_IDS } from './parse-externals';

// @ts-expect-error the types are wrong
let isBuiltin = module.isBuiltin ||
    ((builtinModules) => {
        const builtins = new Set(builtinModules);
        return (name) => {
            return builtins.has(name.startsWith('node:') ? name.slice(5) : name);
        };
    })(module.builtinModules);
// TODO: cache by detecting open editors and closing
export function activate(context, reports, socketConfig, editorConfig) {
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
    let srcToHoversAndCount = new Map();
    let urlToSrc = new Map();
    // vscode.workspace.onDidOpenTextDocument(e => {
    // })
    context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(e => {
        if (e.document.uri.scheme !== 'file')
            return;
        decorateEditors();
    }));
    context.subscriptions.push(vscode.workspace.onDidCloseTextDocument(e => {
        deref(e);
    }));
    function deref(doc) {
        let hoversAndCount = srcToHoversAndCount.get(doc.fileName);
        if (hoversAndCount) {
            if (hoversAndCount.refCount === 1) {
                srcToHoversAndCount.delete(doc.fileName);
            }
            else {
                hoversAndCount.refCount--;
            }
        }
    }
    const depscoreCache = new Map();
    function getDepscore(pkgName, signal) {
        if (signal.aborted) {
            return Promise.reject('Aborted');
        }
        const existing = depscoreCache.get(pkgName);
        const time = Date.now();
        if (existing && time < existing.expires) {
            return existing.score;
        }
        const score = new Promise((f, r) => {
            const req = https.get(`https://socket.dev/api/npm/package-info/score?name=${pkgName}`);
            function cleanupReq() {
                try {
                    req.destroy();
                }
                catch {
                }
                r(Promise.reject('Aborted'));
            }
            signal.addEventListener('abort', cleanupReq);
            req.end();
            req.on('error', r);
            req.on('response', (res) => {
                signal.removeEventListener('abort', cleanupReq);
                function cleanupRes() {
                    try {
                        res.destroy();
                    }
                    catch {
                    }
                    r(Promise.reject('Aborted'));
                }
                signal.addEventListener('abort', cleanupRes);
                if (res.statusCode === 200) {
                    consumer.json(res).then((obj) => {
                        signal.removeEventListener('abort', cleanupRes);
                        f(obj);
                    }).catch(e => {
                        r(e);
                    });
                }
            });
        });
        depscoreCache.set(pkgName, {
            // 10minute cache
            expires: time + 10 * 60 * 1000,
            score
        });
        return score;
    }
    function refAndParseIfNeeded(doc, socketReport, socketYamlConfig) {
        // const src = doc.getText()
        let hoversAndCount = srcToHoversAndCount.get(doc.fileName);
        if (hoversAndCount) {
            hoversAndCount.refCount++;
        }
        else {
            if (!socketReport)
                return;
            let hovers = [];
            const externals = parseExternals(doc);
            if (!externals) {
                return;
            }
            const issues = radixMergeReportIssues(socketReport);
            for (const { name, range } of externals) {
                const pkgIssues = issues.get(name);
                if (!pkgIssues || pkgIssues.size === 0) {
                    continue;
                }
                const relevantIssues = [];
                const irrelevantIssues = [];
                for (const [severity, types] of pkgIssues) {
                    for (const [type, descriptions] of types) {
                        for (const description of descriptions) {
                            if (shouldShowIssue(type, severity, socketYamlConfig)) {
                                relevantIssues.push({
                                    type,
                                    severity,
                                    description
                                });
                            }
                            else {
                                irrelevantIssues.push({
                                    type,
                                    severity,
                                    description
                                });
                            }
                        }
                    }
                }
                if (relevantIssues.length === 0 && irrelevantIssues.length === 0) {
                    continue;
                }
                let vizMarkdown = `Socket Security Summary for <a href="https://socket.dev/npm/package/${name}">${name} $(link-external)</a>:\n`;
                function issueTable(issues) {
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
                        return `${issue.severity} | ${issue.type} | ${issue.description}`;
                    }).join('\n')}\n`;
                }
                if (relevantIssues.length > 0) {
                    vizMarkdown += issueTable(relevantIssues);
                }
                if (irrelevantIssues.length > 0) {
                    vizMarkdown += `<details><summary>Hidden Issues</summary>${issueTable(irrelevantIssues)}</details>\n`;
                }
                const viz = new vscode.MarkdownString(vizMarkdown, true);
                viz.supportHtml = true;
                hovers.push(new vscode.Hover(viz, range));
            }
            srcToHoversAndCount.set(doc.fileName, {
                refCount: 1,
                hovers
            });
        }
    }
    const hoverProvider = {
        provideHover(document, position, token) {
            const socketReportData = reports.effectiveReportForUri(document.uri);
            const socketReport = socketReportData.data;
            const socketYamlConfig = socketConfig.effectiveConfigForUri(document.uri).data;
            const src = document.getText();
            let existingSrc = urlToSrc.get(document.fileName);
            if (existingSrc !== undefined) {
                // changed
                if (existingSrc !== src) {
                    deref(document);
                    refAndParseIfNeeded(document, socketReport, socketYamlConfig);
                }
                else {
                    // unchanged src, changed setting?
                }
            }
            else {
                // new
                refAndParseIfNeeded(document, socketReport, socketYamlConfig);
            }
            urlToSrc.set(document.fileName, src);
            let cachedHoversAndCount = srcToHoversAndCount.get(document.fileName);
            if (cachedHoversAndCount) {
                let { hovers } = cachedHoversAndCount;
                if (hovers.length) {
                    for (const hover of hovers) {
                        if (hover.range?.contains(position)) {
                            return hover;
                        }
                    }
                }
            }
            return undefined;
        }
    };
    for (const languageId of SUPPORTED_LANGUAGE_IDS) {
        context.subscriptions.push(vscode.languages.registerHoverProvider(languageId, hoverProvider));
    }
    let currentDecorateEditors = new AbortController();
    editorConfig.onDependentConfig([
        `${EXTENSION_PREFIX}.warnOverlayThreshold`,
        `${EXTENSION_PREFIX}.errorOverlayThreshold`
    ], () => {
        decorateEditors();
    });
    function decorateEditor(e, abortSignal) {
        if (!SUPPORTED_LANGUAGE_IDS.includes(e.document.languageId)) {
            return;
        }
        const informativeDecorations = [];
        const warningDecorations = [];
        const errorDecorations = [];
        e.setDecorations(informativeDecoration, informativeDecorations);
        e.setDecorations(errorDecoration, errorDecorations);
        e.setDecorations(warningDecoration, warningDecorations);
        const externals = parseExternals(e.document);
        if (!externals) {
            return;
        }
        for (const { name, range } of externals) {
            if (isBuiltin(name)) {
                const deco = {
                    range,
                    hoverMessage: `Socket Security skipped for builtin module`
                };
                informativeDecorations.push(deco);
                e.setDecorations(informativeDecoration, informativeDecorations);
                continue;
            }
            getDepscore(name, abortSignal).then(score => {
                if (abortSignal.aborted) {
                    return;
                }
                const { score: { depscore } } = score;
                const depscoreStr = (depscore * 100).toFixed(0);
                const hoverMessage = new vscode.MarkdownString(`
Socket Security for [${name} $(link-external)](https://socket.dev/npm/package/${name}): ${depscoreStr}
                
<table>
<tr>
<td> Lines of Code </td>
<td>${score.metrics.linesOfCode} </td>
</tr>
<tr>
<td> Dependencies </td>
<td>${score.metrics.dependencyCount} </td>
</tr>
<tr>
<td> Dev Dependencies </td>
<td>${score.metrics.devDependencyCount} </td>
</tr>
<tr>
<td> Transitive Dependencies </td>
<td>${score.metrics.transitiveDependencyCount} </td>
</tr>
</table>
`, true);
                hoverMessage.supportHtml = true;
                const deco = {
                    range,
                    hoverMessage
                };
                const [warnOverlayThreshold, errorOverlayThreshold] = editorConfig.getConfigValues([
                    `${EXTENSION_PREFIX}.warnOverlayThreshold`,
                    `${EXTENSION_PREFIX}.errorOverlayThreshold`
                ]);
                let decoType = null;
                let decoPool = null;
                // have to scale, API is 0-1 Config/UX uses 0-100
                const depscoreScaledToConfig = depscore * 100;
                if (depscoreScaledToConfig < errorOverlayThreshold) {
                    decoType = errorDecoration;
                    decoPool = errorDecorations;
                }
                else if (depscoreScaledToConfig < warnOverlayThreshold) {
                    decoType = warningDecoration;
                    decoPool = warningDecorations;
                }
                if (!decoType || !decoPool) {
                    decoType = informativeDecoration;
                    decoPool = informativeDecorations;
                }
                decoPool.push(deco);
                e.setDecorations(decoType, decoPool);
            });
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
    }));
    decorateEditors();
}
//# sourceMappingURL=javascript-file.js.map