// import { paths } from "../fs-watchers"
import * as fs from "fs/promises";
const AuthOperatingModes = {
    /**
     * Sends up data anonymously, data may be persisted indefinitely
     */
    OPEN_SOURCE: "OPEN_SOURCE",
    /**
     * Sends up data associated with a login, data may be persisted indefinitely
     */
    LOGIN: "LOGIN",
    /**
     * Prevents actions requiring a login
     */
    DISABLED: "DISABLED",
    /**
     * Need user interaction, probably should prompt
     */
    UNDEFINED: "UNDEFINED",
};
const socketConfigPath = 'settings.json'; //paths["config/socket/config.json"].fsPath
let lastSeenSrc = null;
let lastSettings;
let readSettingsPromise = null;
/**
 * Use watchSettings() instead when possible.
 *
 * Coalesces readSettings()
 * Coalesces against updateSettings()
 *
 */
export async function readSettings() {
    if (!readSettingsPromise) {
        readSettingsPromise = newReadSettingsPromise();
    }
    return readSettingsPromise;
    async function newReadSettingsPromise() {
        // readSettingsPromise != null
        try {
            let ret;
            const src = await fs.readFile(socketConfigPath, "utf-8");
            if (src === lastSeenSrc) {
                ret = lastSettings;
            }
            else {
                // NOTE: this is not frozen, only TS saving us
                //       this was chosen to avoid complex immutable structures
                //       use the updater function!
                ret = JSON.parse(src);
            }
            //#region apply pending updates and sync
            if (pendingUpdaters.length) {
                const consumedUpdaters = [];
                for (let i = 0; i < pendingUpdaters.length; i++) {
                    const updater = pendingUpdaters[i];
                    const { fn, reject } = updater;
                    try {
                        const updated = await fn(ret);
                        if (updated) {
                            ret = updated;
                        }
                        consumedUpdaters.push(updater);
                    }
                    catch (e) {
                        // remove throwing updaters eagerly
                        reject(e);
                    }
                }
                if (consumedUpdaters.length) {
                    try {
                        const writingSrc = JSON.stringify(ret);
                        const encoder = new TextEncoder();
                        const writingBuf = encoder.encode(writingSrc);
                        await fs.writeFile(socketConfigPath, writingBuf);
                        lastSeenSrc = writingSrc;
                        lastSettings = ret;
                    }
                    catch (e) {
                        for (const { reject } of consumedUpdaters) {
                            reject(e);
                        }
                        // rollback to src
                        ret = JSON.parse(src);
                    }
                }
            }
            //#endregion
            return ret;
        }
        catch (e) {
            for (const { reject } of pendingUpdaters) {
                reject(e);
            }
            throw e;
        }
        finally {
            readSettingsPromise = null;
        }
    }
}
let watcherController;
let pendingWatchers = new Set();
async function notifyWatchers(newSettings) {
    const oldSettings = lastSettings;
    if (!newSettings) {
        newSettings = await readSettings();
    }
    if (newSettings === oldSettings) {
        return;
    }
    for (const { fn } of pendingWatchers) {
        try {
            fn(newSettings);
        }
        catch (e) { }
    }
}
/**
 * notifies every time settings are updated
 */
export function watchSettings(fn, signal) {
    if (signal.aborted) {
        return;
    }
    const delegate = { fn };
    pendingWatchers.add(delegate);
    function dispose() {
        pendingWatchers.delete(delegate);
        if (pendingWatchers.size === 0) {
            watcherController?.abort();
            watcherController = null;
        }
        signal.removeEventListener("abort", dispose);
    }
    signal.addEventListener("abort", dispose);
    if (!watcherController) {
        doWatch();
    }
    async function doWatch() {
        watcherController = new AbortController();
        const watcher = fs.watch(socketConfigPath, {
            signal: watcherController.signal,
        });
        for await (const _event of watcher) {
            try {
                notifyWatchers();
            }
            catch (e) { }
        }
    }
}
let pendingUpdaters = [];
/**
 * Does coalesced settings updates, fn may be called multiple times
 * Return resolves when commited to disk
 * @param fn apply updates during fn but MUST NOT ERROR AFTER MUTATING or may corrupt disk in extremely rare concurrent update, mutation at end of function expected. E.G.
 *   ```js
 *    // BAD
 *    function BAD(settings) => {settings.x = 1; settings.y = await fetch()}
 *    // Good
 *    function Ok(settings) => {let y = await fetch(); settings.x = 1; settings.y = y}
 *   ```
 * @returns
 */
export async function updateSettings(fn) {
    return new Promise((resolve, reject) => {
        pendingUpdaters.push({
            fn,
            // forward rejection from failed update
            reject,
        });
        return readSettings().then(resolve, reject);
    });
}
