import vscode from 'vscode'
import os from 'os'
import path from 'path'
import { DIAGNOSTIC_SOURCE_STR, EXTENSION_PREFIX } from './util'
import { getQuota } from './api'

export async function activate(context: vscode.ExtensionContext, disposables?: Array<vscode.Disposable>) {
    //#region file path/watching
    // responsible for watching files to know when to sync from disk
    let dataHome = process.platform === 'win32'
      ? process.env['LOCALAPPDATA']
      : process.env['XDG_DATA_HOME']
    
    if (!dataHome) {
      if (process.platform === 'win32') throw new Error('missing %LOCALAPPDATA%')
      const home = os.homedir()
      dataHome = path.join(home, ...(process.platform === 'darwin'
        ? ['Library', 'Application Support']
        : ['.local', 'share']
      ))
    }
    
    let defaultSettingsPath = path.join(dataHome, 'socket', 'settings')
    let settingsPath = vscode.workspace.getConfiguration(EXTENSION_PREFIX)
        .get('settingsFile', defaultSettingsPath)
    //#endregion
    //#region session sync
    // responsible for keeping disk an mem in sync
    const PUBLIC_TOKEN = 'sktsec_t_--RAN5U4ivauy4w37-6aoKyYPDt5ZbaT5JBVMqiwKo_api'
    let liveSessions: Map<vscode.AuthenticationSession['accessToken'], vscode.AuthenticationSession> = new Map()
    const emitter = new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>()
    async function syncLiveSessionsFromDisk() {
        const settings_on_disk = JSON.parse(Buffer.from(
            new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.file(settingsPath))),
            'base64'
        ).toString('utf8'))
        const {
            apiKey
        } = settings_on_disk
        const sessionOnDisk: typeof liveSessions = new Map<vscode.AuthenticationSession['accessToken'], vscode.AuthenticationSession>()
        if (apiKey) {
            sessionOnDisk.set(
                apiKey,
                {
                    accessToken: apiKey,
                    id: apiKey,
                    account: {
                        id: apiKey,
                        label: `API Key for ${DIAGNOSTIC_SOURCE_STR}`
                    },
                    scopes: [],
                }
            )
        }
        let added: Array<vscode.AuthenticationSession> = []
        let changed: Array<vscode.AuthenticationSession> = []
        let removed: Array<vscode.AuthenticationSession> = []
        for (const diskSession of sessionOnDisk.values()) {
            // already have this access token in mem session
            if (liveSessions.has(diskSession.accessToken)) {
                const liveSession = liveSessions.get(diskSession.accessToken)
                liveSessions.delete(diskSession.accessToken)
                // mem has same as what is on disk
                if (JSON.stringify(liveSession) !== JSON.stringify(diskSession)) {
                    continue
                }
                changed.push(diskSession)
            } else {
                added.push(diskSession)
            }
        }
        for (const liveSessionWithoutDiskSession of liveSessions.values()) {
            removed.push(liveSessionWithoutDiskSession)
        }
        liveSessions = sessionOnDisk
        if (added.length + changed.length + removed.length > 0) {
            emitter.fire({
                added,
                changed,
                removed
            })
        }
    }
    async function syncLiveSessionsToDisk() {
        const contents = Buffer.from(
            JSON.stringify(
                Array.from(liveSessions.values(), s => ({
                    apiKey: s.accessToken
                })),
                null,
                2
            )
        ).toString('base64')
        return vscode.workspace.fs.writeFile(vscode.Uri.file(settingsPath), new TextEncoder().encode(contents))
    }
    await syncLiveSessionsFromDisk()
    //#endregion
    //#region service glue
    const service = vscode.authentication.registerAuthenticationProvider(`${EXTENSION_PREFIX}`, `${DIAGNOSTIC_SOURCE_STR}`, {
        onDidChangeSessions(fn) {
            return emitter.event(fn)
        },
        async getSessions(scopes: readonly string[] | undefined, options: vscode.AuthenticationProviderSessionOptions): Promise<vscode.AuthenticationSession[]> {
            return Array.from(liveSessions.values())
        },
        async createSession(scopes: readonly string[], options: vscode.AuthenticationProviderSessionOptions): Promise<vscode.AuthenticationSession> {
            const realLogin = `Log in to ${DIAGNOSTIC_SOURCE_STR}`
            const publicLogin = `Use public token for ${DIAGNOSTIC_SOURCE_STR}`
            const res = await vscode.window.showQuickPick([
                realLogin,
                publicLogin,
            ])
            if (!res) {
                throw new Error(`Cancelled creation of session for ${DIAGNOSTIC_SOURCE_STR}`)
            }
            let apiKey: string
            if (res === publicLogin) {
                apiKey = ''
            } else {
                let keyInfo: string
                let maybeApiKey = await vscode.window.showInputBox({
                    title: 'Socket Security API Token',
                    placeHolder: 'Leave this blank to use public demo token',
                    prompt: 'Enter your API token from https://socket.dev/',
                    async validateInput (value) {
                        if (!value) return
                        keyInfo = (await getQuota(value))!
                        if (!keyInfo) return 'Unable to validate API key'
                    }
                })
                // cancelled
                if (maybeApiKey === undefined) {
                    throw new Error(`Cancelled creation of session for ${DIAGNOSTIC_SOURCE_STR}`)
                }
                apiKey = maybeApiKey
            }
            if (apiKey === '') {
                apiKey = PUBLIC_TOKEN
            }
            const session = {
                accessToken: apiKey,
                id: apiKey,
                account: {
                    id: apiKey,
                    label: `API Key for ${DIAGNOSTIC_SOURCE_STR}`
                },
                scopes: [],
            }
            let oldSessions = Array.from(liveSessions.values())
            liveSessions = new Map([
                [apiKey, session]
            ])
            emitter.fire({
                added: [session],
                changed: [],
                removed: oldSessions
            })
            await syncLiveSessionsToDisk()
            return session
        },
        async removeSession(sessionId: string): Promise<void> {
            const session = liveSessions.get(sessionId)
            if (session) {
                emitter.fire({
                    added: [],
                    changed: [],
                    removed: [session]
                })
                await syncLiveSessionsToDisk()
            }
        }
    })
    context.subscriptions.push(service)
    vscode.commands.registerCommand(`${EXTENSION_PREFIX}.login`, () => {
        vscode.authentication.getSession(`${EXTENSION_PREFIX}`, [], {
            createIfNone: true,
        })
    })
    //#endregion
    return {

    }
}
