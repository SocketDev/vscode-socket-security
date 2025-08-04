// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below

import { ExtensionContext } from 'vscode';
import * as editorConfig from './data/editor-config';
import * as files from './ui/file'
import * as auth from './auth'

export async function activate(context: ExtensionContext) {
    editorConfig.activate(context);
    auth.activate(context, context.subscriptions);
    files.activate(context);
}
