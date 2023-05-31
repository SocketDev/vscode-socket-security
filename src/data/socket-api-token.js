import * as vscode from 'vscode';
export function getSocketAPIToken(context, token) {
    vscode.window.showInputBox({
        title: 'Socket Security API Token',
        placeHolder: 'TOKEN',
        prompt: 'Grab API token from https://socket.dev/'
    }, token);
}
//# sourceMappingURL=socket-api-token.js.map