export interface VFS<Filepath> {
  readFile(path: Filepath): Promise<string>
  writeFile(path: Filepath, str: string): Promise<unknown>
  watch(path: Filepath, signal: AbortSignal): AsyncIterable<void>
}

type SettingsWatchFunction<ReadonlyContents> = (settings: ReadonlyContents | undefined) => void
export class JSONSettingsFile<Filepath, Contents, ReadonlyContents = Contents> {
  lastSeenSrc: string | undefined = undefined
  lastSettings: ReadonlyContents | undefined
  readSettingsPromise: Promise<ReadonlyContents> | null = null
  fs
  file
  constructor(file: Filepath, fs: VFS<Filepath>) {
    this.fs = fs
    this.file = file
  }
  /**
   * Use watchSettings() instead when possible.
   *
   * Coalesces readSettings()
   * Coalesces against updateSettings()
   *
   */
  async readSettings(): Promise<ReadonlyContents> {
    if (!this.readSettingsPromise) {
      this.readSettingsPromise = this.newReadSettingsPromise()
    }
    return this.readSettingsPromise
  }

  async newReadSettingsPromise(): Promise<ReadonlyContents> {
    // readSettingsPromise != null
    try {
      let ret: ReadonlyContents | undefined | unknown
      let src: string | undefined = this.lastSeenSrc
      try {
        src = await this.fs.readFile(this.file)
        if (src === this.lastSeenSrc) {
          ret = this.lastSettings
        } else {
          // NOTE: this is not frozen, only TS saving us
          //       this was chosen to avoid complex immutable structures
          //       use the updater function!
          ret = JSON.parse(src)
          this.lastSeenSrc = src
        }
      } catch (e) {
        // corrupted, want to give result but non-JSON and work w/ defaults
        ret = undefined
        this.lastSeenSrc = undefined
        src = undefined
      }
      //#region apply pending updates and sync
      if (this.pendingUpdaters.length) {
        const consumedUpdaters: Array<(typeof this.pendingUpdaters)[number]> =
          []
        for (let i = 0; i < this.pendingUpdaters.length; i++) {
          const updater = this.pendingUpdaters[i]
          const { fn, reject } = updater
          try {
            const updated = await fn(ret as Contents)
            if (updated) {
              ret = updated
            }
            consumedUpdaters.push(updater)
          } catch (e) {
            // remove throwing updaters eagerly
            reject(e)
          }
        }
        this.pendingUpdaters.length = 0
        if (consumedUpdaters.length) {
          try {
            const writingSrc = JSON.stringify(ret)
            if (writingSrc !== this.lastSeenSrc) {
              await this.fs.writeFile(this.file, writingSrc)
              this.lastSeenSrc = writingSrc
            }
          } catch (e) {
            for (const { reject } of consumedUpdaters) {
              reject(e)
            }
            // rollback to src
            ret = typeof src !== 'undefined' ? JSON.parse(src) : undefined
          }
        }
      }
      //#endregion
      this.lastSettings = ret as ReadonlyContents
      return this.lastSettings
    } catch (e) {
      for (const { reject } of this.pendingUpdaters) {
        reject(e)
      }
      throw e
    } finally {
      this.readSettingsPromise = null
    }
  }

  watcherController: AbortController | undefined
  pendingWatchers: Set<{ fn: SettingsWatchFunction<ReadonlyContents> }> = new Set()
  pendingNotify = false
  async notifyWatchers(newSettings?: ReadonlyContents) {
    if (this.pendingNotify) return
    this.pendingNotify = true
    try {
      // note this does not match stringify, it is ref based
      const oldSettings = this.lastSettings
      if (!newSettings) {
        try {
          newSettings = await this.readSettings()
        } catch (e) {
          // ignore missing or corrupted settings
          // NOTE: ENOENT / failed JSON parse will not get here, those
          //       become `undefined`
          return
        }
      }
      if (newSettings === oldSettings) {
        return
      }
      for (const { fn } of this.pendingWatchers) {
        try {
          fn(newSettings)
        } catch (e) {
          // this are just notifications
        }
      }
    } finally {
      this.pendingNotify = false
    }
  }
  /**
   * notifies every time settings are updated
   */
  watchSettings(fn: SettingsWatchFunction<ReadonlyContents>, signal?: AbortSignal) {
    if (signal?.aborted) {
      return
    }
    const delegate = { fn }
    this.pendingWatchers.add(delegate)
    if (signal) {
      const dispose = () => {
        this.pendingWatchers.delete(delegate)
        if (this.pendingWatchers.size === 0) {
          this.watcherController?.abort()
          this.watcherController = undefined
        }
        signal.removeEventListener("abort", dispose)
      }
      signal.addEventListener("abort", dispose)
    }
    if (!this.watcherController) {
      this.doWatch()
    }
  }
  async doWatch() {
    const watcherController = this.watcherController = new AbortController()
    this.notifyWatchers()
    evented_loop: while (!this.watcherController.signal.aborted) {
      const eventController = new AbortController()
      const abortEventedWatch = () => {
        watcherController.signal.removeEventListener("abort", abortEventedWatch)
        eventController.abort()
      }
      watcherController.signal.addEventListener("abort", abortEventedWatch)
      const watcher = this.fs.watch(this.file, eventController.signal)
      try {
        for await (const _ of watcher) {
          this.notifyWatchers()
        }
      } finally {
        eventController.abort()
      }
    }
  }

  pendingUpdaters: Array<{
    fn: (settings: Contents) => Contents | void
    reject: (reason: unknown) => void
  }> = []
  /**
   * Does coalesced settings updates, fn may be called multiple times
   * Return resolves when commited to disk, NOTE: this may not contain your change if overriden by another update
   * @param fn apply updates during fn but MUST NOT ERROR AFTER MUTATING or may corrupt disk in extremely rare concurrent update, mutation at end of function expected. E.G.
   *   ```js
   *    // BAD
   *    function BAD(settings) => {settings.x = 1; settings.y = await fetch()}
   *    // Good
   *    function Ok(settings) => {let y = await fetch(); settings.x = 1; settings.y = y}
   *   ```
   * @returns
   */
  async updateSettings(
    fn: JSONSettingsFile<Filepath, Contents, ReadonlyContents>['pendingUpdaters'][number]["fn"]
  ): Promise<ReadonlyContents> {
    return new Promise((resolve, reject) => {
      this.pendingUpdaters.push({
        fn,
        // forward rejection from failed update
        reject,
      })
      return this.readSettings().then(resolve, reject)
    })
  }
}
