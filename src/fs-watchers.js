import * as vscode from "vscode";
import { homedir } from 'os';
class SharedFilesystemWatcher {
    constructor(watcher) {
        this.watcher = watcher;
        this.handlers = new Set();
        if (watcher.ignoreChangeEvents !== true) {
            watcher.onDidChange((e) => {
                for (const handler of this.handlers) {
                    try {
                        handler.onDidChange?.(e);
                    }
                    catch { }
                }
            });
        }
        if (watcher.ignoreCreateEvents !== true) {
            watcher.onDidCreate((e) => {
                for (const handler of this.handlers) {
                    try {
                        handler.onDidCreate?.(e);
                    }
                    catch { }
                }
            });
        }
        if (watcher.ignoreDeleteEvents !== true) {
            watcher.onDidDelete((e) => {
                for (const handler of this.handlers) {
                    try {
                        handler.onDidDelete?.(e);
                    }
                    catch { }
                }
            });
        }
    }
    watch(partial) {
        // avoid double push issue by making new identity
        const handler = {
            onDidChange: partial.onDidChange,
            onDidCreate: partial.onDidCreate,
            onDidDelete: partial.onDidDelete,
        };
        this.handlers.add(handler);
        return new vscode.Disposable(() => {
            this.handlers.delete(handler);
        });
    }
}
let watchers = {
    "package.json": new SharedFilesystemWatcher(vscode.workspace.createFileSystemWatcher("**/package.json")),
    "package-lock.json": new SharedFilesystemWatcher(vscode.workspace.createFileSystemWatcher("**/package-lock.json")),
    "socket.yml": new SharedFilesystemWatcher(vscode.workspace.createFileSystemWatcher("**/socket.yml")),
    "config/socket/config.json": new SharedFilesystemWatcher(vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.joinPath(vscode.Uri.file(homedir()), ".config", "socket"), "config.json"))),
};
export let paths = {
    "config/socket/config.json": vscode.Uri.joinPath(vscode.Uri.file(homedir()), ".config", "socket", "config.json"),
};
export default watchers;
//# sourceMappingURL=fs-watchers.js.map