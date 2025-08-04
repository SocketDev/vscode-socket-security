import type { SimPURL } from '../externals/parse-externals'
import https from 'https'
import { createInterface } from 'readline'
import { once } from 'events'
import type { IncomingMessage } from 'http'
import logger from '../../infra/log'
import os from 'os'
import path from 'path'
import fs from 'fs'
import { getAuthHeader, getAPIKey } from '../../auth'
// if this is updated update lifecycle scripts
const cacheDir = path.resolve(os.homedir(), '.socket', 'vscode')

export function clearCache() {
    fs.rmSync(cacheDir, { recursive: true, force: true })
}

export type PackageScoreAndAlerts = {
    alerts: Array<{
        action: 'error' | 'warn' | 'monitor' | 'ignore',
        type: string,
        severity: 'critical' | 'high' | 'medium' | 'low',
        props: any
    }>,
    score: {
        license: number,
        maintenance: number,
        overall: number,
        quality: number,
        supplyChain: number,
        vulnerability: number,
    },
    type: string;
    namespace?: string;
    name: string;
    version?: string;
    qualifiers?: string;
    subpath?: string;
}

export class PURLPackageData {
    purl: SimPURL;
    watchers: Set<(pkgData: PURLPackageData) => void> = new Set();
    pkgData!: PackageScoreAndAlerts | null
    mtime: number = -Infinity
    error: string | null = null;
    setError(reason: string) {
        this.error = reason;
        if (!this.pkgData) {
            this.#notifyWatchers();
        }
    }
    constructor(purl: SimPURL) {
        this.purl = purl;
        this.readPkgDataFromDisk();
    }
    filepath() {
        return path.join(cacheDir, `${btoa(this.purl)}.json`);
    }
    writePkgDataToDisk() {
        const filePath = this.filepath();
        try {
            fs.mkdirSync(cacheDir, { recursive: true })
            fs.writeFileSync(filePath, JSON.stringify(this.pkgData, null, 2))
            logger.debug(`Wrote PURL data to disk for ${this.purl} at ${filePath}`)
        } catch (e) {
            logger.debug(`Failed to write PURL data to disk for ${this.purl}`, e)
        }
    }
    readPkgDataFromDisk() {
        const filePath = this.filepath();
        try {
            const data = fs.readFileSync(filePath, 'utf-8');
            this.pkgData = JSON.parse(data);
            this.mtime = fs.statSync(filePath).mtimeMs;
        } catch (e) {
            logger.debug(`Failed to read PURL data from disk for ${this.purl}`, e)
        }
    }
    isStale() {
        return this.mtime + 10 * 60 * 1000 < Date.now(); // 10 minutes
    }
    subscribe(cb: (pkgData: PURLPackageData) => void) {
        this.watchers.add(cb);
    }
    unsubscribe(cb: (pkgData: PURLPackageData) => void) {
        this.watchers.delete(cb);
    }
    update(data: PackageScoreAndAlerts) {
        this.pkgData = data;
        this.error = null;
        this.writePkgDataToDisk();
        this.#notifyWatchers();
    }
    #notifyWatchers() {
        for (const watcher of this.watchers) {
            watcher(this);
        }
    }
}
export class PURLDataCache {
    static singleton: PURLDataCache = new PURLDataCache();
    timeout: number = 10 * 60 * 1000; // 10 minutes
    #pkgData: Map<SimPURL, PURLPackageData> = new Map();
    // PURLs just waiting for bus to be sent
    #pkgsNeedingUpdate: Set<SimPURL> = new Set();
    // in-flight PURLs
    #currentPendingUpdates: Set<SimPURL> = new Set();
    private constructor() {}
    watch(purl: SimPURL): PURLPackageData {
        let pkgDataForPURL = this.#pkgData.get(purl);
        if (!pkgDataForPURL) {
            const newPkgData = new PURLPackageData(purl);
            this.#pkgData.set(purl, newPkgData);
            pkgDataForPURL = newPkgData;
        }
        if (pkgDataForPURL.isStale()) {
            this.queueUpdate(purl);
        }
        return pkgDataForPURL;
    }
    queueUpdate(purl: SimPURL) {
        // already on a bus
        if (this.#currentPendingUpdates.has(purl)) {
            return
        }
        const thisIsTheBusForTheseUpdates = this.#pkgsNeedingUpdate.size === 0;
        this.#pkgsNeedingUpdate.add(purl);
        // logger.info(`is bus`, thisIsTheBusForTheseUpdates, `for`, purl, `pending updates:`, this.#currentPendingUpdates.size, `queued updates:`, this.#pkgsNeedingUpdate.size);
        if (!thisIsTheBusForTheseUpdates) {
            return; // already scheduled a bus trip
        }

        const controller = new AbortController()
        const abort = controller.abort.bind(controller)
        const timer = setTimeout(abort, this.timeout);
        ;(async () => {
            // microtask to allow other updates to be queued
            await null
            const thesePendingUpdates = new Set(Array.from(this.#pkgsNeedingUpdate));
            this.#pkgsNeedingUpdate.clear()
            for (const purl of thesePendingUpdates) {
                this.#currentPendingUpdates.add(purl);
            }
            const bailPendingCacheEntries = (reason?: Error) => {
                for (const purl of thesePendingUpdates) {
                    logger.debug(`Bailing pending cache entry for PURL: ${purl}`, reason?.message);
                    this.#currentPendingUpdates.delete(purl);
                    this.#pkgData.get(purl)?.setError('Unable to load data from Socket API' + (reason ? `: ${reason.message}` : ''));
                }
            }
            controller.signal.addEventListener('abort', () => {
                clearTimeout(timer)
                bailPendingCacheEntries(controller.signal.reason || new Error('Aborted'))
            })
            try {
                const apiKey = await getAPIKey()
                if (!apiKey) {
                    bailPendingCacheEntries()
                    return
                }
                const req = https.request(`https://api.socket.dev/v0/purl?alerts=true&compact=false'`, {
                    method: 'POST',
                    headers: {
                        'content-type': 'application/json',
                        'authorization': getAuthHeader(apiKey),
                    },
                    signal: controller.signal
                })
                // logger.info(`Requesting Socket API for PURLs: ${[...thesePendingUpdates].join(', ')}`)
                function cleanupReq() {
                    try {
                        req.destroy()
                    } catch {
                    }
                }
                controller.signal.addEventListener('abort', cleanupReq)
                const body = JSON.stringify({
                    components: [...thesePendingUpdates].map(str => ({
                        purl: str
                    }))
                })
                req.end(body )
                const [res] = (await once(req, 'response')) as unknown as [IncomingMessage]
                function cleanupRes() {
                    try {
                        res.destroy()
                    } catch {
                    }
                }
                controller.signal.addEventListener('abort', cleanupRes)
                logger.debug(`Received response from Socket API for PURLs: ${[...thesePendingUpdates].join(', ')}`, res.statusCode, res.statusMessage)

                if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
                    throw new Error(`Unexpected response from Socket API: ${res.statusCode} ${res.statusMessage}`)
                }
                const lines = createInterface({
                    input: res,
                    terminal: false,
                    crlfDelay: Infinity,
                    historySize: 0
                })
                for await (const line of lines) {
                    const scoreAndAlerts = JSON.parse(line) as PackageScoreAndAlerts
                    const type = scoreAndAlerts.type
                    const name = type === 'pypi' ? scoreAndAlerts.name.replaceAll('-', '_') : scoreAndAlerts.name
                    const namespace = scoreAndAlerts.namespace ? scoreAndAlerts.namespace + '/' : '';
                    const purlWithoutVersion = `pkg:${type}/${namespace}${name}${scoreAndAlerts.qualifiers ? '?' + scoreAndAlerts.qualifiers : ''}${scoreAndAlerts.subpath ? '#' + scoreAndAlerts.subpath : ''}` as SimPURL;
                    const purlWithVersion = `pkg:${type}/${namespace}${name}@${scoreAndAlerts.version}${scoreAndAlerts.qualifiers ? '?' + scoreAndAlerts.qualifiers : ''}${scoreAndAlerts.subpath ? '#' + scoreAndAlerts.subpath : ''}` as SimPURL;
                    this.#pkgData.get(purlWithoutVersion)?.update(scoreAndAlerts);
                    this.#pkgData.get(purlWithVersion)?.update(scoreAndAlerts);

                    thesePendingUpdates.delete(purlWithoutVersion)
                  thesePendingUpdates.delete(purlWithVersion);
                }
                bailPendingCacheEntries(new Error('Not Found'))
            } catch (e) {
                abort()
            }
        })()
    }
}
