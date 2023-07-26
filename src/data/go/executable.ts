import * as vscode from 'vscode'
import { EXTENSION_PREFIX } from '../../util';

async function getGoExtension() {
    const go = vscode.extensions.getExtension('golang.go');
    if (go && !go.isActive) await go.activate();
    return go?.exports;
}

export async function initGo(): Promise<vscode.Disposable> {
    // in the future, do any needed init work with the golang.go extension instance here
    return new vscode.Disposable(() => {});
}

const warned = new Set<string>();

export async function getGoExecutable(fileName?: string): Promise<string | void> {
    // no executable in virtual workspace
    if (vscode.workspace.workspaceFolders?.every(f => f.uri.scheme !== 'file')) return
    const workspaceConfig = vscode.workspace.getConfiguration(EXTENSION_PREFIX);
    const pathOverride = workspaceConfig.get<string>('goExecutable');
    if (pathOverride) {
        return Promise.resolve(vscode.workspace.fs.stat(vscode.Uri.file(pathOverride))).then(
            st => {
                if (st.type & vscode.FileType.File) return pathOverride;
                throw new Error('not a file')
            }
        ).catch(err => {
            vscode.window.showErrorMessage(`Failed to find Go binary at '${pathOverride}'. Please update ${EXTENSION_PREFIX}.goExecutable.`)
        })
    }
    const ext = await getGoExtension();
    const cmd = await ext?.settings.getExecutionCommand(
        'go',
        fileName && vscode.Uri.file(fileName)
    )
    if (cmd) return cmd.binPath
    const workspaceID = vscode.workspace.name ||
        vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath).join(',') ||
        vscode.window.activeTextEditor?.document.uri.fsPath;
    if (workspaceID) {
        if (warned.has(workspaceID)) return;
        warned.add(workspaceID);
    }
    const installGo = 'Install Go extension';
    const configGo = 'Configure Go extension';
    const setPath = `Configure Socket`;
    vscode.window.showErrorMessage(
        `Socket failed to find a Go installation; please ${ext ? 'install the Go toolchain with' : 'install'} the Go extension or set ${EXTENSION_PREFIX}.goExecutable.`,
        ext ? configGo : installGo,
        setPath
    ).then(async res => {
        if (res === installGo) {
            vscode.env.openExternal(vscode.Uri.parse('vscode:extension/golang.go'));
        } else if (res === configGo) {
            vscode.commands.executeCommand('go.tools.install');
        } else if (res === setPath) {
            await workspaceConfig.update('goExecutable', '', vscode.ConfigurationTarget.Global)
            vscode.commands.executeCommand('workbench.action.openSettingsJson');
        }
    })
}
