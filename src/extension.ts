// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below

import * as vscode from 'vscode';
import { ExtensionContext, languages, workspace } from 'vscode';
import jsonToAST from 'json-to-ast'
import * as socketYaml from './data/socket-yaml'
import { provideCodeActions as pkgJSONProvideCodeActions, provideCodeLenses as pkgJSONProvideCodeLenses } from './ui/package-json';
import * as report from './data/report'
import { SocketReport } from './data/report';
import { EXTENSION_PREFIX, DIAGNOSTIC_SOURCE_STR, getWorkspaceFolderURI, shouldShowIssue, sortIssues } from './util';
import * as editorConfig from './data/editor-config';
import { installGithubApp } from './data/github';
import * as javascriptFiles from './ui/javascript-file'

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
    javascriptFiles.activate(context, reports, socketConfig)
    const diagnostics = vscode.languages.createDiagnosticCollection()
    const pkgWatcher = vscode.workspace.createFileSystemWatcher('package.json');

    context.subscriptions.push(
        diagnostics,
        pkgWatcher,
        pkgWatcher.onDidChange((f) => {
            const workspaceFolderURI = getWorkspaceFolderURI(f)
            if (!workspaceFolderURI) {
                return;
            }
            populateDiagnostics(workspaceFolderURI)
        }),
        pkgWatcher.onDidCreate((f) => {
            const workspaceFolderURI = getWorkspaceFolderURI(f)
            if (!workspaceFolderURI) {
                return;
            }
            populateDiagnostics(workspaceFolderURI)
        }),
        pkgWatcher.onDidDelete((f) => {
            diagnostics.delete(f)
        })
    );
    if (workspace.workspaceFolders) {
        for (const workFolder of workspace.workspaceFolders) {
            populateDiagnostics(workFolder.uri)
        }
    }
    context.subscriptions.push(
        reports.onReport(null, async (evt) => {
            populateDiagnostics(evt.uri)
        }),
        socketConfig.onConfig(null, async (evt) => {
            populateDiagnostics(evt.uri)
        }),
        config.onDependentConfig([
            `${EXTENSION_PREFIX}.showAllIssueTypes`,
            `${EXTENSION_PREFIX}.minIssueLevel`
        ], () => {
            if (workspace.workspaceFolders) {
                for (const folder of workspace.workspaceFolders) {
                    populateDiagnostics(folder.uri)
                }
            }
        })
    )
    function normalizeReportAndLocations(report: SocketReport, pkg: jsonToAST.ValueNode) {
        if (pkg.type !== 'Object') {
            return [];
        }
        let depSources: Array<jsonToAST.ObjectNode> = [];
        for (const pkgField of pkg.children) {
            if ([
                'dependencies',
                'devDependencies'
            ].includes(pkgField.key.value)) {
                if (pkgField.value.type === 'Object') {
                    depSources.push(pkgField.value)
                }
            }
        }
        if (depSources.length === 0) {
            return [];
        }
        function findSource(name: string): jsonToAST.PropertyNode | null {
            for (const source of depSources) {
                for (const dep of source.children) {
                    if (dep.key.value === name) return dep
                }
            }
            return null
        }
        type IssuesBySource = Map<string, IssuesBySeverity>
        type IssuesBySeverity = Map<string, IssuesByType>
        type IssuesByType = Map<string, IssueDescriptions>
        type IssueDescriptions = Set<string>
        let issuesForSource : IssuesBySource = new Map()
        let sourceLocations = new Map<string, jsonToAST.Location>()
        for (const issue of report.issues) {
            const type = issue.type
            const description = issue.value.description
            const severity = issue.value.severity
            for (const issueLoc of issue.value.locations) {
                if (issueLoc.type === 'npm') {
                    const depSource = issueLoc.value.package
                    const inPkg = findSource(depSource)
                    if (inPkg?.loc) {
                        const existingIssuesBySeverity = issuesForSource.get(depSource) ?? new Map()
                        issuesForSource.set(depSource, existingIssuesBySeverity)
                        const existingIssuesByType = existingIssuesBySeverity.get(severity) ?? new Map()
                        existingIssuesBySeverity.set(severity, existingIssuesByType)
                        const existingIssuesByDescription = existingIssuesByType.get(type) ?? new Set()
                        existingIssuesByType.set(type, existingIssuesByDescription)
                        existingIssuesByDescription.add(description);
                        sourceLocations.set(depSource, inPkg.loc)
                    }
                }
            }
        }
        let issueLocations = []
        for (const [depSource, loc] of sourceLocations) {
            let existingIssuesBySeverity = issuesForSource.get(depSource)
            if (!existingIssuesBySeverity) continue
            for (const [severity, existingIssuesByType] of existingIssuesBySeverity) {
                for (const type of [...existingIssuesByType.keys()].sort()) {
                    const existingIssuesByDescription = existingIssuesByType.get(type);
                    if (existingIssuesByDescription) {
                        for (const description of existingIssuesByDescription) {
                            issueLocations.push({
                                type,
                                description,
                                severity,
                                loc
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
        if (effectiveData.defaulted) {
            return
        }
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

            const pkgJsonAST = jsonToAST(packageJSONSource, {
                loc: true
            });
            // TODO: report history
            // const historyKey = `report.history.${textDocumentURI.fsPath}`;
            // type ReportHistoryEntry = {
            //     firstTimeShown: number,
            //     firstDependentVersionShownAt: string
            // }
            // const reportHistory: Record<string, ReportHistoryEntry> = context.workspaceState.get(historyKey) ?? Object.create(null)
            // const shownTime = Date.now()
            // for (const issue of currentReport.issues) {
            //     if (!reportHistory[issue.type]) {
            //         reportHistory[issue.type] = {
            //             firstTimeShown: shownTime,
            //             firstDependentVersionShownAt: pkgJsonAST.type === 'Object' ? pkgJsonAST.children.
            //         }
            //     }
            // }
            // context.workspaceState.update(historyKey, reportHistory)
            const relevantIssues = normalizeReportAndLocations(currentReport, pkgJsonAST)?.sort(sortIssues)
            if (relevantIssues && relevantIssues.length) {
                const diagnosticsToShow = (await Promise.all(relevantIssues.map(
                    async (issue) => {
                        const should = shouldShowIssue(issue.type, issue.severity, socketYamlConfig)
                        if (!should) {
                            return null
                        }
                        const td = Buffer.from(
                            await workspace.fs.readFile(textDocumentURI)
                        ).toString()
                        let lineStartPattern = /^|(?:\r?\n)/g
                        const lines = td.matchAll(lineStartPattern);
                        let line = -1
                        let lastLineOffset = 0
                        let startPos
                        let endPos
                        for (const match of lines) {
                            line++
                            if (match.index == undefined) {
                                continue
                            }
                            let startOfLineOffset = match.index + match[0].length
                            if (!startPos && startOfLineOffset >= issue.loc.start.offset) {
                                startPos = new vscode.Position(line - 1, issue.loc.start.offset - lastLineOffset)
                            }
                            if (!endPos && startOfLineOffset >= issue.loc.end.offset) {
                                endPos = new vscode.Position(line - 1, issue.loc.end.offset - lastLineOffset)
                            }
                            lastLineOffset = startOfLineOffset
                        }
                        if (!startPos) {
                            startPos = new vscode.Position(line - 1, issue.loc.start.offset - lastLineOffset)
                        }
                        if (!endPos) {
                            endPos = new vscode.Position(line - 1, issue.loc.end.offset - lastLineOffset)
                        }
                        const range = new vscode.Range(startPos, endPos)
                        const diag = new vscode.Diagnostic(
                            range,
                            issue.description, 
                            issue.severity === 'low' ?
                                vscode.DiagnosticSeverity.Information :
                                issue.severity !== 'critical' ?
                                    vscode.DiagnosticSeverity.Warning :
                                    vscode.DiagnosticSeverity.Error
                        )
                        diag.source = DIAGNOSTIC_SOURCE_STR
                        diag.code = issue.type
                        return diag
                    }
                ))).filter(x => !!x) as vscode.Diagnostic[]
                diagnostics.set(textDocumentURI, diagnosticsToShow)
            }
        }
    }

    context.subscriptions.push(
        languages.registerCodeLensProvider({
            language: 'json',
            pattern: '**/package.json',
            scheme: undefined
        }, {
            provideCodeLenses: pkgJSONProvideCodeLenses
        }),
        languages.registerCodeActionsProvider({
            scheme: undefined,
            language: 'json',
            pattern: '**/package.json'
        }, {
            provideCodeActions: pkgJSONProvideCodeActions
        }, {
            providedCodeActionKinds: [vscode.CodeActionKind.QuickFix]
        })
    )
}
