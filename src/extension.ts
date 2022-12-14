// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { ExtensionContext, languages, commands, Disposable, workspace, window } from 'vscode';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { text } from 'node:stream/consumers';
import { setTimeout } from 'node:timers/promises'
import * as https from 'node:https';
import { IncomingMessage } from 'node:http';
import * as yaml from 'yaml'
import jsonToAST from 'json-to-ast'

let disposables: Disposable[] = [];
export function activate(context: ExtensionContext) {
    let rootUri = workspace.workspaceFolders?.[0].uri
    if (!rootUri) return
    const workspaceRootURI = rootUri


    const diagnostics = vscode.languages.createDiagnosticCollection()
    vscode.commands.registerCommand('socket-dev.ignoreIssueType', async (type: string) => {
        const configUri = vscode.Uri.joinPath(workspaceRootURI, 'socket.yml');
        const configSrc = Buffer.from(await workspace.fs.readFile(configUri)).toString()
        const yamlDoc = yaml.parseDocument(configSrc, {
            keepSourceTokens: true
        })
        let issuesNode = yamlDoc.get('issues')
        if (!issuesNode || Array.isArray(issuesNode) || typeof issuesNode !== 'object') {
            yamlDoc.set('issues', new yaml.YAMLMap())
        }
        yamlDoc.setIn(['issues', type], false)
        await workspace.fs.writeFile(configUri, Buffer.from(yamlDoc.toString()))
        populateDiagnostics()
    })

    class ActionProvider implements vscode.CodeActionProvider {
        provideCodeActions(document: vscode.TextDocument, range: vscode.Range | vscode.Selection, context: vscode.CodeActionContext, token: vscode.CancellationToken): vscode.ProviderResult<(vscode.CodeAction | vscode.Command)[]> {
            return context.diagnostics.filter(
                diag => {
                    if (diag.source !== 'Socket Security') return false
                    return true
                }
            ).map(
                diag => {
                    const action = new vscode.CodeAction(`Ignore all ${diag.code} issues`, vscode.CodeActionKind.QuickFix)
                    action.command = {
                        command: 'socket-dev.ignoreIssueType',
                        title: `Ignore all ${diag.code} issues`,
                        arguments: [diag.code]
                    }
                    action.diagnostics = [diag]
                    action.isPreferred = false
                    return action
                }
            )
        }
        resolveCodeAction?(codeAction: vscode.CodeAction, token: vscode.CancellationToken): vscode.ProviderResult<vscode.CodeAction> {
            return 
        }

    }
    languages.registerCodeActionsProvider({
        language: 'json',
        pattern: '**/package.json'
    }, new ActionProvider(), {
        providedCodeActionKinds: [vscode.CodeActionKind.QuickFix]
    })

    type SocketReport = {issues: Array<{type: string, value: {severity: string, description: string, locations: Array<{type: string, value: any}>} }> };
    function showReport(report: SocketReport, pkg: jsonToAST.ValueNode) {
        if (pkg.type !== 'Object') return;
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

    let pendingReport = false;
    async function populateDiagnostics() {
        if (!currentReport) return
        let config: any = null
        try {
            config = yaml.parse(
                Buffer.from(await workspace.fs.readFile(
                    vscode.Uri.joinPath(workspaceRootURI, 'socket.yml')
                )).toString()
            )
        } catch {

        }
        if (config?.enabled === false) {
            diagnostics.clear()
            return
        }
        const report = currentReport
        const textDocumentURI = vscode.Uri.joinPath(workspaceRootURI, 'package.json');
        const packageJSONSource = Buffer.from(await workspace.fs.readFile(textDocumentURI)).toString()
        const issuesToShow = showReport(report, jsonToAST(packageJSONSource, {
            loc: true
        }))
        if (issuesToShow) {
            const td = workspace.textDocuments.find(td => td.uri.toString() === textDocumentURI.toString())
            if (!td) {
                debugger
                return
            }
            diagnostics.set(
                textDocumentURI,
                issuesToShow.flatMap((issue) => {
                    const ignoreByType = config?.issues?.[issue.type] ?? true
                    if (ignoreByType !== true) {
                        return []
                    }
                    // let ignoreByEcosystem = config?.ignorePackageIssuesSimple
                    // if (ignoreByEcosystem) {
                    //     for (const [key, value] of Object.entries(ignoreByEcosystem)) {
                    //         if (key) {

                    //         }
                    //     }
                    // }
                    const range = new vscode.Range(
                        td.positionAt(issue.loc.start.offset),
                        td.positionAt(issue.loc.end.offset)
                    )
                    const diag = new vscode.Diagnostic(
                        range,
                        issue.description, 
                        issue.severity === 'low' ?
                            vscode.DiagnosticSeverity.Information :
                            vscode.DiagnosticSeverity.Warning
                    )
                    diag.source = 'Socket Security'
                    diag.code = issue.type
                    return [diag]
                })
            )

        }
    }
    async function runReport() {
        if (pendingReport) return;
        pendingReport = true;
        try {
            const config = workspace.getConfiguration('socket-dev')
            let apiKey = config.get('socketSecurityAPIKey')
            if (typeof apiKey !== 'string' || !apiKey) {
                apiKey = process.env.SOCKET_SECURITY_API_KEY
            }
            if (!apiKey) return
            // window.showInformationMessage(`Saved ${textDocument.uri.fsPath}`);
            if (!workspaceRootURI) return
            const workspaceFSPath = workspaceRootURI.fsPath
            const child = spawn('socket', ['report', 'create', '--json', workspaceFSPath], {
                env: {
                    ...process.env,
                    SOCKET_SECURITY_API_KEY: `${apiKey}`
                }
            });
            const stdout = text(child.stdout);
            const stderr = text(child.stderr);
            const [exitCode] = await once(child, 'exit');
            if (exitCode !== 0) {
                window.showInformationMessage(`STDERR`, await stderr)
                // Shhh, don't be noisy (invalid package.json / currently editing?)
                return;
            }
            const { id } = JSON.parse(await stdout)
            let attempts = 0
            while (attempts++ < 10) {
                await setTimeout(5000);
                const req = https.get(`https://api.socket.dev/v0/report/view/${encodeURIComponent(id)}`, {
                    headers: {
                        'Authorization': `Basic ${Buffer.from(`${apiKey}:`).toString('base64url')}`
                    }
                });
                req.end();
                const [res] = (await once(req, 'response')) as [IncomingMessage]
                if (res.statusCode === 200) {
                    currentReport = JSON.parse(await text(res))
                    context.workspaceState.update('currentReport', currentReport)
                    context.workspaceState.update('reportMtime', Date.now())
                    populateDiagnostics()
                    break
                }
            }
        } catch (e) {
            if (e instanceof Error) {
                window.showInformationMessage(e.message);
            }
        } finally {
            pendingReport = false;
        }
    }
    let currentReport: SocketReport | null = context.workspaceState.get('currentReport') ?? null
    async function startup() {
        // only run a report if we have stale report or are unclear on state
        let needReport = !currentReport
        if (!needReport) {
            try {
                const reportMtime = await context.workspaceState.get('reportMtime')
                if (reportMtime) {
                    const stat = await workspace.fs.stat(
                        vscode.Uri.joinPath(workspaceRootURI, 'package.json')
                    )
                    if (stat.mtime > (reportMtime ?? 0 as number)) {
                        needReport = true
                    }
                }
            } catch {
                needReport = true
            }
        }
        if (needReport) {
            runReport()
        } else {
            populateDiagnostics()
        }
    }
    startup()
    workspace.onDidSaveTextDocument((textDocument) => {
        // only check if update was to package json related file
        if (/([\\\/]|^)package(-lock)?.json$/.test(textDocument.fileName) === true) {
            return runReport()
        } else if (
            vscode.Uri.joinPath(workspaceRootURI, 'socket.yml').toString() === textDocument.uri.toString()
        ) {
            // don't need a new report
            populateDiagnostics()
        }
    })
}

// this method is called when your extension is deactivated
export function deactivate() {
	if (disposables) {
		disposables.forEach(item => item.dispose());
	}
	disposables = [];
}