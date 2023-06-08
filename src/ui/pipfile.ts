import * as vscode from 'vscode';
import { provideCodeActions } from './dep-file';

export async function registerCodeActionsProvider() {
    return vscode.languages.registerCodeActionsProvider({
        language: 'toml',
        pattern: '**/Pipfile',
        scheme: undefined
    }, {
        provideCodeActions
    }, {
        providedCodeActionKinds: [vscode.CodeActionKind.QuickFix]
    })
}