import type { SocketYml } from '@socketsecurity/config';
import * as toml from 'toml-eslint-parser';
import * as vscode from 'vscode';
import { IssueRules, ruleStrength } from './data/socket-api-config';

export const DIAGNOSTIC_SOURCE_STR = 'SocketSecurity'
export const EXTENSION_PREFIX = 'socket-security'

const SEVERITY_LEVELS = ['low', 'middle', 'high', 'critical'];

export function getDiagnosticSeverity(type: string, severity: string, issueRules: IssueRules, socketYamlConfig: SocketYml): vscode.DiagnosticSeverity | null {
    const fullRules: IssueRules = { ...socketYamlConfig.issueRules }
    for (const rule in issueRules) {
        if (!(rule in fullRules)) fullRules[rule] = issueRules[rule]
    }
    const editorConfig = vscode.workspace.getConfiguration(EXTENSION_PREFIX)
    const handling = ruleStrength(fullRules[type])
    if (handling < 2) return null
    
    const curLevel = SEVERITY_LEVELS.indexOf(severity)
    const minLevel = SEVERITY_LEVELS.indexOf(editorConfig.get('minIssueLevel') as string)
    if (curLevel >= minLevel) {
        // TODO: change behavior?
        return handling === 2
            ? curLevel > 1
                ? vscode.DiagnosticSeverity.Warning
                : vscode.DiagnosticSeverity.Information
            : vscode.DiagnosticSeverity.Error
    }
    return null
}
/**
 * sort by severity, otherwise sort by type lexicographically
 */
export function sortIssues(a: {
    severity: string,
    type: string
}, b: {
    severity: string,
    type: string
}): number {
    if (a.severity !== b.severity) {
        const aSev = SEVERITY_LEVELS.indexOf(a.severity)
        if (aSev === -1) {
            return -1
        }
        const bSev = SEVERITY_LEVELS.indexOf(b.severity)
        if (bSev === -1) {
            return 1
        }
        if (aSev < bSev) {
            return 1
        } else if (aSev > bSev) {
            return -1
        }
    }
    return a.type < b.type ? -1 : a.type === b.type ? 0 : 1
}

export function addDisposablesTo(all?: Array<vscode.Disposable>, ...disposables: Array<vscode.Disposable>): void {
    if (all) {
        all.push(...disposables)
    }
}

export function getWorkspaceFolderURI(from: vscode.Uri) {
    return vscode.workspace.getWorkspaceFolder(from)?.uri
}

type ListenerEventData<Data> =  {uri: vscode.Uri, data: Data, defaulted: boolean}
/**
 * Setup data to be isolated and associated with workspace folders, note: should only be used for data
 * DO NOT SETUP listeners inside the callbacks because things like watchers are global and not per workspace
 */
export class WorkspaceData<Data> {
    workspaceScopeData: Map<string, Data> = new Map();
    listeners: Map<string | null, {
        uri: vscode.Uri | null,
        refCount: number,
        emitter: vscode.EventEmitter<ListenerEventData<Data>>
    }> = new Map();
    getDefault: () => Data
    onWorkspaceFolder

    constructor(onWorkspaceFolder: (uri: vscode.Uri) => void, getDefault: () => Data) {
        this.getDefault = getDefault
        this.onWorkspaceFolder = onWorkspaceFolder
        vscode.workspace.onDidChangeWorkspaceFolders(e => {
            for (const folder of e.removed) {
                this.workspaceScopeData.delete(folder.uri.fsPath)
            }
            for (const folder of e.added) {
                try {
                    this.onWorkspaceFolder(folder.uri)
                } catch (e) {
                    console.error(e);
                }
            }
        })
        this.recalculateAll()
    }

    /**
     * @param from Uri within the workspace to recalculate will be used to din the workspace
     */
    recalculateDataForUri(from: vscode.Uri, clear: boolean = false) {
        const workspaceFolderURI = getWorkspaceFolderURI(from);
        if (!workspaceFolderURI) {
            return;
        }
        if (clear) {
            this.workspaceScopeData.delete(workspaceFolderURI.fsPath);
        }
        this.onWorkspaceFolder(workspaceFolderURI);
    }

