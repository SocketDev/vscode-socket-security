import * as vscode from 'vscode';

const logger = vscode.window.createOutputChannel('Socket Security', {
    log: true
})

logger.info('Socket Security extension started')

export default logger;
