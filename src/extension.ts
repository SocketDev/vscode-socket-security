// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below

import * as vscode from 'vscode';
import { ExtensionContext, workspace } from 'vscode';
import * as socketYaml from './data/socket-yaml'
import * as pkgJSON from './ui/package-json';
import * as report from './data/report'
import { radixMergeReportIssues, SocketReport } from './data/report';
import { EXTENSION_PREFIX, DIAGNOSTIC_SOURCE_STR, getWorkspaceFolderURI, shouldShowIssue, sortIssues } from './util';
import * as editorConfig from './data/editor-config';
import { installGithubApp } from './data/github';
import * as files from './ui/file'
import { parseExternals } from './ui/parse-externals';
import watch, { SharedFilesystemWatcherHandler } from './fs-watch';
import { initPython, onMSPythonInterpreterChange } from './data/python-interpreter';
import { getGlobPatterns } from './data/glob-patterns';

export async function activate(context: ExtensionContext) {
    context.subscriptions.push(
        vscode.commands.registerCommand(`${EXTENSION_PREFIX}.installGitHubApp`,installGithubApp),
        vscode.commands.registerCommand(`${EXTENSION_PREFIX}.ignoreIssueType`, async (from: vscode.Uri, type: string) => {
            if (vscode.env.isTelemetryEnabled) {
                // ignored on which dep
                // how many times diagnostic has show prior
                // version of pkg bumped after diagnostic seen?
            }
            socketConfig.update(from, [
                ['issueRules', type], false
            ])
        }),
    )
    const config = editorConfig.activate(context);
    const [socketConfig, reports] = await Promise.all([
        socketYaml.activate(context),
        report.activate(context)
    ])
    files.activate(context, reports, socketConfig, config)
    const diagnostics = vscode.languages.createDiagnosticCollection()
    const watchHandler: SharedFilesystemWatcherHandler = {
        onDidChange(f) {
            const workspaceFolderURI = getWorkspaceFolderURI(f)
            if (!workspaceFolderURI) {
                return;
            }
            populateDiagnostics(workspaceFolderURI)
        },
        onDidCreate(f) {
            const workspaceFolderURI = getWorkspaceFolderURI(f)
            if (!workspaceFolderURI) {
                return;
            }
            populateDiagnostics(workspaceFolderURI)
        },
        onDidDelete(f) {
            diagnostics.delete(f)
        }
    }

    const supportedFiles = await getGlobPatterns();
    const watchTargets = [
        ...Object.values(supportedFiles.npm),
        ...Object.values(supportedFiles.pypi)
    ].map(info => info.pattern);

    context.subscriptions.push(
        diagnostics,
        await initPython(),
        ...watchTargets.map(target => watch(target, watchHandler))
    );
    const runAll = () => {
        if (workspace.workspaceFolders) {
            for (const workFolder of workspace.workspaceFolders) {
                populateDiagnostics(workFolder.uri)
            }
        }
    }
    runAll();
    context.subscriptions.push(
        reports.onReport(null, async (evt) => {
            populateDiagnostics(evt.uri)
        }),
        socketConfig.onConfig(null, async (evt) => {
            populateDiagnostics(evt.uri)
        }),
        config.onDependentConfig([
            `${EXTENSION_PREFIX}.showAllIssueTypes`,
            `${EXTENSION_PREFIX}.minIssueLevel`,
            `${EXTENSION_PREFIX}.pythonInterpreter`
        ], runAll),
        onMSPythonInterpreterChange(() => {
            if (!vscode.workspace.getConfiguration(EXTENSION_PREFIX).get('pythonInterpreter')) {
                runAll();
            }
        })
    )
    async function normalizeReportAndLocations(report: SocketReport, doc: Parameters<typeof parseExternals>[0]) {
        const externals = await parseExternals(doc)
        if (!externals) {
            return
        }
        const issuesForSource = radixMergeReportIssues(report)
        let ranges: Record<string, Array<vscode.Range>> = Object.create(null);
        let prioritizedRanges: Record<string, { range: vscode.Range, prioritize: boolean }> = Object.create(null)
        function pushRelatedRange(name: string, range: vscode.Range) {
            const existingRanges = ranges[name] ?? []
            existingRanges.push(range)
            ranges[name] = existingRanges
        }
        for (let { name, range, prioritize } of externals) {
            prioritize = prioritize ?? false
            let existingIssuesBySeverity = issuesForSource.get(name)
            if (!existingIssuesBySeverity) continue
            const existingPrioritizedRange = prioritizedRanges[name]
            if (existingPrioritizedRange) {
                if (existingPrioritizedRange.prioritize) {
                    if (prioritize && range.start.isBefore(existingPrioritizedRange.range.start)) {
                        pushRelatedRange(name, existingPrioritizedRange.range);
                        prioritizedRanges[name] = { range, prioritize }
                        continue
                    } else {
                        pushRelatedRange(name, range);
                    }
                } else {
                    if (prioritize || range.start.isBefore(existingPrioritizedRange.range.start)) {
                        pushRelatedRange(name, existingPrioritizedRange.range);
                        prioritizedRanges[name] = { range, prioritize }
                        continue
                    } else {
                        pushRelatedRange(name, range);
                    }
                }
            } else {
                prioritizedRanges[name] = { range, prioritize }
            }
        }
        const issueLocations = []
        for (const [ name, {range} ] of Object.entries(prioritizedRanges)) {
            let existingIssuesBySeverity = issuesForSource.get(name)
            if (!existingIssuesBySeverity) continue
            for (const [severity, existingIssuesByType] of existingIssuesBySeverity) {
                for (const type of [...existingIssuesByType.keys()].sort()) {
                    const existingIssuesByDescription = existingIssuesByType.get(type);
                    if (existingIssuesByDescription) {
                        for (const description of existingIssuesByDescription) {
                            issueLocations.push({
                                pkgName: name,
                                type,
                                description,
                                severity,
                                range,
                                related: ranges[name] ?? []
                            })
                        }
                    }
                }
            }
        }
        return issueLocations
    }
    async function populateDiagnostics(workspaceFolderURI: vscode.Uri) {
        const effectiveData = reports.effectiveReportForUri(workspaceFolderURI)
        const currentReport = effectiveData.data
        if (!currentReport) return
        const socketYamlConfig = socketConfig.effectiveConfigForUri(workspaceFolderURI).data
        if (socketYamlConfig.enabled === false) {
            diagnostics.clear()
            return
        }
        const pkgs = await workspace.findFiles('**/package{.json}', '**/node_modules/**')
        const workspacePkgs = pkgs.filter(uri => getWorkspaceFolderURI(uri) === workspaceFolderURI)
        if (workspacePkgs.length === 0) {
            return
        }
        for (const textDocumentURI of workspacePkgs) {
            const packageJSONSource = Buffer.from(await workspace.fs.readFile(textDocumentURI)).toString()
            const relevantIssues = (await normalizeReportAndLocations(currentReport, {
                getText() {
                    return packageJSONSource
                },
                fileName: textDocumentURI.fsPath,
                languageId: 'json'
            }))?.sort(sortIssues)
            if (relevantIssues && relevantIssues.length) {
                const diagnosticsToShow = (await Promise.all(relevantIssues.map(
                    async (issue) => {
                        const should = shouldShowIssue(issue.type, issue.severity, socketYamlConfig)
                        if (!should) {
                            return null
                        }
                        const diag = new vscode.Diagnostic(
                            issue.range,
                            issue.description, 
                            issue.severity === 'low' ?
                                vscode.DiagnosticSeverity.Information :
                                issue.severity !== 'critical' ?
                                    vscode.DiagnosticSeverity.Warning :
                                    vscode.DiagnosticSeverity.Error
                        )
                        diag.relatedInformation = issue.related.map(
                            (r) => new vscode.DiagnosticRelatedInformation(
                                new vscode.Location(textDocumentURI, r),
                                'installation reference'
                            )
                        )
                        diag.source = DIAGNOSTIC_SOURCE_STR
                        diag.code = `${issue.type}, ${issue.pkgName}`
                        return diag
                    }
                ))).filter(x => !!x) as vscode.Diagnostic[]
                diagnostics.set(textDocumentURI, diagnosticsToShow)
            }
        }
    }

    context.subscriptions.push(
        pkgJSON.registerCodeLensProvider(),
        pkgJSON.registerCodeActionsProvider()
    )
}
