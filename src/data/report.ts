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
import watch, { SharedFilesystemWatcherHandler } from '../fs-watch'
import { GlobPatterns, getGlobPatterns } from './glob-patterns';
import { getStaticTOMLValue, parseTOML } from 'toml-eslint-parser';
import * as socketAPIConfig from './socket-api-config'
import { GoModuleVersion, parseGoMod } from "./go/mod-parser";

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

type IssueEco = string
type IssueSource = string
type IssueSeverity = string
type IssueType = string
type IssueDescription = string
type IssueRadixTrie = Map<
    IssueEco, Map<
        IssueSource, Map<
            IssueSeverity,  Map<
                IssueType, Set<IssueDescription>
            >
        >
    >
>
export function radixMergeReportIssues(report: SocketReport): IssueRadixTrie {
    let issuesForEco: IssueRadixTrie = new Map()
    for (const issue of report.issues) {
        const type = issue.type
        const description = issue.value.description
        const severity = issue.value.severity
        for (const issueLoc of issue.value.locations) {
            const depEco = issueLoc.type;
            const existingIssuesByEco = issuesForEco.get(depEco) ?? new Map()
            issuesForEco.set(depEco, existingIssuesByEco)
            const depSource = issueLoc.value.package
            const existingIssuesBySeverity = existingIssuesByEco.get(depSource) ?? new Map()
            existingIssuesByEco.set(depSource, existingIssuesBySeverity)
            const existingIssuesByType = existingIssuesBySeverity.get(severity) ?? new Map()
            existingIssuesBySeverity.set(severity, existingIssuesByType)
            const existingIssuesByDescription = existingIssuesByType.get(type) ?? new Set()
            existingIssuesByType.set(type, existingIssuesByDescription)
            existingIssuesByDescription.add(description);
        }
    }
    return issuesForEco
}

