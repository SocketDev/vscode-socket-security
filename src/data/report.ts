import * as vscode from "vscode";
import { once } from 'node:events';
import { FormData, File } from 'formdata-node';
import { FormDataEncoder } from 'form-data-encoder';
import type { IncomingMessage } from 'node:http';
import * as https from 'node:https';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { text } from 'node:stream/consumers';
import { setTimeout } from 'node:timers/promises';
import { EXTENSION_PREFIX, addDisposablesTo, getWorkspaceFolderURI, WorkspaceData } from '../util';
import * as stableStringify from 'safe-stable-stringify';
import watchers from '../fs-watchers'

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

    addDisposablesTo(
        disposables,
        watchers["package.json"].watch({
            onDidChange(uri) {
                runReport(uri)
            },
            onDidCreate(uri) {
                runReport(uri)
            },
            onDidDelete(uri) {
                knownPkgFiles.delete(uri.fsPath)
                runReport(uri);
            }
        })
    );

    type PackageRootCacheKey = string & { _tag: 'PackageRootCacheKey' }
    function pkgJSONSrcToCacheKey(src: Buffer): PackageRootCacheKey {
        const {
            dependencies,
            devDependencies,
            peerDependencies,
            bundledDependencies,
            optionalDependencies
        } = JSON.parse(src.toString());
        return (stableStringify.stringify({
            dependencies,
            devDependencies,
            peerDependencies,
            bundledDependencies,
            optionalDependencies
        }) ?? '' ) as PackageRootCacheKey;
    }
    function hashCacheKey(src: Buffer): PackageRootCacheKey {
        return createHash('md5').update(src).digest('hex') as PackageRootCacheKey;
    }

    const knownPkgFiles: Map<string, {
        cacheKey: PackageRootCacheKey,
    }> = new Map()

    // TODO: get these patterns from API
    const globPatterns = {
        general: {
            readme: {
                pattern: '*readme*'
            },
            notice: {
                pattern: '*notice*'
            },
            license: {
                pattern: '{licen{s,c}e{,-*},copying}'
            }
        },
        npm: {
            packagejson: {
                pattern: 'package.json'
            },
            packagelockjson: {
                pattern: 'package-lock.json'
            },
            npmshrinkwrap: {
                pattern: 'npm-shrinkwrap.json'
            },
            yarnlock: {
                pattern: 'yarn.lock'
            },
            pnpmlock: {
                pattern: 'pnpm-lock.yaml'
            },
            pnpmworkspace: {
                pattern: 'pnpm-workspace.yaml'
            }
        },
        pypi: {
            pipfile: {
                pattern: 'pipfile'
            },
            pyproject: {
                pattern: 'pyproject.toml'
            },
            requirements: {
                pattern:
                    '{*requirements.txt,requirements/*.txt,requirements-*.txt,requirements.frozen}'
            },
            setuppy: {
                pattern: 'setup.py'
            }
        }
    } as const

    async function findWorkspaceFiles(pattern: string, getCacheKey: (src: Buffer, path: string) => PackageRootCacheKey | null) {
        const uris = await workspace.findFiles(pattern, '**/{node_modules,.git}/**');

        return Promise.all(uris.map(async uri => {
            const raw = await workspace.fs.readFile(uri)
            const body = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength)
            let cacheKey: PackageRootCacheKey | null = null;
            try {
                cacheKey = getCacheKey(body, uri.fsPath)
            } catch (e) {
                // failed to load - empty cacheKey
            }
            return {
                uri,
                body,
                cacheKey
            }
        }))
    }

    function uriParent(uri: vscode.Uri) {
        return vscode.Uri.joinPath(uri, '..').fsPath;
    }

    async function runReport(uri: vscode.Uri, force: boolean = false) {
        if (!force) {
            if (!vscode.workspace.getConfiguration(EXTENSION_PREFIX).get('reportsEnabled')) {
                return
            }
        }
        if (!apiKey) {
            return
        }
        const workspaceFolderURI = getWorkspaceFolderURI(uri)
        if (!workspaceFolderURI) {
            return
        }

        const [
            pkgJSONFiles,
            ...allPyFiles
        ] = await Promise.all([
            findWorkspaceFiles('**/package.json', pkgJSONSrcToCacheKey),
            ...Object.values(globPatterns.pypi).map(p =>
                // TODO: better python cache key generation
                findWorkspaceFiles(`**/${p.pattern}`, hashCacheKey)
            )
        ])

        const pkgJSONParents = new Set(pkgJSONFiles.map(file => uriParent(file.uri)))
        const npmLockFilePatterns = Object.keys(globPatterns.npm)
            .filter(name => name !== 'packagejson')
            .map(name => globPatterns.npm[name as keyof typeof globPatterns.npm])

        const npmLockFiles = (await Promise.all(
            npmLockFilePatterns.map(p => findWorkspaceFiles(`**/${p.pattern}`, hashCacheKey))
        )).flat().filter(file => pkgJSONParents.has(uriParent(file.uri)))

        const files = [...pkgJSONFiles, ...npmLockFiles, ...allPyFiles.flat()]

        let needRun = false
        for (const file of files) {
            if (file.cacheKey === null) continue;
            let existing = knownPkgFiles.get(file.uri.fsPath)
            if (!existing) {
                needRun = true
                existing = { cacheKey: file.cacheKey }
                knownPkgFiles.set(file.uri.fsPath, existing)
            }
            if (existing.cacheKey !== file.cacheKey) {
                needRun = true
            }
        }
        if (!force && !needRun) return

        let id: string;

        try {
            showStatus('Creating Socket Report...')
            const form = new FormData();
            for (const file of files) {
                const filepath = workspace.asRelativePath(file.uri)
                const fileObj = new File([file.body], filepath)
                form.set(filepath, fileObj);
            }
            const reportBody = new FormDataEncoder(form);

            const req = https.request(`https://api.socket.dev/v0/report/upload`, {
                method: 'PUT',
                headers: {
                    ...reportBody.headers,
                    'Authorization': authorizationHeaderValue,
                }
            });
            Readable.from(reportBody).pipe(req);
    
            const [res] = (await once(req, 'response')) as [IncomingMessage]
            const result = JSON.parse(await text(res));
            if (res.statusCode != 200) {
                throw new Error(result.error!.message)
            }
            id = result.id;
        } catch (e) {
            showErrorStatus(e);
            throw e;
        }

        try {
            showStatus('Running Socket Report...')
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
    context.subscriptions.push(
        vscode.commands.registerCommand(`${EXTENSION_PREFIX}.runReport`, () => {
            if (vscode.workspace.getConfiguration(EXTENSION_PREFIX).get('reportsEnabled')) {
                if (vscode.workspace.workspaceFolders) {
                    for (const folder of vscode.workspace.workspaceFolders) {
                        runReport(folder.uri, true);
                    }
                }
            } else {
                const enableGloballyOption = "Enable globally & retry";
                const enableWorkspaceOption = "Enable in workspace & retry";
                vscode.window.showErrorMessage("Socket Security reports are disabled", enableGloballyOption, enableWorkspaceOption).then((choice) => {
                    if (choice) {
                        vscode.workspace.getConfiguration().update(
                            `${EXTENSION_PREFIX}.reportsEnabled`,
                            true,
                            choice === enableGloballyOption ?
                                true :
                                undefined
                        ).then(
                            () => {
                                vscode.commands.executeCommand(`${EXTENSION_PREFIX}.runReport`);
                            }
                        )
                    }
                });
            }
        })
    )
    return api
}