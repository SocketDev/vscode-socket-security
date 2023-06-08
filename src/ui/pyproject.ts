import * as vscode from 'vscode';
import toml from 'toml-eslint-parser'
import { generateLens, provideCodeActions } from './dep-file';
import { traverseTOMLKeys } from '../util';

function provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): vscode.ProviderResult<vscode.CodeLens[]> {
    const pyprojectSource = document.getText()
    const ast = toml.parseTOML(pyprojectSource)
    const lenses: vscode.CodeLens[] = [];

    traverseTOMLKeys(ast, (node, curPath) => {
        const inPoetry = curPath.length > 2 && 
            curPath[0] === 'tool' &&
            curPath[1] === 'poetry';
        const oldDeps = inPoetry && curPath.length === 3 &&
            ['dependencies', 'dev-dependencies'].includes(curPath[2] as string);
        const groupDeps = inPoetry && curPath.length === 5 &&
            curPath[2] === 'group' &&
            curPath[4] === 'dependencies';
        if (oldDeps || groupDeps) {
            const start = new vscode.Position(node.loc.start.line - 1, node.loc.start.column);
            const end = new vscode.Position(node.loc.end.line - 1, node.loc.end.column);
            const range = new vscode.Range(start, end)
            lenses.push(generateLens(range, document))
        }
    })

    return lenses
}

export async function registerCodeLensProvider() {
    return vscode.languages.registerCodeLensProvider({
        language: 'toml',
        pattern: '**/pyproject.toml',
        scheme: undefined
    }, {
        provideCodeLenses
    })
}

export async function registerCodeActionsProvider() {
    return vscode.languages.registerCodeActionsProvider({
        language: 'toml',
        pattern: '**/pyproject.toml',
        scheme: undefined
    }, {
        provideCodeActions
    }, {
        providedCodeActionKinds: [vscode.CodeActionKind.QuickFix]
    })
}
