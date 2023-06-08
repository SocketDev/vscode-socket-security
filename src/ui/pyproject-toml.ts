import * as vscode from 'vscode';
import toml, { traverseNodes, AST } from 'toml-eslint-parser'
import { DIAGNOSTIC_SOURCE_STR, EXTENSION_PREFIX } from '../util';

function provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): vscode.ProviderResult<vscode.CodeLens[]> {
    const pyprojectSource = document.getText()
    const ast = toml.parseTOML(pyprojectSource)
    const curPath: (string | number)[] = [];
    const lenses: vscode.CodeLens[] = [];

    traverseNodes(ast, {
        enterNode(node) {
            if (node.type === 'TOMLKeyValue') {
                curPath.push(...node.key.keys.map(k => k.type == 'TOMLBare' ? k.name : k.value));
            } else if (node.type === 'TOMLTable') {
                curPath.push(...node.resolvedKey);
            } else if (node.type === 'TOMLKey') {
                if (
                    curPath.length === 3 &&
                    curPath[0] === 'tool' &&
                    curPath[1] === 'poetry' &&
                    ['dependencies', 'dev-dependencies'].includes(curPath[2] as string)
                ) {
                    const start = new vscode.Position(node.loc.start.line - 1, node.loc.start.column);
                    const end = new vscode.Position(node.loc.end.line - 1, node.loc.end.column);
                    const range = new vscode.Range(start, end)
                    const lens = new vscode.CodeLens(range, {
                        command: `${EXTENSION_PREFIX}.installGitHubApp`,
                        title: `Install Socket Security GitHub App`,
                        arguments: [document.uri]
                    })
                    lenses.push(lens)
                }
            }
        },
        leaveNode(node) {
            if (node.type === 'TOMLKeyValue') {
                curPath.length -= node.key.keys.length;
            } else if (node.type === 'TOMLTable') {
                curPath.length -= node.resolvedKey.length;
            }
        }
    });
    return lenses
}

export function registerCodeLensProvider() {
    return vscode.languages.registerCodeLensProvider({
        language: 'json',
        pattern: '**/pyproject.toml',
        scheme: undefined
    }, {
        provideCodeLenses
    })
}

function provideCodeActions(document: vscode.TextDocument, range: vscode.Range | vscode.Selection, context: vscode.CodeActionContext, _token: vscode.CancellationToken): vscode.ProviderResult<(vscode.CodeAction | vscode.Command)[]> {
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

export function registerCodeActionsProvider() {
    return vscode.languages.registerCodeActionsProvider({
        language: 'json',
        pattern: '**/package.json',
        scheme: undefined
    }, {
        provideCodeActions
    }, {
        providedCodeActionKinds: [vscode.CodeActionKind.QuickFix]
    })
}
