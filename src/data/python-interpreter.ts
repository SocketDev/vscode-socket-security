import * as vscode from 'vscode'
import { EXTENSION_PREFIX } from '../util';

async function getPythonExtension() {
    const msPython = vscode.extensions.getExtension('ms-python.python');
    if (msPython && !msPython.isActive) await msPython.activate();
    return msPython?.exports;
}

export async function initPython(): Promise<vscode.Disposable> {
    const ext = await getPythonExtension();
    if (ext) {
        return ext.environments.onDidChangeActiveEnvironmentPath((e: unknown) => {
            changeMSPython.fire();
        });
    }
    return new vscode.Disposable(() => {});
}

export async function getPythonInterpreter(fileName?: string): Promise<string | undefined> {
    // no interpreter in virtual workspace
    if (vscode.workspace.workspaceFolders?.every(f => f.uri.scheme !== 'file')) return
    const workspaceConfig = vscode.workspace.getConfiguration(EXTENSION_PREFIX);
    const pathOverride = workspaceConfig.get<string>('pythonInterpreterPath');
    if (pathOverride) {
        return vscode.workspace.fs.stat(vscode.Uri.file(pathOverride)).then(
            () => pathOverride,
            err => {
                vscode.window.showErrorMessage(`Failed to find Python binary at '${pathOverride}'. Please update ${EXTENSION_PREFIX}.pythonInterpreterPath.`)
            }
        )
    }
    const ext = await getPythonExtension();
    const env = ext?.environments.resolveEnvironment(
        ext?.environments.getActiveEnvironmentPath(fileName && vscode.Uri.file(fileName))
    )
    if (env) return env.executable.uri.fsPath;
    const installPython = 'Install Python extension';
    const configPython = 'Configure Python extension';
    const setPath = `Set ${EXTENSION_PREFIX}.pythonInterpreterPath`
    vscode.window.showErrorMessage(
        `Socket failed to find a Python installation; please ${ext ? 'configure' : 'install'} the [Python extension](vscode:extension/ms-python.python) or set ${EXTENSION_PREFIX}.pythonInterpreterPath`,
        ext ? configPython : installPython,
        setPath
    ).then(async res => {
        if (res === installPython) {
            vscode.env.openExternal(vscode.Uri.parse('vscode:extension/ms-python.python'));
        } else if (res === configPython) {
            vscode.commands.executeCommand('python.setInterpreter');
        } else if (res === setPath) {
            await workspaceConfig.update('pythonInterpreterPath', '', vscode.ConfigurationTarget.Global)
            vscode.commands.executeCommand('workbench.action.openSettingsJson');
        }
    })
}

const changeMSPython = new vscode.EventEmitter<void>();
export const onMSPythonInterpreterChange = changeMSPython.event;
