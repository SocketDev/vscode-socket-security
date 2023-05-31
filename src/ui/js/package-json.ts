import * as vscode from 'vscode';
import jsonToAST from 'json-to-ast'
import { DIAGNOSTIC_SOURCE_STR, EXTENSION_PREFIX } from '../../util';

export function provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): vscode.ProviderResult<vscode.CodeLens[]> {
    const packageJSONSource = document.getText()
    const ast = jsonToAST(packageJSONSource, { loc: true })
    const lenses = []
    if (ast.type === 'Object') {
        const child: jsonToAST.PropertyNode | undefined = ast.children.find(
            child => {
                return child.key.value === 'dependencies' || child.key.value === 'devDependencies'
            }
        )
        if (child) {
            if (!child.loc) return
            const startPos = new vscode.Position(
                child.loc.start.line - 1,
                child.loc.start.column
            )
            const endPos = new vscode.Position(
                child.loc.end.line - 1,
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
