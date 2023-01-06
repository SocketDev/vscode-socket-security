import * as vscode from 'vscode';
import jsonToAST from 'json-to-ast'
import { DIAGNOSTIC_SOURCE_STR, EXTENSION_PREFIX } from '../extension';

export function provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): vscode.ProviderResult<vscode.CodeLens[]> {
    const packageJSONSource = document.getText()
    const ast = jsonToAST(packageJSONSource, { loc: true })
    const lenses = []
    if (ast.type === 'Object') {
        const child: jsonToAST.PropertyNode | undefined = ast.children.find(
            child => {
                return child.key.value === 'dependencies' || child.key.value === 'devDevdependencies'
            }
        )
        if (child) {
            if (!child.loc) return
            const startPos = new vscode.Position(
                child.loc.start.line,
                child.loc.start.column
            )
            const endPos = new vscode.Position(
                child.loc.end.line,
                child.loc.end.column
            )
            const range = new vscode.Range(startPos, endPos)
            const lens = new vscode.CodeLens(range, {
                command: `${EXTENSION_PREFIX}.installGitHubApp`,
                title: `Install Socket Security GitHub App`,
                arguments: [document.uri]
            })
            lenses.push(lens)
        }
    }
    return lenses
}

export function provideCodeActions(document: vscode.TextDocument, range: vscode.Range | vscode.Selection, context: vscode.CodeActionContext, _token: vscode.CancellationToken): vscode.ProviderResult<(vscode.CodeAction | vscode.Command)[]> {
    let actions = []
    for (const diag of context.diagnostics) {
        if (diag.source === DIAGNOSTIC_SOURCE_STR) {
            const action = new vscode.CodeAction(`Ignore all ${diag.code} issues`, vscode.CodeActionKind.QuickFix)
            action.command = {
                command: `${EXTENSION_PREFIX}.ignoreIssueType`,
                title: `Ignore all ${diag.code} issues`,
                arguments: [document.uri, diag.code]
            }
            action.diagnostics = [diag]
            action.isPreferred = false
            actions.push(action)
        }
    }
    return actions
}
