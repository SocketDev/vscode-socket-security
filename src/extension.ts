// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below

import * as vscode from 'vscode';
import { ExtensionContext, workspace } from 'vscode';
import * as socketAPIConfig from './data/socket-api-config'
import { EXTENSION_PREFIX, getWorkspaceFolderURI} from './util';
import * as editorConfig from './data/editor-config';
import * as files from './ui/file'
// import { parseExternals } from './ui/externals/parse-externals';
import watch, { SharedFilesystemWatcherHandler } from './fs-watch';
import { initPython, onMSPythonInterpreterChange } from './data/python/interpreter';
import { initGo } from './data/go/executable';
import { getGlobPatterns } from './data/glob-patterns';

export async function activate(context: ExtensionContext) {
    const config = editorConfig.activate(context);
    socketAPIConfig.init(context.subscriptions)
    files.activate(context)
}
