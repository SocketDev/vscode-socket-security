import * as vscode from 'vscode';
import { provideCodeActions } from './dep-file';
import { getGlobPatterns } from '../data/glob-patterns';

export async function registerCodeActionsProvider() {
    const globPatterns = await getGlobPatterns();
    return vscode.languages.registerCodeActionsProvider({
        pattern: `**/${globPatterns.pypi.pipfile.pattern}`,
        scheme: undefined
    }, {
        provideCodeActions
    }, {
        providedCodeActionKinds: [vscode.CodeActionKind.QuickFix]
    })
}