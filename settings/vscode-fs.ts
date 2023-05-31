import vscode from "vscode"
import _path from "path"

import type { VFS } from "./settings"

export const vscodeFS: VFS<import("vscode").Uri> = {
  async readFile(path) {
    const decoder = new TextDecoder()
    return decoder.decode(await vscode.workspace.fs.readFile(path))
  },
  async writeFile(path, str) {
    const encoder = new TextEncoder()
    return vscode.workspace.fs.writeFile(path, encoder.encode(str))
  },
  watch: async function* (path, signal) {
    if (signal.aborted) {
      return
    }
    const base = vscode.Uri.joinPath(path, "..")
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(base, _path.basename(path.path))
    )
    let pendingEvent = false
    let fulfill: (() => void) | null = null
    function queue() {
      pendingEvent = true
      fulfill?.()
    }
    const disposables = [
      watcher,
      watcher.onDidChange(queue),
      watcher.onDidCreate(queue),
      watcher.onDidDelete(queue),
    ]
    function unwatch() {
      for (const disposable of disposables) {
        disposable.dispose()
      }
      signal.removeEventListener("abort", unwatch)
    }
    signal.addEventListener("abort", unwatch)
    while (!signal.aborted) {
      if (!pendingEvent) {
        await new Promise<void>((f) => {
          fulfill = f
        })
      }
      if (!signal.aborted) {
        yield void 0
      }
    }
  },
}
