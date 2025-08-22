// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below

import * as vscode from 'vscode';
import * as editorConfig from './data/editor-config';
import * as files from './ui/file'
import * as auth from './auth'

// This identifier is replaced at build time by esbuild using --define:EXTENSION_VERSION
// Keep a `typeof` guard when reading it so runtime is safe if the define wasn't provided.
declare const EXTENSION_VERSION: string | undefined;

export async function activate(context: vscode.ExtensionContext) {
    editorConfig.activate(context);
    auth.activate(context, context.subscriptions);
    files.activate(context);
    if (vscode.lm?.registerMcpServerDefinitionProvider) {
        const definition: vscode.McpHttpServerDefinition = new vscode.McpHttpServerDefinition(
            '[Extension] Socket Security',
            vscode.Uri.parse('https://mcp.socket.dev/'),
            {
                'user-agent': `Socket Security VSCode Extension/${EXTENSION_VERSION}`,
            }
        )
        const provider: vscode.McpServerDefinitionProvider<vscode.McpHttpServerDefinition> = {
            provideMcpServerDefinitions(token) {
                return [
                    definition
                ];
            },
            resolveMcpServerDefinition(definition, token) {
                return definition
            }
        }
        vscode.lm.registerMcpServerDefinitionProvider('socket-security.mcp-server', provider);
    }
}
