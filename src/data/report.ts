import * as vscode from "vscode";
import child_process from 'node:child_process';
import { once } from 'node:events';
import type { IncomingMessage } from "node:http";
import * as https from 'node:https';
import { text } from 'node:stream/consumers';
import { setTimeout } from 'node:timers/promises';
import { EXTENSION_PREFIX, addDisposablesTo, getWorkspaceFolderURI, WorkspaceData } from "../util";
import * as stableStringify from 'safe-stable-stringify';

export type SocketReport = {
    issues: Array<{
        type: string,
        value: {
            severity: string,
            description: string,
            locations: Array<{type: string, value: any}>
        }
    }>
};

type IssueSource = string
type IssueSeverity = string
type IssueType = string
type IssueDescription = string
type IssueRadixTrie = Map<
    IssueSource, Map<
        IssueSeverity,  Map<
            IssueType, Set<IssueDescription>
        >
    >
>
export function radixMergeReportIssues(report: SocketReport): IssueRadixTrie {
    let issuesForSource: IssueRadixTrie = new Map()
    for (const issue of report.issues) {
        const type = issue.type
        const description = issue.value.description
        const severity = issue.value.severity
        for (const issueLoc of issue.value.locations) {
            if (issueLoc.type === 'npm') {
                const depSource = issueLoc.value.package
                const existingIssuesBySeverity = issuesForSource.get(depSource) ?? new Map()
                issuesForSource.set(depSource, existingIssuesBySeverity)
                const existingIssuesByType = existingIssuesBySeverity.get(severity) ?? new Map()
                existingIssuesBySeverity.set(severity, existingIssuesByType)
                const existingIssuesByDescription = existingIssuesByType.get(type) ?? new Set()
                existingIssuesByType.set(type, existingIssuesByDescription)
                existingIssuesByDescription.add(description);
            }
        }
    }
    return issuesForSource
}