// type ReportEvent = {uri: string, report: SocketReport}
// type onReportHandler = (evt: ReportEvent) => void
export async function activate(context: vscode.ExtensionContext, disposables?: Array<vscode.Disposable>) {
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

    addDisposablesTo(
        disposables,
        socketAPIConfig.onAPIConfChange(() => reportData.recalculateAll())
    )

    const reportWatcher: SharedFilesystemWatcherHandler = {
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
    };

    const supportedFiles = await getGlobPatterns();

    const watchTargets = [
        ...Object.values(supportedFiles.npm),
        ...Object.values(supportedFiles.pypi),
        ...Object.values(supportedFiles.golang)
    ].map(info => info.pattern);

    addDisposablesTo(
        disposables,
        ...watchTargets.map(p => watch(p, reportWatcher))
    );

    type PackageRootCacheKey = string & { _tag: 'PackageRootCacheKey' }
    function pkgJSONCacheKey(src: Buffer): PackageRootCacheKey {
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
    async function goModCacheKey(src: Buffer): Promise<PackageRootCacheKey> {
        const parsed = await parseGoMod(src.toString())
        if (!parsed) {
            throw new Error('failed to parse go.mod')
        }
        const compareMods = (a: GoModuleVersion, b: GoModuleVersion) =>
            a.Path.localeCompare(b.Path) || a.Version!.localeCompare(b.Version!)
        const required = parsed.Require?.map(req => req.Mod).sort(compareMods)
        const replaced = parsed.Replace?.map(repl => ({ New: repl.New, Old: repl.Old }))
            .sort((a, b) => compareMods(a.New, b.New) || compareMods(a.Old, b.Old))
        const excluded = parsed.Exclude?.map(excl => excl.Mod).sort(compareMods)

        return (stableStringify.stringify({
            required,
            replaced,
            excluded
        }) ?? '') as PackageRootCacheKey
    }
    function pipfileCacheKey(src: Buffer): PackageRootCacheKey {
        const value = getStaticTOMLValue(parseTOML(src.toString())) as {
            packages: Record<string, unknown>,
            'dev-packages': Record<string, unknown>
        };
        return (stableStringify.stringify({
            packages: value.packages,
            devPackages: value['dev-packages']
        }) ?? '') as PackageRootCacheKey;
    }
    function pyprojectCacheKey(src: Buffer): PackageRootCacheKey {
        const value = getStaticTOMLValue(parseTOML(src.toString())) as {
            project?: {
                dependencies?: string[],
                'optional-dependencies': string[]
            };
            tool?: {
                poetry?: {
                    dependencies?: Record<string, unknown>,
                    'dev-dependencies'?: Record<string, unknown>,
                    group?: Record<string, {
                        dependencies?: Record<string, unknown>
                    }>
                }
            }
        };
        return (stableStringify.stringify({
            dependencies: value.project?.dependencies,
            optionalDependencies: value.project?.["optional-dependencies"],
            poetryDependencies: value.tool?.poetry?.dependencies,
            poetryDevDependencies: value.tool?.poetry?.['dev-dependencies'],
            poetryGroupDependencies: Object.values(
                value.tool?.poetry?.group || {}
            ).map(group => group?.dependencies)
        }) ?? '') as PackageRootCacheKey;
    }
    function requirementsCacheKey(src: Buffer): PackageRootCacheKey {
        const value = src.toString()
            .split('\n')
            .map(line => line.replace(/(\s|^)#.*/, ''))
            .filter(line => line);
        return value.sort().join('\n') as PackageRootCacheKey;
    }
    function hashCacheKey(src: Buffer): PackageRootCacheKey {
        return createHash('sha256').update(src).digest('hex') as PackageRootCacheKey;
    }

    const knownPkgFiles: Map<string, {
        cacheKey: PackageRootCacheKey,
    }> = new Map()

    type Awaitable<T> = T | { then (onfulfilled: (result: T) => unknown): unknown }

    async function findWorkspaceFiles(pattern: string, getCacheKey: (src: Buffer, path: string) => Awaitable<PackageRootCacheKey | null>) {
        const uris = await workspace.findFiles(pattern, '**/{node_modules,.git}/**');

        return Promise.all(uris.map(async uri => {
            const raw = await workspace.fs.readFile(uri)
            const body = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength)
            let cacheKey: PackageRootCacheKey | null = null;
            try {
                cacheKey = await getCacheKey(body, uri.fsPath)
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

    let warnedLogin = false

    async function runReport(uri: vscode.Uri, force: boolean = false) {
        if (!force) {
            if (!vscode.workspace.getConfiguration(EXTENSION_PREFIX).get('reportsEnabled')) {
                return
            }
            const result = await socketAPIConfig.getExistingAPIConfig()
            if (!result) {
                if (!warnedLogin) {
                    warnedLogin = true
                    const realLogin = 'Log in'
                    const publicLogin = 'Use public token'
                    const res = await vscode.window.showErrorMessage(
                        'Please log into Socket or use the free, public demo to run reports on your dependency tree.',
                        realLogin,
                        publicLogin
                    )
                    if (res === publicLogin) {
                        await socketAPIConfig.usePublicConfig(true)
                    } else if (res === realLogin) {
                        await socketAPIConfig.getAPIConfig(true)
                    }
                }

                if (!(await socketAPIConfig.getExistingAPIConfig())) {
                    return
                }
            }
        }
        const apiConfig = await socketAPIConfig.getAPIConfig()
        if (!apiConfig) {
            return
        }
        const authorizationHeaderValue = socketAPIConfig.toAuthHeader(apiConfig.apiKey)
        const workspaceFolderURI = getWorkspaceFolderURI(uri)
        if (!workspaceFolderURI) {
            return
        }

        let globPatterns: GlobPatterns
        try {
            globPatterns = await getGlobPatterns()
        } catch (e) {
            showErrorStatus(e);
            throw e;
        }

        const dynamicPyFiles = Object.keys(globPatterns.pypi)
            .filter(name => !['pipfile', 'pyproject', 'requirements'].includes(name))
            .map(name => globPatterns.pypi[name]);

        const [
            pkgJSONFiles,
            goModFiles,
            ...allPyFiles
        ] = await Promise.all([
            findWorkspaceFiles(`**/${globPatterns.npm.packagejson.pattern}`, pkgJSONCacheKey),
            findWorkspaceFiles(`**/${globPatterns.golang.gomod.pattern}`, goModCacheKey),
            findWorkspaceFiles(`**/${globPatterns.pypi.pipfile.pattern}`, pipfileCacheKey),
            findWorkspaceFiles(`**/${globPatterns.pypi.pyproject.pattern}`, pyprojectCacheKey),
            findWorkspaceFiles(`**/${globPatterns.pypi.requirements.pattern}`, requirementsCacheKey),
            ...dynamicPyFiles.map(p =>
                findWorkspaceFiles(`**/${p.pattern}`, hashCacheKey)
            )
        ])

        const pkgJSONParents = new Set(pkgJSONFiles.map(file => uriParent(file.uri)))
        const npmLockFilePatterns = Object.keys(globPatterns.npm)
            .filter(name => name !== 'packagejson')
            .map(name => globPatterns.npm[name])

        const npmLockFiles = (await Promise.all(
            npmLockFilePatterns.map(p => findWorkspaceFiles(`**/${p.pattern}`, hashCacheKey))
        )).flat().filter(file => pkgJSONParents.has(uriParent(file.uri)))

        const goModParents = new Set(goModFiles.map(file => uriParent(file.uri)))
        const goExtraFilePatterns = Object.keys(globPatterns.golang)
            .filter(name => name !== 'gomod')
            .map(name => globPatterns.golang[name])

        const goExtraFiles = (await Promise.all(
            goExtraFilePatterns.map(p => findWorkspaceFiles(`**/${p.pattern}`, hashCacheKey))
        )).flat().filter(file => goModParents.has(uriParent(file.uri)))

        const files = [
            ...pkgJSONFiles, ...npmLockFiles,
            ...goModFiles, ...goExtraFiles,
            ...allPyFiles.flat()
        ]

        let needRun = false
        for (const file of files) {
            if (file.cacheKey === null) continue
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
            if (res.statusCode !== 200) {
                throw new Error(result.error.message)
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
    reportData.recalculateAll()
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