import * as vscode from 'vscode'
export function getSocketAPIToken(context: vscode.ExtensionContext, token?: vscode.CancellationToken) {
    vscode.window.showInputBox({
        title: 'Socket Security API Token',
        placeHolder: 'TOKEN',
        prompt: 'Grab API token from https://socket.dev/'
    }, token)
}
