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

const warned = new Set<string>();

export async function getPythonInterpreter(fileName?: string): Promise<string | void> {
    // no interpreter in virtual workspace
    if (vscode.workspace.workspaceFolders?.every(f => f.uri.scheme !== 'file')) return
    const workspaceConfig = vscode.workspace.getConfiguration(EXTENSION_PREFIX);
    const pathOverride = workspaceConfig.get<string>('pythonInterpreter');
    if (pathOverride) {
        return Promise.resolve(vscode.workspace.fs.stat(vscode.Uri.file(pathOverride))).then(
            st => {
                if (st.type & vscode.FileType.File) return pathOverride;
                throw new Error('not a file')
            }
        ).catch(err => {
            vscode.window.showErrorMessage(`Failed to find Python binary at '${pathOverride}'. Please update ${EXTENSION_PREFIX}.pythonInterpreter.`)
        })
    }
    const ext = await getPythonExtension();
    const env = await ext?.environments.resolveEnvironment(
        ext?.environments.getActiveEnvironmentPath(fileName && vscode.Uri.file(fileName))
    )
    if (env) return env.executable.uri.fsPath;
    const workspaceID = vscode.workspace.name ||
        vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath).join(',') ||
        vscode.window.activeTextEditor?.document.uri.fsPath;
    if (workspaceID) {
        if (warned.has(workspaceID)) return;
        warned.add(workspaceID);
    }
    const installPython = 'Install Python extension';
    const configPython = 'Configure Python extension';
    const setPath = `Configure Socket`;
    vscode.window.showErrorMessage(
        `Socket failed to find a Python installation; please ${ext ? 'pick an interpreter within' : 'install'} the Python extension or set ${EXTENSION_PREFIX}.pythonInterpreter.`,
        ext ? configPython : installPython,
        setPath
    ).then(async res => {
        if (res === installPython) {
            vscode.env.openExternal(vscode.Uri.parse('vscode:extension/ms-python.python'));
        } else if (res === configPython) {
            vscode.commands.executeCommand('python.setInterpreter');
        } else if (res === setPath) {
            await workspaceConfig.update('pythonInterpreter', '', vscode.ConfigurationTarget.Global)
            vscode.commands.executeCommand('workbench.action.openSettingsJson');
        }
    })
}

const changeMSPython = new vscode.EventEmitter<void>();
export const onMSPythonInterpreterChange = changeMSPython.event;
