import * as _fs from "fs/promises"
import { watchFile, unwatchFile } from "fs"

import type { VFS } from "./settings"

export const nodeFS: VFS<string> = {
  readFile(path) {
    return _fs.readFile(path, "utf-8")
  },
  writeFile(path, str) {
    return _fs.writeFile(path, str)
  },
  watch: async function* (path, signal) {
    evented_loop: while (!signal.aborted) {
      const eventController = new AbortController()
      function abortEventedWatch() {
        signal.removeEventListener("abort", abortEventedWatch)
        eventController.abort()
      }
      signal.addEventListener("abort", abortEventedWatch)
      try {
        // DUE TO STDLIB API DESIGN WE HAVE TO REALLOC WATCHERS EVERY RENAME
        // TO KEEP WATCHING THE CORRECT FILE PATH
        const watcher = _fs.watch(path, {
          signal: eventController.signal,
        })
        try {
          for await (const { eventType } of watcher) {
            if (eventType === "rename") {
              continue evented_loop
            }
            try {
              yield void 0
            } catch (e) {}
          }
        } finally {
          // stop _fs.watch
          eventController.abort()
        }
      } catch (e) {
        if (e && typeof e === "object" && "code" in e && e.code === "ENOENT") {
          await new Promise<void>((f, r) => {
            type Stats = import("fs").Stats
            function backToEvented(cur: Stats, old: Stats) {
              if (cur.size !== old.size || cur.mtime > old.mtime) {
                unwatchFile(path, backToEvented)
                f()
              }
            }
            watchFile(path, backToEvented)
            const abortPoller = () => {
              unwatchFile(path, backToEvented)
              signal.removeEventListener("abort", abortPoller)
              r(signal.reason)
            }
            signal.addEventListener("abort", abortPoller)
          })
          yield void 0
        } else {
          throw e
        }
      }
    }
  },
}
