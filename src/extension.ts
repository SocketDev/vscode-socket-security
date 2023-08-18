// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below

import * as vscode from 'vscode';
import { ExtensionContext, workspace } from 'vscode';
import * as socketYaml from './data/socket-yaml'
import * as socketAPIConfig from './data/socket-api-config'
import * as pkgJSON from './ui/package-json';
import * as goMod from './ui/go-mod'
import * as pyproject from './ui/pyproject';
import * as pipfile from './ui/pipfile';
import * as requirements from './ui/requirements';
import * as report from './data/report'
import { radixMergeReportIssues, SocketReport } from './data/report';
import { EXTENSION_PREFIX, DIAGNOSTIC_SOURCE_STR, getWorkspaceFolderURI, getDiagnosticSeverity, sortIssues } from './util';
import * as editorConfig from './data/editor-config';
import { installGithubApp, sniffForGithubOrgOrUser } from './data/github';
import * as files from './ui/file'
import { parseExternals } from './ui/parse-externals';
import watch, { SharedFilesystemWatcherHandler } from './fs-watch';
import { initPython, onMSPythonInterpreterChange } from './data/python/interpreter';
import { initGo } from './data/go/executable';
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
    socketAPIConfig.init(context.subscriptions)
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

    const watchTargets = {
        npm: ['packagejson'],
        pypi: ['pipfile', 'requirements', 'pyproject'],
        go: ['gomod', 'gosum']
    }

    const watchTargetValues = Object.entries(watchTargets).flatMap(([eco, names]) => names.map(name => ({
        eco,
        ...supportedFiles[eco][name]
    })));

    context.subscriptions.push(
        diagnostics,
        await initPython(),
        await initGo(),
        ...watchTargetValues.map(target => watch(target.pattern, watchHandler))
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
            `${EXTENSION_PREFIX}.minIssueLevel`,
            `${EXTENSION_PREFIX}.pythonInterpreter`,
            `${EXTENSION_PREFIX}.goExecutable`
        ], runAll),
        onMSPythonInterpreterChange(() => {
            if (!vscode.workspace.getConfiguration(EXTENSION_PREFIX).get('pythonInterpreter')) {
                runAll();
            }
        })
    )
    async function normalizeReportAndLocations(report: SocketReport, doc: Parameters<typeof parseExternals>[0], eco: string) {
        const externals = await parseExternals(doc)
        if (!externals) return
        const issuesForSource = radixMergeReportIssues(report).get(eco)
        if (!issuesForSource) return
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
        const issueLocations: Array<{
            pkgName: string
            type: string
            description: string
            severity: string
            range: vscode.Range
            related: vscode.Range[]
        }> = []
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
        const files = (await Promise.all(watchTargetValues.map(async tgt => ({
            eco: tgt.eco,
            files: (await workspace.findFiles(`**/${tgt.pattern}`, '**/{node_modules,.git}/**'))
                .filter(uri => getWorkspaceFolderURI(uri) === workspaceFolderURI)
        })))).filter(tgt => tgt.files.length);
        if (files.length === 0) {
            return
        }
        const apiConf = await socketAPIConfig.getExistingAPIConfig()
        if (!apiConf) {
            return null
        }
        const githubOrg = await sniffForGithubOrgOrUser(workspaceFolderURI)
        const baseRules = apiConf.orgRules.find(org => org.name === githubOrg)?.issueRules || apiConf.defaultRules
        for (const tgt of files) {
            for (const textDocumentURI of tgt.files) {
                const src = Buffer.from(await workspace.fs.readFile(textDocumentURI)).toString()
                const relevantIssues = (await normalizeReportAndLocations(currentReport, {
                    getText() {
                        return src
                    },
                    fileName: textDocumentURI.fsPath,
                    languageId: textDocumentURI.fsPath.endsWith('.json')
                        ? 'json'
                        : textDocumentURI.fsPath.endsWith('.toml')
                            ? 'toml'
                            : 'plaintext'
                }, tgt.eco))?.sort(sortIssues)
                if (relevantIssues && relevantIssues.length) {
                    const diagnosticsToShow = (await Promise.all(relevantIssues.map(
                        async (issue) => {
                            const severity = getDiagnosticSeverity(issue.type, issue.severity, apiConf.enforcedRules, baseRules, socketYamlConfig)
                            if (severity == null) return null
                            const diag = new vscode.Diagnostic(
                                issue.range,
                                issue.description, 
                                severity
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
        
    }

    const pkgActionsHandlers = await Promise.all([
        pkgJSON.registerCodeLensProvider(),
        pkgJSON.registerCodeActionsProvider(),
        goMod.registerCodeLensProvider(),
        goMod.registerCodeActionsProvider(),
        pyproject.registerCodeLensProvider(),
        pyproject.registerCodeActionsProvider(),
        pipfile.registerCodeActionsProvider(),
        requirements.registerCodeActionsProvider()
    ])

    context.subscriptions.push(...pkgActionsHandlers)
}
