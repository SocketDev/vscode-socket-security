import * as vscode from 'vscode';

const logger = vscode.window.createOutputChannel('Socket Security', {
    log: true
})

logger.appendLine('Socket Security extension started')

export default logger;
