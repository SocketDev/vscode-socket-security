import * as vscode from 'vscode'
import logger from '../infra/log'
    
import {activate as activateDecorations} from './decorations'
export function activate(
    context: vscode.ExtensionContext,
) {
    logger.appendLine('Socket Security extension started decorating files')
    activateDecorations(context);
}
