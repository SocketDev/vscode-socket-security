import * as vscode from "vscode";
import child_process from 'node:child_process';
import { once } from 'node:events';
import * as https from 'node:https';
import { text } from 'node:stream/consumers';
import { setTimeout } from 'node:timers/promises';
import { EXTENSION_PREFIX, addDisposablesTo, getWorkspaceFolderURI, WorkspaceData } from "../util";
import * as stableStringify from 'safe-stable-stringify';
import watchers from '../fs-watchers';
export function radixMergeReportIssues(report) {
    let issuesForSource = new Map();
    for (const issue of report.issues) {
        const type = issue.type;
        const description = issue.value.description;
        const severity = issue.value.severity;
        for (const issueLoc of issue.value.locations) {
            if (issueLoc.type === 'npm') {
                const depSource = issueLoc.value.package;
                const existingIssuesBySeverity = issuesForSource.get(depSource) ?? new Map();
                issuesForSource.set(depSource, existingIssuesBySeverity);
                const existingIssuesByType = existingIssuesBySeverity.get(severity) ?? new Map();
                existingIssuesBySeverity.set(severity, existingIssuesByType);
                const existingIssuesByDescription = existingIssuesByType.get(type) ?? new Set();
                existingIssuesByType.set(type, existingIssuesByDescription);
                existingIssuesByDescription.add(description);
            }
        }
    }
    return issuesForSource;
}
// type ReportEvent = {uri: string, report: SocketReport}
// type onReportHandler = (evt: ReportEvent) => void
export async function activate(context, disposables) {
    const status = vscode.window.createStatusBarItem(`${EXTENSION_PREFIX}.report`, vscode.StatusBarAlignment.Right);
    status.name = 'Socket Security';
    status.hide();
    function showErrorStatus(error) {
        status.color = new vscode.ThemeColor('statusBarItem.errorForeground');
        status.text = 'Socket Report Error';
        if (error && typeof error === 'object' && 'message' in error) {
            status.tooltip = String(error?.message);
        }
        else {
            status.tooltip = error == undefined ? undefined : String(error);
        }
        status.text = String(status.tooltip);
        console.error('ERROR in Reporting', status.tooltip);
        status.show();
    }
    function showStatus(text, tooltip) {
        status.color = new vscode.ThemeColor('statusBarItem.foreground');
        status.text = text;
        status.tooltip = tooltip;
        status.show();
    }
    const { workspace } = vscode;
    // const editorConfig = workspace.getConfiguration(EXTENSION_PREFIX)
    async function syncWorkspaceConfiguration() {
        reportData.recalculateAll();
    }
    workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(`${EXTENSION_PREFIX}.socketSecurityAPIKey`)) {
            syncWorkspaceConfiguration();
        }
    });
    addDisposablesTo(disposables, watchers["package.json"].watch({
        onDidChange(uri) {
            runReport(uri);
        },
        onDidCreate(uri) {
            runReport(uri);
        },
        onDidDelete(uri) {
            knownPkgFiles.delete(uri.fsPath);
            runReport(uri);
        }
    }));
    function pkgJSONSrcToStableStringKey(str) {
        const { dependencies, devDependencies, peerDependencies, bundledDependencies, optionalDependencies } = JSON.parse(str);
        return (stableStringify.stringify({
            dependencies,
            devDependencies,
            peerDependencies,
            bundledDependencies,
            optionalDependencies
        }) ?? '');
    }
    const knownPkgFiles = new Map();
    async function runReport(uri, force = false) {
        force = true;
        if (!force) {
            if (!vscode.workspace.getConfiguration(EXTENSION_PREFIX).get('reportsEnabled')) {
                return;
            }
        }
        const workspaceFolderURI = getWorkspaceFolderURI(uri);
        if (!workspaceFolderURI) {
            return;
        }
        const scopes = [];
        let APIToken;
        try {
            const sess = await vscode.authentication.getSession(`${EXTENSION_PREFIX}`, scopes, {
                createIfNone: true
            });
            if (sess) {
                APIToken = sess.accessToken;
            }
        }
        catch (e) {
            // manually cancelled?
        }
        if (!APIToken) {
            return;
        }
        const files = await workspace.findFiles('**/package{-lock,}{.json}', '**/node_modules/**').then(fileUris => {
            return Promise.all(fileUris.map(async (uri) => {
                return { uri, body: await workspace.fs.readFile(uri) };
            })).then((uriAndBuffers) => uriAndBuffers.map(({ uri, body }) => {
                return {
                    fsPath: uri.fsPath,
                    uri,
                    str: Buffer.from(body).toString()
                };
            }));
        });
        if (!force) {
            let needRun = false;
            for (const file of files) {
                let existing = knownPkgFiles.get(file.fsPath);
                let cacheKey;
                try {
                    cacheKey = pkgJSONSrcToStableStringKey(file.str);
                }
                catch {
                    continue;
                }
                if (!existing) {
                    needRun = true;
                    existing = {
                        cacheKey,
                        src: file.str
                    };
                    knownPkgFiles.set(file.fsPath, existing);
                }
                if (existing.cacheKey !== cacheKey) {
                    needRun = true;
                }
            }
            if (!needRun)
                return;
        }
        showStatus('Running Socket Report...');
        const entryPoint = context.asAbsolutePath('./vendor/lib/node_modules/@socketsecurity/cli/cli.js');
        showStatus('Creating Socket Report...');
        const child = child_process.spawn(process.execPath, [
            entryPoint,
            'report', 'create', '--json', ...files.map(file => {
                const joined = vscode.Uri.joinPath(file.uri, '..');
                return joined.fsPath;
            })
        ], {
            cwd: workspaceFolderURI.fsPath,
            env: {
                ...process.env,
                SOCKET_SECURITY_API_KEY: `${APIToken}`
            }
        });
        const stdout = text(child.stdout);
        const stderr = text(child.stderr);
        try {
            const [exitCode] = await once(child, 'exit');
            if (exitCode !== 0) {
                showErrorStatus((await stderr) || `Failed to run socket reporter child process (exit code ${exitCode})`);
                return;
            }
        }
        catch (e) {
            showErrorStatus(e);
            throw e;
        }
        try {
            showStatus('Running Socket Report...');
            const { id } = JSON.parse(await stdout);
            const MAX_ATTEMPTS = 10;
            let attempts = 0;
            while (attempts++ < MAX_ATTEMPTS) {
                const req = https.get(`https://api.socket.dev/v0/report/view/${encodeURIComponent(id)}`, {
                    headers: {
                        'Authorization': `Basic ${Buffer.from(`${APIToken}:`).toString('base64url')}`
                    }
                });
                req.end();
                const [res] = (await once(req, 'response'));
                if (res.statusCode === 200) {
                    const report = JSON.parse(await text(res));
                    context.workspaceState.update(`${EXTENSION_PREFIX}.lastReport`, report);
                    context.workspaceState.update(`${EXTENSION_PREFIX}.lastReport`, report);
                    reportData.update(workspaceFolderURI, report);
                    status.text = 'Socket Report Done';
                    status.hide();
                    return;
                }
                else {
                    let wait = -1;
                    if (res.statusCode === 429) {
                        const waitUntil = res.headers['retry-after'] ?? '5';
                        if (/^\d+$/.test(waitUntil)) {
                            wait = parseInt(waitUntil, 10) * 1000;
                        }
                        else {
                            let waitUntilTime = Date.parse(waitUntil);
                            wait = waitUntilTime - Date.now();
                        }
                    }
                    else if ([
                        404,
                        403,
                        undefined
                    ].includes(res.statusCode)) {
                        attempts = MAX_ATTEMPTS;
                    }
                    else {
                        wait = 5000;
                    }
                    if (wait > 0) {
                        await setTimeout(wait);
                    }
                }
            }
            throw new Error('unable to obtain report in timely manner');
        }
        catch (e) {
            showErrorStatus(e);
            throw e;
        }
    }
    function getDefaultReport() {
        const lastReport = context.workspaceState.get(`${EXTENSION_PREFIX}.lastReport`);
        return lastReport ?? {
            issues: []
        };
    }
    const reportData = new WorkspaceData((uri) => runReport(uri), () => getDefaultReport());
    await syncWorkspaceConfiguration();
    const api = {
        effectiveReportForUri: (uri) => reportData.get(uri),
        onReport(...params) {
            return reportData.on(...params);
        }
    };
    context.subscriptions.push(vscode.commands.registerCommand(`${EXTENSION_PREFIX}.runReport`, () => {
        if (vscode.workspace.getConfiguration(EXTENSION_PREFIX).get('reportsEnabled')) {
            if (vscode.workspace.workspaceFolders) {
                for (const folder of vscode.workspace.workspaceFolders) {
                    runReport(folder.uri, true);
                }
            }
        }
        else {
            const enableGloballyOption = "Enable globally & retry";
            const enableWorkspaceOption = "Enable in workspace & retry";
            vscode.window.showErrorMessage("Socket Security reports are disabled", enableGloballyOption, enableWorkspaceOption).then((choice) => {
                if (choice) {
                    vscode.workspace.getConfiguration().update(`${EXTENSION_PREFIX}.reportsEnabled`, true, choice === enableGloballyOption ?
                        true :
                        undefined).then(() => {
                        vscode.commands.executeCommand(`${EXTENSION_PREFIX}.runReport`);
                    });
                }
            });
        }
    }));
    return api;
}
//# sourceMappingURL=report.js.map