    /**
     * Used generally when workspace settings are updated
     * @param clear removes all stale data, do not use generally
     */
    recalculateAll(clear: boolean = false) {
        if (clear) {
            this.workspaceScopeData.clear()
        }
        if (vscode.workspace.workspaceFolders) {
            for (const folder of vscode.workspace.workspaceFolders) {
                try {
                    this.onWorkspaceFolder(folder.uri)
                } catch (e) {
                    console.error(e);
                }
            }
        }
    }

    get(from: vscode.Uri): {
        uri: vscode.Uri,
        data: Data,
        defaulted: boolean,
    } {
        const workspaceFolderURI = getWorkspaceFolderURI(from);
        if (!workspaceFolderURI) {
            return {
                uri: from,
                data: this.getDefault(),
                defaulted: true,
            }
        }
        let data = this.workspaceScopeData.get(workspaceFolderURI.fsPath)
        let defaulted = !data
        return {
            uri: workspaceFolderURI,
            data: data ? data : this.getDefault(),
            defaulted
        }
    }

    update(from: vscode.Uri, value: Data | undefined) {
        const workspaceFolderURI = getWorkspaceFolderURI(from);
        if (!workspaceFolderURI) {
            return
        }
        if (value !== undefined) {
            this.workspaceScopeData.set(workspaceFolderURI.fsPath, value);
        } else {
            this.workspaceScopeData.delete(workspaceFolderURI.fsPath);
        }
        this.fire(workspaceFolderURI)
    }

    fire(uri: vscode.Uri) {
        const workspaceFolderURI = getWorkspaceFolderURI(uri);
        if (!workspaceFolderURI) {
            return
        }
        const data = this.workspaceScopeData.get(workspaceFolderURI.fsPath);
        for (const listenerData of this.listeners.values()) {
            if (listenerData.uri === null || (getWorkspaceFolderURI(listenerData.uri)?.fsPath === workspaceFolderURI.fsPath)) {
                listenerData.emitter.fire({
                    uri: workspaceFolderURI,
                    data: data ? data : this.getDefault(),
                    defaulted: !data
                })
            }
        }
    }

    on(from: vscode.Uri | null, fn: (e: ListenerEventData<Data>) => void): vscode.Disposable {
        const {
            listeners
        } = this;
        let key = from ? from.fsPath : null
        let existing = listeners.get(key) ?? {
            uri: from,
            refCount: 0,
            emitter: new vscode.EventEmitter()
        }
        existing.refCount++;
        let unwatch = existing.emitter.event(fn);
        listeners.set(key, existing);
        return {
            dispose() {
                const existing = listeners.get(key)
                // could be deleted to workspace change
                if (existing) {
                    existing.refCount--
                    if (existing.refCount === 0) {
                        listeners.delete(key)
                    }
                }
                unwatch.dispose()
            }
        }
    }
}

export function traverseTOMLKeys(src: toml.AST.TOMLProgram, cb: (key: toml.AST.TOMLKey, path: (string | number)[]) => unknown) {
    const curPath: (string | number)[] = [];

    toml.traverseNodes(src, {
        enterNode(node) {
            if (node.type === 'TOMLKeyValue') {
                curPath.push(...node.key.keys.map(k => k.type == 'TOMLBare' ? k.name : k.value));
            } else if (node.type === 'TOMLTable') {
                curPath.push(...node.resolvedKey);
            } else if (node.type === 'TOMLKey') {
                cb(node, curPath);
            }
        },
        leaveNode(node) {
            if (node.type === 'TOMLKeyValue') {
                curPath.length -= node.key.keys.length;
            } else if (node.type === 'TOMLTable') {
                curPath.length -= node.resolvedKey.length;
            }
        }
    });
}