import * as vscode from 'vscode';
import { DIAGNOSTIC_SOURCE_STR, EXTENSION_PREFIX } from '../util';

export function generateLens(range: vscode.Range, document: vscode.TextDocument) {
    return new vscode.CodeLens(range, {
        command: `${EXTENSION_PREFIX}.installGitHubApp`,
        title: `Install Socket Security GitHub App`,
        arguments: [document.uri]
    })
}

export function provideCodeActions(document: vscode.TextDocument, range: vscode.Range | vscode.Selection, context: vscode.CodeActionContext, _token: vscode.CancellationToken): vscode.ProviderResult<(vscode.CodeAction | vscode.Command)[]> {
    let actions = []
    for (const diag of context.diagnostics) {
        if (diag.source === DIAGNOSTIC_SOURCE_STR) {
            const [type] = String(diag.code).split(/,/);
            const title = `Ignore all ${JSON.stringify(type)} type issues`;
            const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix)
            action.command = {
                command: `${EXTENSION_PREFIX}.ignoreIssueType`,
                title,
                arguments: [document.uri, type]
            }
            action.diagnostics = [diag]
            action.isPreferred = false
            actions.push(action)
        }
    }
    return actions
}