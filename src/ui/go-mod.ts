import * as vscode from 'vscode';
import { generateLens, provideCodeActions } from './dep-file';
import { getGlobPatterns } from '../data/glob-patterns';
import { parseGoMod } from '../data/go/mod-parser';

async function provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): Promise<vscode.CodeLens[]> {
    const goModSource = document.getText()
    const parsed = await parseGoMod(goModSource)
    const lenses = []
    for (const expr of parsed?.Syntax.Stmt ?? []) {
        if ('RParen' in expr && expr.Token.length === 1 && expr.Token[0] === 'require') {
            const start = new vscode.Position(
                expr.Start.Line - 1,
                expr.Start.LineRune - 1
            )
            const end = new vscode.Position(
                expr.RParen.Pos.Line - 1,
                expr.RParen.Pos.LineRune
            )
            const range = new vscode.Range(start, end)
            lenses.push(generateLens(range, document))
            // Only highlight first instance for now
            break
        } else if ('InBlock' in expr && !expr.InBlock && expr.Token[0] === 'require') {
            const start = new vscode.Position(
                expr.Start.Line - 1,
                expr.Start.LineRune - 1
            )
            const end = new vscode.Position(
                expr.End.Line - 1,
                expr.End.LineRune - 1
            )
            const range = new vscode.Range(start, end)
            lenses.push(generateLens(range, document))
            // Only highlight first instance
            break
        }
    }
    return lenses
}

export async function registerCodeLensProvider() {
    const globPatterns = await getGlobPatterns();
    return vscode.languages.registerCodeLensProvider({
        pattern: `**/${globPatterns.golang.gomod.pattern}`,
        scheme: undefined
    }, {
        provideCodeLenses
    })
}

export async function registerCodeActionsProvider() {
    const patterns = await getGlobPatterns();
    return vscode.languages.registerCodeActionsProvider({
        pattern: `**/${patterns.golang.gomod.pattern}`,
        scheme: undefined
    }, {
        provideCodeActions
    }, {
        providedCodeActionKinds: [vscode.CodeActionKind.QuickFix]
    })
}