import * as vscode from 'vscode';
import * as toml from 'toml-eslint-parser'
import { generateLens, provideCodeActions } from './dep-file';
import { traverseTOMLKeys } from '../util';
import { getGlobPatterns } from '../data/glob-patterns';

function provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): vscode.ProviderResult<vscode.CodeLens[]> {
    const pyprojectSource = document.getText()
    const ast = toml.parseTOML(pyprojectSource)
    const lenses: vscode.CodeLens[] = [];

    traverseTOMLKeys(ast, (node, curPath) => {
        const deps = curPath.length == 2 &&
            curPath[0] === 'project' &&
            ['dependencies' || 'optional-dependencies'].includes(curPath[1] as string);
        const inPoetry = curPath.length > 2 && 
            curPath[0] === 'tool' &&
            curPath[1] === 'poetry';
        const oldPoetryDeps = inPoetry && curPath.length === 3 &&
            ['dependencies', 'dev-dependencies'].includes(curPath[2] as string);
        const groupPoetryDeps = inPoetry && curPath.length === 5 &&
            curPath[2] === 'group' &&
            curPath[4] === 'dependencies';
        if (deps || oldPoetryDeps || groupPoetryDeps) {
            const start = new vscode.Position(node.loc.start.line - 1, node.loc.start.column);
            const end = new vscode.Position(node.loc.end.line - 1, node.loc.end.column);
            const range = new vscode.Range(start, end)
            lenses.push(generateLens(range, document))
        }
    })

    return lenses
}

export async function registerCodeLensProvider() {
    const globPatterns = await getGlobPatterns();
    return vscode.languages.registerCodeLensProvider({
        pattern: `**/${globPatterns.pypi.pyproject.pattern}`,
        scheme: undefined
    }, {
        provideCodeLenses
    })
}

export async function registerCodeActionsProvider() {
    const globPatterns = await getGlobPatterns();
    return vscode.languages.registerCodeActionsProvider({
        pattern: `**/${globPatterns.pypi.pyproject.pattern}`,
        scheme: undefined
    }, {
        provideCodeActions
    }, {
        providedCodeActionKinds: [vscode.CodeActionKind.QuickFix]
    })
}
