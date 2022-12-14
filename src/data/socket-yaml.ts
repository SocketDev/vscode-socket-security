import * as vscode from 'vscode';
import { getDefaultConfig } from '@socketsecurity/config'
import type { SocketYml } from '@socketsecurity/config'
import { parseDocument, YAMLMap } from 'yaml'
import { getWorkspaceFolderURI, addDisposablesTo, WorkspaceData } from '../util'
import fsWatchers from '../fs-watchers';

type EditorSocketYml = SocketYml & {
    enabled: boolean
}

const DEFAULT_SOCKET_YML: Readonly<EditorSocketYml> = {
    enabled: true,
    ...getDefaultConfig()
}


type ConfigForUri = {
    uri: vscode.Uri,
    data: EditorSocketYml,
    defaulted: boolean,
}
type OnConfigCallback = (e: ConfigForUri) => void
type PathToValue = Array<string> | string

type API = {
    effectiveConfigForUri(uri: vscode.Uri): ConfigForUri,
    onConfig(from: vscode.Uri | null, fn: OnConfigCallback): vscode.Disposable,
    update(from: vscode.Uri, ...values: Array<[PathToValue, any]>): Promise<void>
}
export async function activate(context: vscode.ExtensionContext, disposables?: Array<vscode.Disposable>): Promise<API> {
    function getSocketYmlURIAndWorkspaceURI(uri: vscode.Uri): {
            workspaceFolderURI: vscode.Uri,
            socketYmlURI: vscode.Uri
        } | undefined {
        const workspaceFolderURI = getWorkspaceFolderURI(uri)
        if (!workspaceFolderURI) {
            return
        }
        const socketYmlURI = vscode.Uri.joinPath(workspaceFolderURI, 'socket.yml');
        return {
            workspaceFolderURI,
            socketYmlURI
        }
    }
    /**
     * workspacefolder -> config
     */
    const workspaceConfigs = new Map<string, EditorSocketYml>()
    /**
     * Parses the config in a race condition safe way. When done notifies via
     * onConfig() events. When a race to parse is found, likely due to multiple events,
     * cancels first parse.
     * @param uri the uri of a socket.yml
     */
    async function parseAgain(uri: vscode.Uri): Promise<void> {
        const uris = getSocketYmlURIAndWorkspaceURI(uri);
        if (!uris) {
            return;
        }
        try {
            const buf = await vscode.workspace.fs.readFile(uris.socketYmlURI);
            const src = Buffer.from(buf).toString()
            const doc = parseDocument(src).toJSON()
            const def = DEFAULT_SOCKET_YML
            const editorSocketYml: EditorSocketYml = {
                enabled: (doc.enabled ?? true) ? true : false,
                issueRules: {
                    ...def.issueRules,
                    ...doc.issues,
                    ...doc.issueRules
                },
                githubApp: {
                    ...def.githubApp,
                    ...doc.githubApp
                },
                projectIgnorePaths: doc.projectIgnorePaths,
                version: def.version
            }
            socketYamlData.update(uris.socketYmlURI, editorSocketYml)
        } catch (e) {
            if (e && typeof e === 'object' && 'code' in e && e.code === 'FileNotFound') {
                socketYamlData.update(uris.socketYmlURI, undefined)
            }
        }
    }

    const pendingUpdates: Array<{
        socketYmlURI: vscode.Uri,
        values: Array<[Array<string> | string, any]>,
        resolve: () => void,
        reject: (err: unknown) => void
    }> = [];
    let activeUpdate: typeof pendingUpdates[0] | null = null
    async function doSingleUpdate() {
        if (activeUpdate || pendingUpdates.length === 0) {
            return
        }
        activeUpdate = pendingUpdates.shift() ?? null
        if (!activeUpdate) {
            return;
        }
        try {
            const { socketYmlURI } = activeUpdate
            if (!socketYmlURI) {
                activeUpdate.reject(new Error('unable to find socketYmlURI'));
                return;
            }
            // have to recalculate, this could have changed between queue and execution
            const workspaceFolder = vscode.workspace.getWorkspaceFolder(socketYmlURI)
            if (!workspaceFolder) {
                activeUpdate.reject(new Error('unable to find workspaceFolder'));
                return;
            }
            let src: string
            try {
                const buf = await vscode.workspace.fs.readFile(socketYmlURI);
                src = Buffer.from(buf).toString()
            } catch (e) {
                if (e && typeof e === 'object' && 'code' in e && e.code === 'FileNotFound') {
                    workspaceConfigs.delete(workspaceFolder.uri.fsPath)
                    src = ''
                } else {
                    activeUpdate.reject(e)
                    return
                }
            }
            const editableConfig = parseDocument(src, {
                keepSourceTokens: true
            })
            for (let [updatePath, value] of activeUpdate.values) {
                let needle = editableConfig;
                if (typeof updatePath === 'string') {
                    updatePath = [updatePath]
                }
                let i;
                for (i = 0; i < updatePath.length - 1; i++) {
                    const part = updatePath[i]
                    let newNeedle: any
                    let existingNode = needle.get(part)
                    if (!existingNode || Array.isArray(existingNode) || typeof existingNode !== 'object') {
                        newNeedle = new YAMLMap()
                    } else {
                        newNeedle = existingNode
                    }
                    needle.set(part, newNeedle)
                    needle = newNeedle
                }
                needle.set(updatePath[i], value)
            }
            const editedSrc = editableConfig.toString()
            await vscode.workspace.fs.writeFile(socketYmlURI, Buffer.from(editedSrc));
            activeUpdate.resolve()
        } catch (e) {
            activeUpdate.reject(e)
        } finally {
            activeUpdate = null
            if (pendingUpdates.length) {
                doSingleUpdate()
            }
        }
    }
    function update(from: vscode.Uri, ...values: Array<[PathToValue, any]>): Promise<void> {
        const uris = getSocketYmlURIAndWorkspaceURI(from)
        if (!uris) {
            return Promise.reject(new Error('unable to find workspace folder, please open a folder'))
        }
        const promise = new Promise<void>((resolve, reject) => {
            pendingUpdates.push({
                socketYmlURI: uris.socketYmlURI,
                values,
                resolve,
                reject
            })
        })
        doSingleUpdate()
        return promise;
    }

    addDisposablesTo(
        disposables,
        fsWatchers['socket.yml'].watch({
            onDidChange(e) {
                parseAgain(e)
            },
            onDidCreate(e) {
                parseAgain(e)
            },
            onDidDelete(uri) {
                socketYamlData.update(uri, undefined)
            }
        })
    );

    const socketYamlData = new WorkspaceData<EditorSocketYml>((uri: vscode.Uri) => {
        parseAgain(uri)
    }, () => {
        return DEFAULT_SOCKET_YML
    })
    const api: API = {
        effectiveConfigForUri: (uri) => socketYamlData.get(uri),
        onConfig: (...params: Parameters<typeof socketYamlData.on>): vscode.Disposable => {
            return socketYamlData.on(...params)
        },
        update
    } as const
    return api
}