// type ReportEvent = {uri: string, report: SocketReport}
// type onReportHandler = (evt: ReportEvent) => void
export function activate(context: vscode.ExtensionContext, disposables?: Array<vscode.Disposable>) {
    const status = vscode.window.createStatusBarItem(`${EXTENSION_PREFIX}.report`, vscode.StatusBarAlignment.Right)
    status.name = 'Socket Security'
    status.hide();
    function showErrorStatus(error: unknown) {
        status.color = new vscode.ThemeColor('statusBarItem.errorForeground');
        status.text = 'Socket Report Error';
        if (error && typeof error === 'object' && 'message' in error) {
            status.tooltip = String(error?.message)
        } else {
            status.tooltip = error == undefined ? undefined : String(error)
        }
        status.text = String(status.tooltip)
        console.error('ERROR in Reporting', status.tooltip)
        status.show();
    }
    function showStatus(text: string, tooltip?: string) {
        status.color = new vscode.ThemeColor('statusBarItem.foreground');
        status.text = text;
        status.tooltip = tooltip;
        status.show();
    }
    const { workspace } = vscode

    const editorConfig = workspace.getConfiguration(EXTENSION_PREFIX)
    let apiKey: string | undefined
    let authorizationHeaderValue: string = ''
    function syncWorkspaceConfiguration() {
        // early adopter release given big quota
        // hidden settings for testing
        apiKey = editorConfig.get('socketSecurityAPIKey') ?? 'sktsec_t_--RAN5U4ivauy4w37-6aoKyYPDt5ZbaT5JBVMqiwKo_api'
        if (typeof apiKey !== 'string' || !apiKey) {
            apiKey = process.env.SOCKET_SECURITY_API_KEY
        }
        if (apiKey) {
            authorizationHeaderValue = `Basic ${Buffer.from(`${apiKey}:`).toString('base64url')}`
        }
        reportData.recalculateAll()
    }
    workspace.onDidChangeConfiguration((e) => {
        if (
            e.affectsConfiguration(`${EXTENSION_PREFIX}.socketSecurityAPIKey`)
        ) {
            syncWorkspaceConfiguration()
        }
    })


    const watcher = vscode.workspace.createFileSystemWatcher('package{.json}');
    addDisposablesTo(
        disposables,
        watcher,
        watcher.onDidCreate((uri) => {
            runReport(uri);
        }, null, disposables),
        watcher.onDidChange((uri) => {
            runReport(uri);
        }, null, disposables),
        watcher.onDidDelete((uri) => {
            knownPkgFiles.delete(uri.fsPath)
            runReport(uri);
        }, null, disposables)
    );

    type PackageJSONStableString = string & { _tag: 'PackageJSONStableString' }
    function pkgJSONSrcToStableStringKey(str: string): PackageJSONStableString {
        const {
            dependencies,
            devDependencies
        } = JSON.parse(str);
        return (stableStringify.stringify({
            dependencies,
            devDependencies
        }) ?? '' ) as PackageJSONStableString;
    }
    const knownPkgFiles: Map<string, {
        cacheKey: PackageJSONStableString,
        src: string,
        ast?: import('json-to-ast').ASTNode
    }> = new Map()
    async function runReport(uri: vscode.Uri, force: boolean = false) {
        if (!apiKey) {
            return
        }
        const workspaceFolderURI = getWorkspaceFolderURI(uri)
        if (!workspaceFolderURI) {
            return
        }
        const files = await workspace.findFiles('**/package{.json}', '**/node_modules/**').then(fileUris => {
            return Promise.all(
                fileUris.map(async (uri) => {
                    return {uri, body: await workspace.fs.readFile(uri)}
                })
            ).then(
                (uriAndBuffers) =>
                    uriAndBuffers.map(
                        ({uri, body}) => {
                            return {
                                fsPath: uri.fsPath,
                                str: Buffer.from(body).toString()
                            }
                        }
                    )
            )
        })
        let needRun = false
        for (const file of files) {
            let existing = knownPkgFiles.get(file.fsPath)
            const cacheKey = pkgJSONSrcToStableStringKey(file.str)
            if (!existing) {
                needRun = true
                existing = {
                    cacheKey,
                    src: file.str
                }
                knownPkgFiles.set(file.fsPath, existing)
            }
            if (existing.cacheKey !== cacheKey) {
                needRun = true
            }
        }
        if (!needRun) return
        showStatus('Running Socket Report...')
        const entryPoint = context.asAbsolutePath('./vendor/lib/node_modules/@socketsecurity/cli/cli.js');
        showStatus('Creating Socket Report...')
        const child = child_process.spawn(
            process.execPath,
            [
                entryPoint,
                'report', 'create', '--json', workspaceFolderURI.fsPath
            ],
            {
                cwd: workspaceFolderURI.fsPath,
                env: {
                    ...process.env,
                    SOCKET_SECURITY_API_KEY: `${apiKey}`
                }
            }
        )
        const stdout = text(child.stdout);
        const stderr = text(child.stdout);
        try {
            const [exitCode] = await once(child, 'exit');
            if (exitCode !== 0) {
                showErrorStatus((await stderr) || 'Failed to run socket reporter child process');
                return;
            }
        } catch (e) {
            showErrorStatus(e)
            throw e;
        }
        try {
            showStatus('Running Socket Report...')
            const { id } = JSON.parse(await stdout)
            const MAX_ATTEMPTS = 10
            let attempts = 0
            while (attempts++ < MAX_ATTEMPTS) {
                const req = https.get(`https://api.socket.dev/v0/report/view/${encodeURIComponent(id)}`, {
                    headers: {
                        'Authorization': authorizationHeaderValue
                    }
                });
                req.end();
                const [res] = (await once(req, 'response')) as [IncomingMessage]
                if (res.statusCode === 200) {
                    const report = JSON.parse(await text(res)) as SocketReport
                    context.workspaceState.update(`${EXTENSION_PREFIX}.lastReport`, report)
                    context.workspaceState.update(`${EXTENSION_PREFIX}.lastReport`, report)
                    reportData.update(workspaceFolderURI, report);
                    status.text = 'Socket Report Done'
                    status.hide()
                    return
                } else {
                    let wait = -1;
                    if (res.statusCode === 429) {
                        const waitUntil = res.headers['retry-after'] ?? '5'
                        if (/^\d+$/.test(waitUntil)) {
                            wait = parseInt(waitUntil, 10) * 1000;
                        } else {
                            let waitUntilTime = Date.parse(waitUntil)
                            wait = waitUntilTime - Date.now();
                        }
                    } else if ([
                        404,
                        403,
                        undefined
                    ].includes(res.statusCode)) {
                        attempts = MAX_ATTEMPTS
                    } else {
                        wait = 5000
                    }
                    if (wait > 0) {
                        await setTimeout(wait)
                    }
                }
            }
            throw new Error('unable to obtain report in timely manner')
        } catch (e) {
            showErrorStatus(e);
            throw e;
        }
    }
    function getDefaultReport(): SocketReport {
        const lastReport = context.workspaceState.get(`${EXTENSION_PREFIX}.lastReport`) as (SocketReport | undefined)
        return lastReport ?? {
            issues: []
        }
    }
    const reportData = new WorkspaceData(
        (uri) => runReport(uri),
        () => getDefaultReport()
    )
    syncWorkspaceConfiguration()
    const api = {
        effectiveReportForUri: (uri: vscode.Uri) => reportData.get(uri),
        onReport(...params: Parameters<typeof reportData.on>) {
            return reportData.on(...params)
        }
    } as const
    return api
}