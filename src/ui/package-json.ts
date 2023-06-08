import * as vscode from 'vscode';
import jsonToAST from 'json-to-ast'
import { generateLens, provideCodeActions } from './dep-file';

function provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): vscode.ProviderResult<vscode.CodeLens[]> {
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
            lenses.push(generateLens(range, document))
        }
    }
    return lenses
}

export async function registerCodeLensProvider() {
    return vscode.languages.registerCodeLensProvider({
        language: 'json',
        pattern: '**/package.json',
        scheme: undefined
    }, {
        provideCodeLenses
    })
}

export async function registerCodeActionsProvider() {
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
