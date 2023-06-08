import * as vscode from 'vscode';
import { provideCodeActions } from './dep-file';
import { getGlobPatterns } from '../data/glob-patterns';

export async function registerCodeActionsProvider() {
    const patterns = await getGlobPatterns();
    return vscode.languages.registerCodeActionsProvider({
        language: 'plaintext',
        pattern: `**/${patterns.pypi.requirements.pattern}`,
        scheme: undefined
    }, {
        provideCodeActions
    }, {
        providedCodeActionKinds: [vscode.CodeActionKind.QuickFix]
    })
}