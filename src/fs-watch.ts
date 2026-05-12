// This file exists because vscode performs poorly when having many file watchers
import * as vscode from 'vscode'

export type SharedFilesystemWatcherHandler = Partial<{
  onDidChange: Parameters<vscode.FileSystemWatcher['onDidChange']>[0]
  onDidCreate: Parameters<vscode.FileSystemWatcher['onDidCreate']>[0]
  onDidDelete: Parameters<vscode.FileSystemWatcher['onDidDelete']>[0]
}>
class SharedFilesystemWatcher {
  handlers: Set<SharedFilesystemWatcherHandler> = new Set()
  constructor(public watcher: vscode.FileSystemWatcher) {
    if (watcher.ignoreChangeEvents !== true) {
      watcher.onDidChange(e => {
        // oxlint-disable-next-line socket/prefer-cached-for-loop -- iterating a Set.
        for (const handler of this.handlers) {
          try {
            handler.onDidChange?.(e)
          } catch {}
        }
      })
    }
    if (watcher.ignoreCreateEvents !== true) {
      watcher.onDidCreate(e => {
        // oxlint-disable-next-line socket/prefer-cached-for-loop -- iterating a Set.
        for (const handler of this.handlers) {
          try {
            handler.onDidCreate?.(e)
          } catch {}
        }
      })
    }
    if (watcher.ignoreDeleteEvents !== true) {
      watcher.onDidDelete(e => {
        // oxlint-disable-next-line socket/prefer-cached-for-loop -- iterating a Set.
        for (const handler of this.handlers) {
          try {
            handler.onDidDelete?.(e)
          } catch {}
        }
      })
    }
  }
  watch(partial: SharedFilesystemWatcherHandler): vscode.Disposable {
    // avoid double push issue by making new identity
    const handler: SharedFilesystemWatcherHandler = {}
    if (partial.onDidChange) handler.onDidChange = partial.onDidChange
    if (partial.onDidCreate) handler.onDidCreate = partial.onDidCreate
    if (partial.onDidDelete) handler.onDidDelete = partial.onDidDelete
    this.handlers.add(handler)
    return new vscode.Disposable(() => {
      this.handlers.delete(handler)
    })
  }
}

const watched: Record<string, SharedFilesystemWatcher> = {}

export function watch(
  pattern: string,
  handler: SharedFilesystemWatcherHandler,
) {
  let existing = watched[pattern]
  if (!existing) {
    existing = new SharedFilesystemWatcher(
      vscode.workspace.createFileSystemWatcher(`**/${pattern}`),
    )
    watched[pattern] = existing
  }
  return existing.watch(handler)
}
