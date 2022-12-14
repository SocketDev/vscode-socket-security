import * as vscode from 'vscode';

export type SharedFilesystemWatcherHandler = Partial<{
    onDidChange: Parameters<vscode.FileSystemWatcher['onDidChange']>[0],
    onDidCreate: Parameters<vscode.FileSystemWatcher['onDidCreate']>[0],
    onDidDelete: Parameters<vscode.FileSystemWatcher['onDidDelete']>[0],
}>
class SharedFilesystemWatcher {
    handlers: Set<SharedFilesystemWatcherHandler> = new Set()
    constructor(
        public watcher: vscode.FileSystemWatcher
    ) {
        if (watcher.ignoreChangeEvents !== true) {
            watcher.onDidChange((e) => {
                for (const handler of this.handlers) {
                    try {
                        handler.onDidChange?.(e)
                    } catch {}
                }
            });
        }
        if (watcher.ignoreCreateEvents !== true) {
            watcher.onDidCreate((e) => {
                for (const handler of this.handlers) {
                    try {
                        handler.onDidCreate?.(e)
                    } catch {}
                }
            });
        }
        if (watcher.ignoreDeleteEvents !== true) {
            watcher.onDidDelete((e) => {
                for (const handler of this.handlers) {
                    try {
                        handler.onDidDelete?.(e)
                    } catch {}
                }
            });
        }
    }
    watch(partial: SharedFilesystemWatcherHandler): vscode.Disposable {
        // avoid double push issue by making new identity
        const handler = {
            onDidChange: partial.onDidChange,
            onDidCreate: partial.onDidCreate,
            onDidDelete: partial.onDidDelete
        }
        this.handlers.add(handler);
        return new vscode.Disposable(() => {
            this.handlers.delete(handler);
        })
    }
}

export default {
    'package.json': new SharedFilesystemWatcher(vscode.workspace.createFileSystemWatcher('**/package.json')),
    'package-lock.json': new SharedFilesystemWatcher(vscode.workspace.createFileSystemWatcher('**/package-lock.json')),
    'socket.yml': new SharedFilesystemWatcher(vscode.workspace.createFileSystemWatcher('**/socket.yml'))
}
