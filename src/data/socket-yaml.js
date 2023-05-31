import * as vscode from 'vscode';
import { getDefaultConfig } from '@socketsecurity/config';
import { parseDocument, YAMLMap } from 'yaml';
import { getWorkspaceFolderURI, addDisposablesTo, WorkspaceData } from '../util';
import fsWatchers from '../fs-watchers';
const DEFAULT_SOCKET_YML = {
    enabled: true,
    ...getDefaultConfig()
};
export async function activate(context, disposables) {
    function getSocketYmlURIAndWorkspaceURI(uri) {
        const workspaceFolderURI = getWorkspaceFolderURI(uri);
        if (!workspaceFolderURI) {
            return;
        }
        const socketYmlURI = vscode.Uri.joinPath(workspaceFolderURI, 'socket.yml');
        return {
            workspaceFolderURI,
            socketYmlURI
        };
    }
    /**
     * workspacefolder -> config
     */
    const workspaceConfigs = new Map();
    /**
     * Parses the config in a race condition safe way. When done notifies via
     * onConfig() events. When a race to parse is found, likely due to multiple events,
     * cancels first parse.
     * @param uri the uri of a socket.yml
     */
    async function parseAgain(uri) {
        const uris = getSocketYmlURIAndWorkspaceURI(uri);
        if (!uris) {
            return;
        }
        try {
            const buf = await vscode.workspace.fs.readFile(uris.socketYmlURI);
            const src = Buffer.from(buf).toString();
            const doc = parseDocument(src).toJSON();
            const def = DEFAULT_SOCKET_YML;
            const editorSocketYml = {
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
            };
            socketYamlData.update(uris.socketYmlURI, editorSocketYml);
        }
        catch (e) {
            if (e && typeof e === 'object' && 'code' in e && e.code === 'FileNotFound') {
                socketYamlData.update(uris.socketYmlURI, undefined);
            }
        }
    }
    const pendingUpdates = [];
    let activeUpdate = null;
    async function doSingleUpdate() {
        if (activeUpdate || pendingUpdates.length === 0) {
            return;
        }
        activeUpdate = pendingUpdates.shift() ?? null;
        if (!activeUpdate) {
            return;
        }
        try {
            const { socketYmlURI } = activeUpdate;
            if (!socketYmlURI) {
                activeUpdate.reject(new Error('unable to find socketYmlURI'));
                return;
            }
            // have to recalculate, this could have changed between queue and execution
            const workspaceFolder = vscode.workspace.getWorkspaceFolder(socketYmlURI);
            if (!workspaceFolder) {
                activeUpdate.reject(new Error('unable to find workspaceFolder'));
                return;
            }
            let src;
            try {
                const buf = await vscode.workspace.fs.readFile(socketYmlURI);
                src = Buffer.from(buf).toString();
            }
            catch (e) {
                if (e && typeof e === 'object' && 'code' in e && e.code === 'FileNotFound') {
                    workspaceConfigs.delete(workspaceFolder.uri.fsPath);
                    src = '';
                }
                else {
                    activeUpdate.reject(e);
                    return;
                }
            }
            const editableConfig = parseDocument(src, {
                keepSourceTokens: true
            });
            for (let [updatePath, value] of activeUpdate.values) {
                let needle = editableConfig;
                if (typeof updatePath === 'string') {
                    updatePath = [updatePath];
                }
                let i;
                for (i = 0; i < updatePath.length - 1; i++) {
                    const part = updatePath[i];
                    let newNeedle;
                    let existingNode = needle.get(part);
                    if (!existingNode || Array.isArray(existingNode) || typeof existingNode !== 'object') {
                        newNeedle = new YAMLMap();
                    }
                    else {
                        newNeedle = existingNode;
                    }
                    needle.set(part, newNeedle);
                    needle = newNeedle;
                }
                needle.set(updatePath[i], value);
            }
            const editedSrc = editableConfig.toString();
            await vscode.workspace.fs.writeFile(socketYmlURI, Buffer.from(editedSrc));
            activeUpdate.resolve();
        }
        catch (e) {
            activeUpdate.reject(e);
        }
        finally {
            activeUpdate = null;
            if (pendingUpdates.length) {
                doSingleUpdate();
            }
        }
    }
    function update(from, ...values) {
        const uris = getSocketYmlURIAndWorkspaceURI(from);
        if (!uris) {
            return Promise.reject(new Error('unable to find workspace folder, please open a folder'));
        }
        const promise = new Promise((resolve, reject) => {
            pendingUpdates.push({
                socketYmlURI: uris.socketYmlURI,
                values,
                resolve,
                reject
            });
        });
        doSingleUpdate();
        return promise;
    }
    addDisposablesTo(disposables, fsWatchers['socket.yml'].watch({
        onDidChange(e) {
            parseAgain(e);
        },
        onDidCreate(e) {
            parseAgain(e);
        },
        onDidDelete(uri) {
            socketYamlData.update(uri, undefined);
        }
    }));
    const socketYamlData = new WorkspaceData((uri) => {
        parseAgain(uri);
    }, () => {
        return DEFAULT_SOCKET_YML;
    });
    const api = {
        effectiveConfigForUri: (uri) => socketYamlData.get(uri),
        onConfig: (...params) => {
            return socketYamlData.on(...params);
        },
        update
    };
    return api;
}
//# sourceMappingURL=socket-yaml.js.map